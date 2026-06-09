import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const config = {
  telegramToken: requiredEnv('TELEGRAM_BOT_TOKEN'),
  chatIds: requiredEnv('TELEGRAM_CHAT_IDS').split(',').map(v => v.trim()).filter(Boolean),
  vikunjaUrl: normalizeBaseUrl(requiredEnv('VIKUNJA_API_URL')),
  vikunjaToken: requiredEnv('VIKUNJA_API_TOKEN'),
  publicUrl: normalizePublicUrl(process.env.VIKUNJA_PUBLIC_URL || requiredEnv('VIKUNJA_API_URL')),
  lookaheadDays: numberEnv('TG_REMINDER_LOOKAHEAD_DAYS', 3),
  pollSeconds: numberEnv('TG_REMINDER_POLL_SECONDS', 300),
  timezone: process.env.TZ || 'Asia/Shanghai',
  statePath: process.env.TG_REMINDER_STATE_PATH || '/data/state.json',
}

const telegramBaseUrl = `https://api.telegram.org/bot${config.telegramToken}`
let updateOffset = 0
let state = await loadState(config.statePath)

log(`Starting Vikunja Telegram reminder bot. lookahead=${config.lookaheadDays}d poll=${config.pollSeconds}s chats=${config.chatIds.join(',')}`)

await pollTelegramUpdates()
await sendDueSoonReminders()
setInterval(() => void pollTelegramUpdates(), 1500)
setInterval(() => void sendDueSoonReminders(), config.pollSeconds * 1000)

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function numberEnv(name, fallback) {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`)
  }
  return value
}

function normalizeBaseUrl(url) {
  return url.replace(/\/+$/, '')
}

function normalizePublicUrl(url) {
  return url.replace(/\/+$/, '') + '/'
}

async function loadState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    return { sent: {} }
  }
}

async function saveState() {
  await mkdir(dirname(config.statePath), { recursive: true })
  await writeFile(config.statePath, JSON.stringify(state, null, 2))
}

async function sendDueSoonReminders() {
  try {
    const tasks = await getDueSoonTasks()
    for (const task of tasks) {
      const dueDate = parseDate(task.due_date)
      if (!dueDate) continue

      const key = `${task.id}|${dueDate.toISOString()}`
      if (state.sent[key]?.sentAt) continue

      await sendTaskReminder(task, dueDate, key)
      state.sent[key] = { sentAt: new Date().toISOString(), taskId: task.id, dueDate: dueDate.toISOString() }
      await saveState()
    }
    pruneSentState()
  } catch (err) {
    logError('Failed to send due soon reminders', err)
  }
}

async function getDueSoonTasks() {
  const now = new Date()
  const until = new Date(now.getTime() + config.lookaheadDays * 24 * 60 * 60 * 1000)
  const filter = `done = false && due_date <= '${until.toISOString()}'`
  const params = new URLSearchParams({
    filter,
    sort_by: 'due_date',
    order_by: 'asc',
    per_page: '100',
  })

  return vikunjaJson(`/api/v1/tasks?${params.toString()}`)
}

async function sendTaskReminder(task, dueDate, stateKey) {
  const text = formatTaskMessage(task, dueDate)
  const keyboard = {
    inline_keyboard: [[
      { text: '完成签到', callback_data: `done:${task.id}` },
      { text: '打开任务', url: `${config.publicUrl}tasks/${task.id}` },
    ]],
  }

  for (const chatId of config.chatIds) {
    await telegramJson('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_web_page_preview: true,
    })
  }
  log(`Sent reminder task=${task.id} title=${task.title} key=${stateKey}`)
}

function formatTaskMessage(task, dueDate) {
  const project = task.project_id ? `#${task.project_id}` : '-'
  return [
    '⏰ <b>任务快到期</b>',
    '',
    `<b>${escapeHtml(task.title)}</b>`,
    `到期：${escapeHtml(formatInTimezone(dueDate))}`,
    `项目：${escapeHtml(project)}`,
    '',
    `任务链接：${escapeHtml(config.publicUrl)}tasks/${task.id}`,
  ].join('\n')
}

