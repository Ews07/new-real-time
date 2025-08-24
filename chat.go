// chat.go

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
	clients     = make(map[string]map[*Client]bool) // Each user can have multiple active connections
	broadcast   = make(chan Message)                // channel for incoming messages
	onlineUsers = make(map[string]*UserPresence)    // key = userUUID
	typingUsers = make(map[*Client]*TypingStatus)   // key = userUUID
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

type TypingMessage struct {
	Type     string `json:"type"`     // "typing_start" or "typing_stop"
	From     string `json:"from"`     // sender UUID
	To       string `json:"to"`       // receiver UUID
	Nickname string `json:"nickname"` // sender's nickname
}

type TypingStatus struct {
	UserUUID string    `json:"user_uuid"`
	IsTyping bool      `json:"is_typing"`
	Nickname string    `json:"nickname"`
	TypingTo string    `json:"typing_to"`
	LastSeen time.Time `json:"last_seen"`
}

// MODIFIED: handleMessages is now much simpler.
func handleMessages(db *sql.DB) {
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

		data, err := json.Marshal(broadcastMsg)
		if err != nil {
			log.Println("json marshal error:", err)
			continue
		}

		// If receiver is online, send the message directly.
		if receivers, ok := clients[msg.To]; ok {
			for c := range receivers {
				c.Send <- data
			}
		}

		// Send back to sender as confirmation.
		if senders, ok := clients[msg.From]; ok {
			for c := range senders {
				c.Send <- data
			}
		}

		// --- REMOVED ---
		// The entire block that updated onlineUsers[msg.To].LastMessage etc. has been removed.
		// It was causing the bug by modifying global state incorrectly.

		// Instead, we now generate and send personalized user lists to the participants.
		sendPersonalizedUserLists(db, msg.From, msg.To)

	}
}

