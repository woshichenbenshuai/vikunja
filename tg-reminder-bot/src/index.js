const text = {
  unauthorized: '\u8fd9\u4e2a\u804a\u5929\u672a\u6388\u6743',
  unknownAction: '\u672a\u77e5\u64cd\u4f5c',
  doneOk: '\u5df2\u5b8c\u6210\u7b7e\u5230',
  doneFail: '\u5b8c\u6210\u5931\u8d25\uff0c\u8bf7\u67e5\u770b Bot \u65e5\u5fd7',
  doneTitle: '\u5df2\u5b8c\u6210\u7b7e\u5230',
  taskLink: '\u4efb\u52a1\u94fe\u63a5',
  nextDue: '\u4e0b\u6b21\u4fdd\u6d3b\u65f6\u95f4',
  noDue: '\u672a\u8bbe\u7f6e',
  noTasks: '\u6ca1\u6709\u672a\u5b8c\u6210\u4efb\u52a1',
  listTitle: '\u4efb\u52a1\u5217\u8868',
  commandMissing: '\u8bf7\u4f7f\u7528\uff1a/keepalive <\u4efb\u52a1ID\u6216\u4efb\u52a1\u540d>',
  taskNotFound: '\u6ca1\u627e\u5230\u5339\u914d\u7684\u672a\u5b8c\u6210\u4efb\u52a1',
  multipleMatches: '\u627e\u5230\u591a\u4e2a\u5339\u914d\u4efb\u52a1\uff0c\u8bf7\u7528 ID \u7b7e\u5230',
  help: [
    'Vikunja \u4fdd\u6d3b\u673a\u5668\u4eba\u5df2\u542f\u7528\u3002',
    '',
    '\u547d\u4ee4\uff1a',
    '/list - \u67e5\u8be2\u5168\u90e8\u672a\u5b8c\u6210\u4efb\u52a1\u548c\u4e0b\u6b21\u4fdd\u6d3b\u65f6\u95f4',
    '/keepalive <\u4efb\u52a1ID\u6216\u4efb\u52a1\u540d> - \u5b8c\u6210\u7b7e\u5230',
    '',
    '\u8bf4\u660e\uff1aVikunja \u540e\u7aef\u4f1a\u6309\u4efb\u52a1\u81ea\u8eab\u7684\u63d0\u9192\u65f6\u95f4\u4e3b\u52a8\u63a8\u9001 TG\u3002',
    '',
    '\u793a\u4f8b\uff1a',
    '/keepalive 12',
    '/keepalive gv\u4fdd\u6d3b',
  ].join('\n'),
}

const config = {
  telegramToken: requiredEnv('TELEGRAM_BOT_TOKEN'),
  chatIds: requiredEnv('TELEGRAM_CHAT_IDS').split(',').map(v => v.trim()).filter(Boolean),
  vikunjaUrl: normalizeBaseUrl(requiredEnv('VIKUNJA_API_URL')),
  vikunjaToken: requiredEnv('VIKUNJA_API_TOKEN'),
  publicUrl: normalizePublicUrl(process.env.VIKUNJA_PUBLIC_URL || requiredEnv('VIKUNJA_API_URL')),
  timezone: process.env.TZ || 'Asia/Shanghai',
}

const telegramBaseUrl = `https://api.telegram.org/bot${config.telegramToken}`
let updateOffset = 0
let pollingTelegram = false

log(`Starting Vikunja Telegram command bot. chats=${config.chatIds.join(',')}`)

await pollTelegramUpdates()
setInterval(() => void pollTelegramUpdates(), 1500)

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function normalizeBaseUrl(url) {
  return url.replace(/\/+$/, '')
}

function normalizePublicUrl(url) {
  return url.replace(/\/+$/, '') + '/'
}

async function getOpenTasks(search = '') {
  return getTasks({
    filter: 'done = false',
    sort_by: 'due_date',
    order_by: 'asc',
    per_page: '100',
    ...(search ? { s: search } : {}),
  })
}

async function getTasks(query) {
  const params = new URLSearchParams(query)
  const result = await vikunjaJson(`/api/v1/tasks?${params.toString()}`)
  return Array.isArray(result) ? result : result?.items || []
}

async function pollTelegramUpdates() {
  if (pollingTelegram) return
  pollingTelegram = true
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
  } finally {
    pollingTelegram = false
  }
}

