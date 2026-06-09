// Vikunja is a to-do list application to facilitate your life.
// Copyright 2018-present Vikunja and contributors. All rights reserved.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package models

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"os"
	"strings"
	"time"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/log"
)

type telegramInlineKeyboard struct {
	InlineKeyboard [][]telegramInlineButton `json:"inline_keyboard"`
}

type telegramInlineButton struct {
	Text         string `json:"text"`
	URL          string `json:"url,omitempty"`
	CallbackData string `json:"callback_data,omitempty"`
}

type telegramSendMessageRequest struct {
	ChatID                string                 `json:"chat_id"`
	Text                  string                 `json:"text"`
	ParseMode             string                 `json:"parse_mode"`
	ReplyMarkup           telegramInlineKeyboard `json:"reply_markup"`
	DisableWebPagePreview bool                   `json:"disable_web_page_preview"`
}

type telegramAPIResponse struct {
	OK          bool   `json:"ok"`
	Description string `json:"description"`
}

func telegramReminderConfig() (token string, chatIDs []string, enabled bool) {
	token = strings.TrimSpace(os.Getenv("TELEGRAM_BOT_TOKEN"))
	chatIDsRaw := strings.TrimSpace(os.Getenv("TELEGRAM_CHAT_IDS"))
	if token == "" || chatIDsRaw == "" {
		return "", nil, false
	}

	for _, chatID := range strings.Split(chatIDsRaw, ",") {
		chatID = strings.TrimSpace(chatID)
		if chatID != "" {
			chatIDs = append(chatIDs, chatID)
		}
	}

	return token, chatIDs, len(chatIDs) > 0
}

func sendTelegramTaskReminder(n *ReminderDueNotification) error {
	token, chatIDs, enabled := telegramReminderConfig()
	if !enabled {
		return nil
	}

	message := formatTelegramReminderMessage(n)
	keyboard := telegramInlineKeyboard{InlineKeyboard: [][]telegramInlineButton{{
		{Text: "完成签到", CallbackData: fmt.Sprintf("done:%d", n.Task.ID)},
		{Text: "打开任务", URL: taskPublicURL(n.Task.ID)},
	}}}

	for _, chatID := range chatIDs {
		if err := sendTelegramMessage(token, chatID, message, keyboard); err != nil {
			return err
		}
	}

	log.Debugf("[Telegram Reminder] Sent reminder for task %d to %d chat(s)", n.Task.ID, len(chatIDs))
	return nil
}

func formatTelegramReminderMessage(n *ReminderDueNotification) string {
	project := "-"
	if n.Project != nil && n.Project.Title != "" {
		project = n.Project.Title
	} else if n.Task.ProjectID > 0 {
		project = fmt.Sprintf("#%d", n.Task.ProjectID)
	}

	due := "未设置"
	if !n.Task.DueDate.IsZero() {
		due = formatTelegramTime(n.Task.DueDate, n.User.Timezone)
	}

	reminder := ""
	if n.TaskReminder != nil && !n.TaskReminder.Reminder.IsZero() {
		reminder = "\n提醒：" + html.EscapeString(formatTelegramTime(n.TaskReminder.Reminder, n.User.Timezone))
	}

	return strings.Join([]string{
		"<b>任务提醒</b>",
		"",
		"<b>" + html.EscapeString(n.Task.Title) + "</b>",
		"到期：" + html.EscapeString(due) + reminder,
		"项目：" + html.EscapeString(project),
		"",
		"任务链接：" + html.EscapeString(taskPublicURL(n.Task.ID)),
	}, "\n")
}

func formatTelegramTime(t time.Time, timezone string) string {
	if timezone == "" {
		timezone = config.GetTimeZone().String()
	}

	loc, err := time.LoadLocation(timezone)
	if err != nil {
		loc = config.GetTimeZone()
	}

	return t.In(loc).Format("2006-01-02 15:04")
}

func taskPublicURL(taskID int64) string {
	return strings.TrimRight(config.ServicePublicURL.GetString(), "/") + fmt.Sprintf("/tasks/%d", taskID)
}

func sendTelegramMessage(token string, chatID string, message string, keyboard telegramInlineKeyboard) error {
	payload := telegramSendMessageRequest{
		ChatID:                chatID,
		Text:                  message,
		ParseMode:             "HTML",
		ReplyMarkup:           keyboard,
		DisableWebPagePreview: true,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post("https://api.telegram.org/bot"+token+"/sendMessage", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var result telegramAPIResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return err
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !result.OK {
		return fmt.Errorf("telegram sendMessage failed: status=%d description=%s", resp.StatusCode, result.Description)
	}

	return nil
}
