package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/redis/go-redis/v9"
)

var ctx = context.Background()

type LinkSession struct {
	UserID string   `json:"user_id"`
	Role   string   `json:"role"`
	AppIDs []string `json:"app_ids"`
}

type UserSession struct {
	UserID     string   `json:"user_id"`
	Role       string   `json:"role"`
	AppIDs     []string `json:"app_ids"`
	Subscribed bool     `json:"subscribed"`
}

func main() {
	botToken := os.Getenv("TELEGRAM_BOT_TOKEN")
	if botToken == "" {
		log.Fatal("TELEGRAM_BOT_TOKEN is required")
	}

	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://redis:6379"
	}
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		opts = &redis.Options{Addr: "localhost:6379"}
	}
	rdb := redis.NewClient(opts)

	bot, err := tgbotapi.NewBotAPI(botToken)
	if err != nil {
		log.Panic(err)
	}

	log.Printf("Authorized on account %s", bot.Self.UserName)

	commands := []tgbotapi.BotCommand{
		{Command: "help", Description: "Show available commands"},
		{Command: "link", Description: "Link your account: /link <token>"},
		{Command: "subscribe", Description: "Enable notifications"},
		{Command: "unsubscribe", Description: "Disable notifications"},
		{Command: "status", Description: "Check your link status and settings"},
	}
	if _, err := bot.Request(tgbotapi.NewSetMyCommands(commands...)); err != nil {
		log.Printf("Failed to set commands: %v", err)
	}

	go consumeDirtyIncidents(bot, rdb)

	u := tgbotapi.NewUpdate(0)
	u.Timeout = 60

	updates := bot.GetUpdatesChan(u)

	for update := range updates {
		if update.Message == nil || !update.Message.IsCommand() {
			continue
		}

		chatID := update.Message.Chat.ID
		cmd := update.Message.Command()
		args := update.Message.CommandArguments()

		switch cmd {
		case "link":
			handleLink(bot, rdb, chatID, args)
		case "subscribe":
			handleSubscribe(bot, rdb, chatID, true)
		case "unsubscribe":
			handleSubscribe(bot, rdb, chatID, false)
		case "status":
			handleStatus(bot, rdb, chatID)
		case "help":
			msg := tgbotapi.NewMessage(chatID, "Available commands:\n/help - Show available commands\n/link <token> - Link your account\n/subscribe - Enable notifications\n/unsubscribe - Disable notifications\n/status - Check your link status and settings")
			bot.Send(msg)
		default:
			msg := tgbotapi.NewMessage(chatID, "Unknown command. Available commands: /help, /link <token>, /subscribe, /unsubscribe, /status")
			bot.Send(msg)
		}
	}
}

func handleLink(bot *tgbotapi.BotAPI, rdb *redis.Client, chatID int64, token string) {
	if token == "" {
		bot.Send(tgbotapi.NewMessage(chatID, "Please provide a token: /link <token>"))
		return
	}

	val, err := rdb.Get(ctx, "link_token:"+token).Result()
	if err == redis.Nil {
		bot.Send(tgbotapi.NewMessage(chatID, "Invalid or expired token."))
		return
	} else if err != nil {
		bot.Send(tgbotapi.NewMessage(chatID, "Error checking token."))
		return
	}

	var session LinkSession
	json.Unmarshal([]byte(val), &session)

	userSession := UserSession{
		UserID:     session.UserID,
		Role:       session.Role,
		AppIDs:     session.AppIDs,
		Subscribed: true,
	}
	userJSON, _ := json.Marshal(userSession)
	rdb.Set(ctx, fmt.Sprintf("user:%d", chatID), userJSON, 0)

	rdb.Del(ctx, "link_token:"+token)

	if session.Role == "admin" {
		rdb.SAdd(ctx, "users:admins", chatID)
	} else {
		for _, app := range session.AppIDs {
			rdb.SAdd(ctx, "app:"+app+":subscribers", chatID)
		}
	}

	bot.Send(tgbotapi.NewMessage(chatID, fmt.Sprintf("Account linked successfully! Welcome %s (%s). Notifications enabled.", session.UserID, session.Role)))
}

