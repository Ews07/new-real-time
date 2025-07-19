package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

var (
	clients     = make(map[string]*Client)       // key = user UUID
	broadcast   = make(chan Message)             // channel for incoming messages
	onlineUsers = make(map[string]*UserPresence) // key = userUUID
)

type Client struct {
	Conn     *websocket.Conn
	UserUUID string
	Send     chan []byte
}

type Message struct {
	From    string `json:"from"`
	To      string `json:"to"`
	Content string `json:"content"`
	SentAt  string `json:"sent_at"`
}

type UserPresence struct {
	UserUUID    string
	LastMessage string // preview or timestamp
	IsOnline    bool
}

func handleMessages() {
	for {
		msg := <-broadcast

		// Save/update last message in memory
		if u, ok := onlineUsers[msg.To]; ok {
			u.LastMessage = msg.Content
		}

		// If receiver is online, send the message directly
		if client, ok := clients[msg.To]; ok {
			data, _ := json.Marshal(msg)
			client.Send <- data
		}

		// Optionally send back to sender as confirmation
		if sender, ok := clients[msg.From]; ok {
			data, _ := json.Marshal(msg)
			sender.Send <- data
		}

		// Broadcast updated online user list to all clients
		sendOnlineUsersToAll()

	}
}

func sendOnlineUsersToAll() {
	users := []UserPresence{}
	for _, u := range onlineUsers {
		users = append(users, *u)
	}

	data := map[string]interface{}{
		"type":  "user_list",
		"users": users,
	}

	encoded, _ := json.Marshal(data)

	for _, client := range clients {
		client.Send <- encoded
	}
}

func readPump(db *sql.DB, client *Client) {
	defer func() {
		client.Conn.Close()
		delete(clients, client.UserUUID)
		if u, ok := onlineUsers[client.UserUUID]; ok {
			u.IsOnline = false
		}
	}()

	for {
		var msg Message
		err := client.Conn.ReadJSON(&msg)
		if err != nil {
			log.Println("read error:", err)
			break
		}

		msg.From = client.UserUUID
		msg.SentAt = time.Now().Format(time.RFC3339)

		SaveMessage(db, uuid.New().String(), msg.From, msg.To, msg.Content, time.Now())

		broadcast <- msg
	}
}

func writePump(client *Client) {
	for {
		msg, ok := <-client.Send
		if !ok {
			return
		}
		client.Conn.WriteMessage(websocket.TextMessage, msg)
	}
}