async function handleCallback(callback) {
  const chatId = String(callback.message?.chat?.id || '')
  if (!isAllowedChat(chatId)) {
    await answerCallback(callback.id, text.unauthorized)
    return
  }

  const [action, taskIdRaw] = String(callback.data || '').split(':')
  const taskId = Number(taskIdRaw)
  if (action !== 'done' || !Number.isInteger(taskId) || taskId <= 0) {
    await answerCallback(callback.id, text.unknownAction)
    return
  }

  try {
    const updatedTask = await markTaskDone(taskId)
    await answerCallback(callback.id, text.doneOk)
    await telegramJson('editMessageText', {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      text: formatDoneMessage(updatedTask),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
  } catch (err) {
    logError(`Failed to mark task ${taskId} done`, err)
    await answerCallback(callback.id, text.doneFail)
  }
}

async function handleMessage(message) {
  const chatId = String(message.chat?.id || '')
  if (!isAllowedChat(chatId)) return

  const raw = String(message.text || '').trim()
  const command = normalizeCommand(raw)

  try {
    if (command === '/start' || command === '/help') {
      await sendPlainMessage(chatId, text.help)
      return
    }

    if (command === '/list') {
      await handleListCommand(chatId)
      return
    }

    if (command.startsWith('/keepalive')) {
      await handleKeepaliveCommand(chatId, raw.replace(/^\/keepalive(?:@\w+)?\s*/i, '').trim())
    }
  } catch (err) {
    logError(`Failed to handle command ${raw}`, err)
    await sendPlainMessage(chatId, text.doneFail)
  }
}

function normalizeCommand(raw) {
  const first = raw.split(/\s+/, 1)[0].toLowerCase()
  return first.replace(/@\w+$/, '')
}

async function handleListCommand(chatId) {
  const tasks = await getOpenTasks()
  if (tasks.length === 0) {
    await sendPlainMessage(chatId, text.noTasks)
    return
  }

  const lines = [`<b>${text.listTitle}</b>`]
  for (const task of tasks.slice(0, 50)) {
    lines.push(formatTaskListLine(task))
  }
  if (tasks.length > 50) {
    lines.push(`... ${tasks.length - 50} more`)
  }

  await telegramJson('sendMessage', {
    chat_id: chatId,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  })
}

function formatTaskListLine(task) {
  const dueDate = parseDate(task.due_date)
  const due = dueDate ? formatInTimezone(dueDate) : text.noDue
  return `#${task.id} ${escapeHtml(task.title)}\n${text.nextDue}: ${escapeHtml(due)}`
}

async function handleKeepaliveCommand(chatId, query) {
  if (!query) {
    await sendPlainMessage(chatId, text.commandMissing)
    return
  }

  const task = await findTask(query)
  if (!task) {
    await sendPlainMessage(chatId, text.taskNotFound)
    return
  }

  if (Array.isArray(task)) {
    const lines = [text.multipleMatches, '']
    for (const item of task.slice(0, 10)) {
      lines.push(`#${item.id} ${item.title}`)
    }
    await sendPlainMessage(chatId, lines.join('\n'))
    return
  }

  const updatedTask = await markTaskDone(task.id)
  await telegramJson('sendMessage', {
    chat_id: chatId,
    text: formatDoneMessage(updatedTask),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  })
}

async function findTask(query) {
  const taskId = Number(query)
  if (Number.isInteger(taskId) && taskId > 0) {
    const task = await vikunjaJson(`/api/v1/tasks/${taskId}`)
    return task.done ? null : task
  }

  const tasks = await getOpenTasks(query)
  const normalizedQuery = query.trim().toLowerCase()
  const exact = tasks.filter(task => String(task.title || '').trim().toLowerCase() === normalizedQuery)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return exact

  const partial = tasks.filter(task => String(task.title || '').toLowerCase().includes(normalizedQuery))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) return partial

  return null
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
    `<b>${text.doneTitle}</b>`,
    '',
    `<b>${escapeHtml(task.title)}</b>`,
  ]

  if (dueDate && !task.done) {
    lines.push(`${text.nextDue}: ${escapeHtml(formatInTimezone(dueDate))}`)
  }

  lines.push(`${text.taskLink}: ${escapeHtml(taskUrl(task.id))}`)
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
    const body = await response.text()
    throw new Error(`Vikunja API ${response.status} ${response.statusText}: ${body}`)
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

async function sendPlainMessage(chatId, message) {
  await telegramJson('sendMessage', {
    chat_id: chatId,
    text: message,
    disable_web_page_preview: true,
  })
}

async function answerCallback(callbackQueryId, message) {
  await telegramJson('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: message,
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

function taskUrl(taskId) {
  return `${config.publicUrl}tasks/${taskId}`
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`)
}

function logError(message, err) {
  console.error(`${new Date().toISOString()} ${message}:`, err?.stack || err)
}