// NEW HELPER FUNCTION: Generates a contextual user list for a specific user.
func generateUserListFor(db *sql.DB, viewerUUID string) ([]UserPresence, error) {
	rows, err := db.Query(`SELECT uuid, nickname FROM users WHERE uuid != ?`, viewerUUID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	users := []UserPresence{}

	for rows.Next() {
		var uuid string
		var nickname string
		if err := rows.Scan(&uuid, &nickname); err != nil {
			return nil, err
		}

		// Is this user online?
		isOnline := false
		if presence, ok := onlineUsers[uuid]; ok {
			isOnline = presence.IsOnline
		}

		// Get last message between viewer and this user
		lastMsg, lastTime := getLastMessageBetweenUsers(db, viewerUUID, uuid)

		users = append(users, UserPresence{
			UserUUID:        uuid,
			Nickname:        nickname,
			IsOnline:        isOnline,
			LastMessage:     lastMsg,
			LastMessageTime: lastTime,
		})
	}

	// Sort the personalized list
	sort.Slice(users, func(i, j int) bool {
		userA := users[i]
		userB := users[j]

		if !userA.LastMessageTime.IsZero() && !userB.LastMessageTime.IsZero() {
			return userA.LastMessageTime.After(userB.LastMessageTime)
		}
		if !userA.LastMessageTime.IsZero() {
			return true
		}
		if !userB.LastMessageTime.IsZero() {
			return false
		}
		return userA.Nickname < userB.Nickname
	})

	return users, nil
}

// MODIFIED FUNCTION: Renamed from sendOnlineUsersToAll and logic changed
func sendPersonalizedUserLists(db *sql.DB, senderUUID, receiverUUID string) {
	// Generate and send the list for the SENDER (all tabs/windows)
	if conns, ok := clients[senderUUID]; ok {
		userList, err := generateUserListFor(db, senderUUID)
		if err != nil {
			log.Printf("Error generating user list for sender %s: %v", senderUUID, err)
		} else {
			data := map[string]interface{}{"type": "user_list", "users": userList}
			encoded, _ := json.Marshal(data)

			for client := range conns {
				select {
				case client.Send <- encoded:
				default:
					log.Printf("Sender %s connection skipped (channel full)", senderUUID)
				}
			}
		}
	}

	// Generate and send the list for the RECEIVER (all tabs/windows)
	if conns, ok := clients[receiverUUID]; ok {
		userList, err := generateUserListFor(db, receiverUUID)
		if err != nil {
			log.Printf("Error generating user list for receiver %s: %v", receiverUUID, err)
		} else {
			data := map[string]interface{}{"type": "user_list", "users": userList}
			encoded, _ := json.Marshal(data)

			for client := range conns {
				select {
				case client.Send <- encoded:
				default:
					log.Printf("Receiver %s connection skipped (channel full)", receiverUUID)
				}
			}
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

// --- NO CHANGE NEEDED for loadUserPresenceFromDB ---
// This function already loads contextual data correctly for the connecting user.
func loadUserPresenceFromDB(db *sql.DB, userUUID string) {
	// ... function content is correct and remains the same
}

// MODIFIED: This function now sends personalized lists to ALL connected clients.
func sendOnlineUsersToAllConnected(db *sql.DB) {
	for userUUID, conns := range clients {
		userList, err := generateUserListFor(db, userUUID)
		if err != nil {
			log.Printf("Error generating user list for %s on global update: %v", userUUID, err)
			continue
		}

		// Build response
		data := map[string]interface{}{
			"type":  "user_list",
			"users": userList,
		}

		encoded, err := json.Marshal(data)
		if err != nil {
			log.Println("Error marshaling user list for global update:", err)
			continue
		}

		// Send to ALL connections for this user (all tabs/windows)
		for client := range conns {
			select {
			case client.Send <- encoded:
				log.Printf("Sent full user_list to %s (total users: %d)", userUUID, len(userList))
			default:
				log.Printf("Skipping blocked client during global update: %s (one of multiple connections)", client.UserUUID)
			}
		}
	}
}

// MODIFIED: readPump and writePump need to pass the *sql.DB to sendOnlineUsersToAllConnected
func readPump(db *sql.DB, client *Client) {
	defer func() {
		client.Conn.Close()
		delete(clients[client.UserUUID], client)
		if len(clients[client.UserUUID]) == 0 {
			delete(clients, client.UserUUID)
			if u, ok := onlineUsers[client.UserUUID]; ok {
				u.IsOnline = false
			}
		}

		// If this client was typing, tell the recipient to stop
		if status, ok := typingUsers[client]; ok && status.IsTyping {
			typingStopMsg := TypingMessage{
				Type:     "typing_stop",
				From:     status.UserUUID,
				To:       status.TypingTo,
				Nickname: status.Nickname,
			}

			if conns, ok := clients[status.TypingTo]; ok {
				if data, err := json.Marshal(typingStopMsg); err == nil {
					for targetConn := range conns {
						select {
						case targetConn.Send <- data:
						default:
							log.Printf("Skipping blocked client %s during typing_stop", status.TypingTo)
						}
					}
				}
			}
		}
		// Clean up typing status when user disconnects
		delete(typingUsers, client)
		log.Printf("User %s disconnected. Total clients: %d", client.UserUUID, len(clients))

		// Notify all users that this user went offline and stopped typing
		sendOnlineUsersToAllConnected(db)
	}()

	for {
		// Read raw JSON message
		_, message, err := client.Conn.ReadMessage()
		if err != nil {
			log.Println("read error:", err)
			break
		}

		// Parse the raw message to determine its type
		var baseMsg map[string]interface{}
		err = json.Unmarshal(message, &baseMsg)
		if err != nil {
			log.Println("JSON unmarshal error:", err)
			continue
		}

		msgType, hasType := baseMsg["type"].(string)

		if hasType && (msgType == "typing_start" || msgType == "typing_stop") {
			// Handle typing message
			var typingMsg TypingMessage
			err = json.Unmarshal(message, &typingMsg)
			if err != nil {
				log.Println("typing message unmarshal error:", err)
				continue
			}

			typingMsg.From = client.UserUUID

			// Get sender's nickname
			if sender, ok := onlineUsers[client.UserUUID]; ok {
				typingMsg.Nickname = sender.Nickname
			}

			handleTypingMessage(client, typingMsg)
		} else {
			// Handle regular chat message
			var msg Message
			err = json.Unmarshal(message, &msg)
			if err != nil {
				log.Println("chat message unmarshal error:", err)
				continue
			}

			msg.From = client.UserUUID
			msg.SentAt = time.Now().Format(time.RFC3339)

			log.Printf("Received message: From=%s, To=%s, Content=%s", msg.From, msg.To, msg.Content)

			// Save to database
			err = SaveMessage(db, uuid.New().String(), msg.From, msg.To, msg.Content, time.Now())
			if err != nil {
				log.Printf("Failed to save message: %v", err)
			} else {
				log.Printf("Message saved successfully")
			}

			// Send to broadcast channel
			broadcast <- msg
		}
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

// handleTypingMessage processes typing start/stop messages
func handleTypingMessage(client *Client, msg TypingMessage) {
	log.Printf("Handling typing message: %s from %s to %s", msg.Type, msg.Nickname, msg.To)

	if msg.Type == "typing_start" {
		typingUsers[client] = &TypingStatus{
			UserUUID: msg.From,
			IsTyping: true,
			Nickname: msg.Nickname,
			TypingTo: msg.To,
			LastSeen: time.Now(),
		}
	} else if msg.Type == "typing_stop" {
		delete(typingUsers, client)
	}

	// Send typing status to ALL connections of the target user
	if targets, ok := clients[msg.To]; ok {
		data, err := json.Marshal(msg)
		if err != nil {
			log.Println("Error marshaling typing message:", err)
			return
		}

		for c := range targets {
			select {
			case c.Send <- data:
			default:
				log.Printf("Failed to send typing status to %s (channel blocked)", msg.To)
			}
		}
	}
}

// cleanupOldTypingStatus removes stale typing statuses (optional, for cleanup)
func cleanupOldTypingStatus() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		now := time.Now()
		for client, status := range typingUsers {
			if now.Sub(status.LastSeen) > 15*time.Second {
				log.Printf("Cleaning up stale typing status for client %s (user %s)", client.UserUUID, status.UserUUID)
				delete(typingUsers, client)
			}
		}
	}
}

// In your WebSocketHandler, you must also pass the `db` handle when calling `sendOnlineUsersToAllConnected`
// ... inside WebSocketHandler ...
// sendOnlineUsersToAllConnected(db) // on connect
// go writePump(client)
// readPump(db, client) // already passes db
// ...
