package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
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

type OutboundMessage struct {
	ChatID    int64                  `json:"chatId"`
	AppID     string                 `json:"appId"`
	ErrorHash string                 `json:"errorHash"`
	Count     int                    `json:"count"`
	Action    string                 `json:"action"`
	Log       map[string]interface{} `json:"log"`
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

	go consumeOutbound(bot, rdb)

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
		default:
			msg := tgbotapi.NewMessage(chatID, "Unknown command. Available commands: /link <token>, /subscribe, /unsubscribe, /status")
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

	// Add to subscriptions
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

func consumeOutbound(bot *tgbotapi.BotAPI, rdb *redis.Client) {
	for {
		res, err := rdb.BRPop(ctx, 0, "telegram_outbound").Result()
		if err != nil {
			time.Sleep(1 * time.Second)
			continue
		}

		var outMsg OutboundMessage
		json.Unmarshal([]byte(res[1]), &outMsg)

		var text string
		if outMsg.Action == "new" {
			text = fmt.Sprintf("🚨 NEW CRITICAL ERROR 🚨\nApp: %s\nMessage: %v", outMsg.AppID, outMsg.Log["Message"])
		} else if outMsg.Action == "threshold" {
			text = fmt.Sprintf("⚠️ HIGH ERROR RATE ⚠️\nApp: %s\nThis error occurred %d times in the last minute!\nMessage: %v", outMsg.AppID, outMsg.Count, outMsg.Log["Message"])
		} else {
			text = fmt.Sprintf("🚨 ALERT 🚨\nApp: %s\nMessage: %v", outMsg.AppID, outMsg.Log["Message"])
		}

		msg := tgbotapi.NewMessage(outMsg.ChatID, text)
		bot.Send(msg)
	}
}
