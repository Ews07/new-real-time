package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"sort"
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
	UserUUID        string    `json:"user_uuid"`
	Nickname        string    `json:"nickname"`
	LastMessage     string    `json:"last_message"`      // preview of last message content
	LastMessageTime time.Time `json:"last_message_time"` // timestamp for sorting
	IsOnline        bool      `json:"is_online"`
}

type MessageBroadcast struct {
	From         string `json:"from"`
	To           string `json:"to"`
	Content      string `json:"content"`
	SentAt       string `json:"sent_at"`
	FromNickname string `json:"from_nickname"`
}

func handleMessages() {
	for {
		msg := <-broadcast

		// Look up sender's nickname from our in-memory store.
		fromNickname := "Unknown"
		if sender, ok := onlineUsers[msg.From]; ok {
			fromNickname = sender.Nickname
		}

		// Create the message payload that includes the nickname.
		broadcastMsg := MessageBroadcast{
			From:         msg.From,
			To:           msg.To,
			Content:      msg.Content,
			SentAt:       msg.SentAt,
			FromNickname: fromNickname,
		}

		// Marshal the new struct for broadcasting.
		data, err := json.Marshal(broadcastMsg)
		if err != nil {
			log.Println("json marshal error:", err)
			continue
		}

		// If receiver is online, send the message directly.
		if client, ok := clients[msg.To]; ok {
			client.Send <- data
		}

		// Send back to sender as confirmation.
		if sender, ok := clients[msg.From]; ok {
			sender.Send <- data
		}

		// Parse the sent time for sorting
		sentTime, err := time.Parse(time.RFC3339, msg.SentAt)
		if err != nil {
			sentTime = time.Now()
		}

		// Update LastMessage and LastMessageTime for both users involved in the conversation
		if u, ok := onlineUsers[msg.To]; ok {
			u.LastMessage = msg.Content
			u.LastMessageTime = sentTime
		}
		if u, ok := onlineUsers[msg.From]; ok {
			u.LastMessage = msg.Content
			u.LastMessageTime = sentTime
		}

		// Broadcast updated user list to all clients
		sendOnlineUsersToAll()
	}
}

// sendOnlineUsersToAll broadcasts the sorted user list to all connected clients
func sendOnlineUsersToAll() {
	users := []UserPresence{}
	for _, u := range onlineUsers {
		users = append(users, *u)
	}

	// Sort users: 
	// 1. Users with messages first (sorted by most recent message time)
	// 2. Users without messages second (sorted alphabetically by nickname)
	sort.Slice(users, func(i, j int) bool {
		userA := users[i]
		userB := users[j]

		// Both have messages - sort by most recent message time (newest first)
		if !userA.LastMessageTime.IsZero() && !userB.LastMessageTime.IsZero() {
			return userA.LastMessageTime.After(userB.LastMessageTime)
		}

		// Only userA has messages - A comes first
		if !userA.LastMessageTime.IsZero() && userB.LastMessageTime.IsZero() {
			return true
		}

		// Only userB has messages - B comes first
		if userA.LastMessageTime.IsZero() && !userB.LastMessageTime.IsZero() {
			return false
		}

		// Neither has messages - sort alphabetically by nickname
		return userA.Nickname < userB.Nickname
	})

	data := map[string]interface{}{
		"type":  "user_list",
		"users": users,
	}

	encoded, err := json.Marshal(data)
	if err != nil {
		log.Println("Error marshaling user list:", err)
		return
	}

	// Send to all connected clients
	for _, client := range clients {
		select {
		case client.Send <- encoded:
			// Message sent successfully
		default:
			// Client's send channel is blocked, skip this client
			log.Printf("Skipping blocked client: %s", client.UserUUID)
		}
	}
}

// getLastMessageBetweenUsers gets the most recent message between current user and another user
func getLastMessageBetweenUsers(db *sql.DB, userA, userB string) (string, time.Time) {
	query := `
        SELECT content, created_at 
        FROM private_messages 
        WHERE (sender_uuid = ? AND receiver_uuid = ?) 
           OR (sender_uuid = ? AND receiver_uuid = ?)
        ORDER BY created_at DESC 
        LIMIT 1`
	
	var content string
	var createdAt time.Time
	
	err := db.QueryRow(query, userA, userB, userB, userA).Scan(&content, &createdAt)
	if err != nil {
		return "", time.Time{} // No messages found
	}
	
	return content, createdAt
}

// loadUserPresenceFromDB loads the user presence data including last message info
func loadUserPresenceFromDB(db *sql.DB, userUUID string) {
	// Get all other users to populate their presence data
	rows, err := db.Query(`SELECT uuid, nickname FROM users WHERE uuid != ?`, userUUID)
	if err != nil {
		log.Printf("Error querying users: %v", err)
		return
	}
	defer rows.Close()

	for rows.Next() {
		var otherUserUUID, nickname string
		if err := rows.Scan(&otherUserUUID, &nickname); err != nil {
			continue
		}

		// Skip if this user is already in our online users map
		if _, exists := onlineUsers[otherUserUUID]; exists {
			continue
		}

		// Get last message between current user and this other user
		lastMsg, lastMsgTime := getLastMessageBetweenUsers(db, userUUID, otherUserUUID)

		// Add to onlineUsers map (they're offline until they connect)
		onlineUsers[otherUserUUID] = &UserPresence{
			UserUUID:        otherUserUUID,
			Nickname:        nickname,
			LastMessage:     lastMsg,
			LastMessageTime: lastMsgTime,
			IsOnline:        false,
		}
	}
}

func readPump(db *sql.DB, client *Client) {
	defer func() {
		client.Conn.Close()
		delete(clients, client.UserUUID)
		if u, ok := onlineUsers[client.UserUUID]; ok {
			u.IsOnline = false
		}
		// Notify all users that this user went offline
		sendOnlineUsersToAll()
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