func handleSubscribe(bot *tgbotapi.BotAPI, rdb *redis.Client, chatID int64, subscribe bool) {
	val, err := rdb.Get(ctx, fmt.Sprintf("user:%d", chatID)).Result()
	if err == redis.Nil {
		bot.Send(tgbotapi.NewMessage(chatID, "You must /link your account first."))
		return
	}

	var userSession UserSession
	json.Unmarshal([]byte(val), &userSession)

	userSession.Subscribed = subscribe
	userJSON, _ := json.Marshal(userSession)
	rdb.Set(ctx, fmt.Sprintf("user:%d", chatID), userJSON, 0)

	if subscribe {
		if userSession.Role == "admin" {
			rdb.SAdd(ctx, "users:admins", chatID)
		} else {
			for _, app := range userSession.AppIDs {
				rdb.SAdd(ctx, "app:"+app+":subscribers", chatID)
			}
		}
		bot.Send(tgbotapi.NewMessage(chatID, "Notifications enabled."))
	} else {
		if userSession.Role == "admin" {
			rdb.SRem(ctx, "users:admins", chatID)
		} else {
			for _, app := range userSession.AppIDs {
				rdb.SRem(ctx, "app:"+app+":subscribers", chatID)
			}
		}
		bot.Send(tgbotapi.NewMessage(chatID, "Notifications disabled."))
	}
}

func handleStatus(bot *tgbotapi.BotAPI, rdb *redis.Client, chatID int64) {
	val, err := rdb.Get(ctx, fmt.Sprintf("user:%d", chatID)).Result()
	if err == redis.Nil {
		bot.Send(tgbotapi.NewMessage(chatID, "Account is not linked. Use /link <token>."))
		return
	}

	var userSession UserSession
	json.Unmarshal([]byte(val), &userSession)

	apps := "*"
	if userSession.Role != "admin" {
		apps = strings.Join(userSession.AppIDs, ", ")
		if apps == "" {
			apps = "None"
		}
	}

	status := "Disabled"
	if userSession.Subscribed {
		status = "Enabled"
	}

	msg := fmt.Sprintf("Status:\nUser: %s\nRole: %s\nApps: %s\nNotifications: %s", userSession.UserID, userSession.Role, apps, status)
	bot.Send(tgbotapi.NewMessage(chatID, msg))
}