async function pollTelegramUpdates() {
  try {
    const result = await telegramJson('getUpdates', {
      offset: updateOffset,
      timeout: 1,
      allowed_updates: ['callback_query', 'message'],
    })

    for (const update of result) {
      updateOffset = Math.max(updateOffset, update.update_id + 1)
      if (update.callback_query) {
        await handleCallback(update.callback_query)
      } else if (update.message?.text) {
        await handleMessage(update.message)
      }
    }
  } catch (err) {
    logError('Failed to poll Telegram updates', err)
  }
}

async function handleCallback(callback) {
  const chatId = String(callback.message?.chat?.id || '')
  if (!isAllowedChat(chatId)) {
    await answerCallback(callback.id, '这个聊天未授权')
    return
  }

  const [action, taskIdRaw] = String(callback.data || '').split(':')
  const taskId = Number(taskIdRaw)
  if (action !== 'done' || !Number.isInteger(taskId) || taskId <= 0) {
    await answerCallback(callback.id, '未知操作')
    return
  }

  try {
    const updatedTask = await markTaskDone(taskId)
    await answerCallback(callback.id, '已完成签到')
    await telegramJson('editMessageText', {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      text: formatDoneMessage(updatedTask),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
  } catch (err) {
    logError(`Failed to mark task ${taskId} done`, err)
    await answerCallback(callback.id, '完成失败，请看 Bot 日志')
  }
}

async function handleMessage(message) {
  const chatId = String(message.chat?.id || '')
  if (!isAllowedChat(chatId)) return

  const text = String(message.text || '').trim()
  if (text === '/start' || text === '/help') {
    await telegramJson('sendMessage', {
      chat_id: chatId,
      text: 'Vikunja 保活提醒机器人已启用。\n\n会自动推送快到期任务，点击“完成签到”即可完成任务并触发重复规则。',
    })
  }
}

function isAllowedChat(chatId) {
  return config.chatIds.includes(String(chatId))
}

async function markTaskDone(taskId) {
  const task = await vikunjaJson(`/api/v1/tasks/${taskId}`)
  const payload = { ...task, done: true }
  return vikunjaJson(`/api/v1/tasks/${taskId}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

function formatDoneMessage(task) {
  const dueDate = parseDate(task.due_date)
  const lines = [
    '✅ <b>已完成签到</b>',
    '',
    `<b>${escapeHtml(task.title)}</b>`,
  ]

  if (dueDate && !task.done) {
    lines.push(`下一次到期：${escapeHtml(formatInTimezone(dueDate))}`)
  }

  lines.push(`任务链接：${escapeHtml(config.publicUrl)}tasks/${task.id}`)
  return lines.join('\n')
}

async function vikunjaJson(path, options = {}) {
  const response = await fetch(`${config.vikunjaUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.vikunjaToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Vikunja API ${response.status} ${response.statusText}: ${text}`)
  }

  if (response.status === 204) return null
  return response.json()
}

async function telegramJson(method, payload) {
  const response = await fetch(`${telegramBaseUrl}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json()
  if (!response.ok || !body.ok) {
    throw new Error(`Telegram API ${method} failed: ${JSON.stringify(body)}`)
  }
  return body.result
}

async function answerCallback(callbackQueryId, text) {
  await telegramJson('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  })
}

function parseDate(value) {
  if (!value || value === '0001-01-01T00:00:00Z') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatInTimezone(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: config.timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function pruneSentState() {
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
  let changed = false
  for (const [key, value] of Object.entries(state.sent)) {
    if (Date.parse(value.sentAt) < cutoff) {
      delete state.sent[key]
      changed = true
    }
  }
  if (changed) void saveState()
}

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`)
}

function logError(message, err) {
  console.error(`${new Date().toISOString()} ${message}:`, err?.stack || err)
}