func consumeDirtyIncidents(bot *tgbotapi.BotAPI, rdb *redis.Client) {
	for {
		now := time.Now().Unix()
		// BZPOPMIN telegram:dirty_incidents 0
		res, err := rdb.BZPopMin(ctx, 5*time.Second, "telegram:dirty_incidents").Result()
		if err != nil {
			// Timeout or error
			continue
		}

		// res.Member is the incident key, res.Score is the timestamp
		incKey := res.Member.(string)
		score := res.Score

		// If score is in the future, wait
		if int64(score) > now {
			diff := int64(score) - now
			if diff > 0 {
				rdb.ZAdd(ctx, "telegram:dirty_incidents", redis.Z{Score: float64(score), Member: incKey})
				time.Sleep(1 * time.Second)
				continue
			}
		}

		minEditInterval := int64(5) // seconds
		minEditIntervalStr, _ := rdb.Get(ctx, "config:telegram.min_edit_interval_seconds").Result()
		if minEditIntervalStr != "" {
			parsedInterval, err := strconv.ParseInt(strings.Trim(minEditIntervalStr, "\""), 10, 64)
			if err == nil {
				minEditInterval = parsedInterval
			}
		}

		telegramEnabledStr, _ := rdb.Get(ctx, "config:telegram.enabled").Result()
		telegramEnabled := true
		if telegramEnabledStr != "" {
			if telegramEnabledStr == "false" || telegramEnabledStr == "\"false\"" {
				telegramEnabled = false
			}
		}

		// Read incident details
		inc, err := rdb.HGetAll(ctx, incKey).Result()
		if err != nil || len(inc) == 0 {
			continue // Expired or deleted
		}

		countStr := inc["count"]
		count, _ := strconv.Atoi(countStr)
		if count == 0 {
			continue
		}

		lastEditAtStr := inc["last_edit_at"]
		lastEditAt, _ := strconv.ParseInt(lastEditAtStr, 10, 64)

		lastNotifiedStr := inc["last_notified_count"]
		lastNotified, _ := strconv.Atoi(lastNotifiedStr)

		messageStr := inc["message"]
		firstSeenStr := inc["first_seen"]
		lastSeenStr := inc["last_seen"]
		
		// Parse first seen and last seen
		firstSeen, _ := strconv.ParseInt(firstSeenStr, 10, 64)
		lastSeen, _ := strconv.ParseInt(lastSeenStr, 10, 64)
		firstSeenTime := time.Unix(firstSeen, 0).Format("15:04:05")
		lastSeenTime := time.Unix(lastSeen, 0).Format("15:04:05")
		severity := inc["severity"]
		if severity == "" {
			severity = "CRITICAL"
		}

		// Extract app from incident key: incident:{app}:{hash}
		parts := strings.Split(incKey, ":")
		if len(parts) < 3 {
			continue
		}
		appID := parts[1]

		telegramMsgIDsStr := inc["telegram_message_ids"]
		var telegramMsgIDs map[string]int
		if telegramMsgIDsStr != "" {
			json.Unmarshal([]byte(telegramMsgIDsStr), &telegramMsgIDs)
		} else {
			telegramMsgIDs = make(map[string]int)
		}

		realertThresholdStr, _ := rdb.Get(ctx, "config:alert.realert_threshold").Result()
		realertThreshold := 100
		if realertThresholdStr != "" {
			if rt, err := strconv.Atoi(strings.Trim(realertThresholdStr, "\"")); err == nil {
				realertThreshold = rt
			}
		}

		// Should we notify?
		needsUpdate := false
		if lastNotified == 0 {
			needsUpdate = true
		} else if count > lastNotified {
			if count-lastNotified >= realertThreshold || now-lastEditAt >= minEditInterval {
				needsUpdate = true
			} else {
				// Requeue for later
				rdb.ZAdd(ctx, "telegram:dirty_incidents", redis.Z{Score: float64(lastEditAt + minEditInterval), Member: incKey})
				continue
			}
		}

		if !needsUpdate {
			continue
		}

		admins, _ := rdb.SMembers(ctx, "users:admins").Result()
		engineers, _ := rdb.SMembers(ctx, "app:"+appID+":subscribers").Result()
		
		allChats := make(map[string]bool)
		for _, a := range admins {
			allChats[a] = true
		}
		for _, e := range engineers {
			allChats[e] = true
		}

		text := fmt.Sprintf("🚨 %s\nApp: %s\nMessage: %s\nCount: %d\nFirst seen: %s\nLast seen: %s\nStatus: Active", severity, appID, messageStr, count, firstSeenTime, lastSeenTime)

		updatedMsgIDs := false
		if telegramEnabled {
			for chatIDStr := range allChats {
				chatID, _ := strconv.ParseInt(chatIDStr, 10, 64)
				
				// Per-chat rate limiting using Redis
				rateLimitKey := fmt.Sprintf("telegram:rate_limit:%s", chatIDStr)
				ok, _ := rdb.SetNX(ctx, rateLimitKey, "1", 1*time.Second).Result()
				if !ok {
					continue // Skip if sent too recently
				}
				
				msgID, exists := telegramMsgIDs[chatIDStr]
				if !exists {
					// Send new message
					msg := tgbotapi.NewMessage(chatID, text)
					sent, err := bot.Send(msg)
					if err == nil {
						telegramMsgIDs[chatIDStr] = sent.MessageID
						updatedMsgIDs = true
					}
				} else {
					// Edit existing message
					editMsg := tgbotapi.NewEditMessageText(chatID, msgID, text)
					_, err := bot.Send(editMsg)
					if err != nil {
						log.Printf("Failed to edit message: %v", err)
						// if message not found, we could resend, but let's just ignore for now
					}
				}
			}
		}

		// Save state
		pipeline := rdb.Pipeline()
		pipeline.HSet(ctx, incKey, "last_notified_count", count)
		pipeline.HSet(ctx, incKey, "last_edit_at", now)
		if updatedMsgIDs {
			idsJSON, _ := json.Marshal(telegramMsgIDs)
			pipeline.HSet(ctx, incKey, "telegram_message_ids", string(idsJSON))
		}
		pipeline.Exec(ctx)
	}
}
