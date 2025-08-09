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
	clients     = make(map[string]*Client)       // key = user UUID
	broadcast   = make(chan Message)             // channel for incoming messages
	onlineUsers = make(map[string]*UserPresence) // key = userUUID
	typingUsers = make(map[string]*TypingStatus) // key = userUUID
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
		if client, ok := clients[msg.To]; ok {
			log.Println("------------------msg.To-------------------")
			client.Send <- data
		}

		// Send back to sender as confirmation.
		if sender, ok := clients[msg.From]; ok {
			log.Println("------------------msg.From-------------------")
			sender.Send <- data
		}

		if _, ok := onlineUsers[msg.To]; !ok {
			// fetch nickname from DB
			var nickname string
			err := db.QueryRow("SELECT nickname FROM users WHERE uuid = ?", msg.To).Scan(&nickname)
			if err == nil {
				onlineUsers[msg.To] = &UserPresence{
					UserUUID: msg.To,
					Nickname: nickname,
					IsOnline: false,
				}
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
    users := []UserPresence{}

    // 1️⃣ Fetch all users who are either:
    //    - currently online
    //    - OR have had a conversation with the viewer
    rows, err := db.Query(`
        SELECT DISTINCT u.uuid, u.nickname
        FROM users u
        LEFT JOIN private_messages m
            ON (u.uuid = m.sender_uuid AND m.receiver_uuid = ?)
            OR (u.uuid = m.receiver_uuid AND m.sender_uuid = ?)
        WHERE u.uuid != ?
    `, viewerUUID, viewerUUID, viewerUUID)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    for rows.Next() {
        var otherUUID, nickname string
        if err := rows.Scan(&otherUUID, &nickname); err != nil {
            continue
        }

        // 2️⃣ Determine if they are online right now
        isOnline := false
        if presence, ok := onlineUsers[otherUUID]; ok && presence.IsOnline {
            isOnline = true
        }

        // 3️⃣ Get the last message between viewer and this user
        lastMsg, lastTime := getLastMessageBetweenUsers(db, viewerUUID, otherUUID)

        // 4️⃣ Build the presence entry
        users = append(users, UserPresence{
            UserUUID:        otherUUID,
            Nickname:        nickname,
            IsOnline:        isOnline,
            LastMessage:     lastMsg,
            LastMessageTime: lastTime,
        })
    }

    // 5️⃣ Sort by last message time desc, then alphabetically
    sort.Slice(users, func(i, j int) bool {
        a := users[i]
        b := users[j]
        if !a.LastMessageTime.IsZero() && !b.LastMessageTime.IsZero() {
            return a.LastMessageTime.After(b.LastMessageTime)
        }
        if !a.LastMessageTime.IsZero() {
            return true
        }
        if !b.LastMessageTime.IsZero() {
            return false
        }
        return a.Nickname < b.Nickname
    })

    return users, nil
}


// MODIFIED FUNCTION: Renamed from sendOnlineUsersToAll and logic changed
func sendPersonalizedUserLists(db *sql.DB, senderUUID, receiverUUID string) {
	// Generate and send the list for the SENDER
	if client, ok := clients[senderUUID]; ok {
		userList, err := generateUserListFor(db, senderUUID)
		if err != nil {
			log.Printf("Error generating user list for sender %s: %v", senderUUID, err)
		} else {
			data := map[string]interface{}{"type": "user_list", "users": userList}
			encoded, _ := json.Marshal(data)
			client.Send <- encoded
		}
	}

	// Generate and send the list for the RECEIVER
	if client, ok := clients[receiverUUID]; ok {
		userList, err := generateUserListFor(db, receiverUUID)
		if err != nil {
			log.Printf("Error generating user list for receiver %s: %v", receiverUUID, err)
		} else {
			data := map[string]interface{}{"type": "user_list", "users": userList}
			encoded, _ := json.Marshal(data)
			client.Send <- encoded
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
		log.Printf("Loading user presence data for user: %s", userUUID)

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
			log.Printf("Error scanning user row: %v", err)
			continue
		}

		// Get last message between current user and this other user
		lastMsg, lastMsgTime := getLastMessageBetweenUsers(db, userUUID, otherUserUUID)

		log.Printf("Processing user %s (%s): lastMsg='%s', lastTime=%v",
			otherUserUUID, nickname, lastMsg, lastMsgTime)

		// Always update or create the user presence data
		if existingUser, exists := onlineUsers[otherUserUUID]; exists {
			// Update existing user's message data but preserve online status
			log.Printf("Updating existing user %s: was online=%v", nickname, existingUser.IsOnline)

			existingUser.Nickname = nickname
			existingUser.LastMessage = lastMsg
			existingUser.LastMessageTime = lastMsgTime
			// Keep the existing IsOnline status - don't change it!

		} else {
			// Add new user (they're offline until they connect)
			log.Printf("Adding new offline user: %s", nickname)

			onlineUsers[otherUserUUID] = &UserPresence{
				UserUUID:        otherUserUUID,
				Nickname:        nickname,
				LastMessage:     lastMsg,
				LastMessageTime: lastMsgTime,
				IsOnline:        false, // They're offline until they connect
			}
		}
	}

	// Check for any errors from iterating over rows
	if err = rows.Err(); err != nil {
		log.Printf("Error iterating over user rows: %v", err)
	}

	log.Printf("Completed loading user presence data. Total users in map: %d", len(onlineUsers))
}

// MODIFIED: This function now sends personalized lists to ALL connected clients.
func sendOnlineUsersToAllConnected(db *sql.DB) {
	// Loop through all connected clients
	for uuid, client := range clients {
		userList, err := generateUserListFor(db, uuid)
		if err != nil {
			log.Printf("Error generating user list for %s on global update: %v", uuid, err)
			continue
		}

		data := map[string]interface{}{
			"type":  "user_list",
			"users": userList,
		}

		encoded, err := json.Marshal(data)
		if err != nil {
			log.Println("Error marshaling user list for global update:", err)
			continue
		}

		select {
		case client.Send <- encoded:
		default:
			log.Printf("Skipping blocked client during global update: %s", client.UserUUID)
		}
	}
}

// MODIFIED: readPump and writePump need to pass the *sql.DB to sendOnlineUsersToAllConnected
func readPump(db *sql.DB, client *Client) {
	defer func() {
		client.Conn.Close()
		delete(clients, client.UserUUID)
		if u, ok := onlineUsers[client.UserUUID]; ok {
			u.IsOnline = false
		}
		// Clean up typing status when user disconnects
		delete(typingUsers, client.UserUUID)
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

			handleTypingMessage(typingMsg)
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
func handleTypingMessage(msg TypingMessage) {
	log.Printf("Handling typing message: %s from %s to %s", msg.Type, msg.Nickname, msg.To)

	if msg.Type == "typing_start" {
		typingUsers[msg.From] = &TypingStatus{
			UserUUID: msg.From,
			IsTyping: true,
			Nickname: msg.Nickname,
			TypingTo: msg.To,
			LastSeen: time.Now(),
		}
	} else if msg.Type == "typing_stop" {
		delete(typingUsers, msg.From)
	}

	// Send typing status to the target user
	if targetClient, ok := clients[msg.To]; ok {
		data, err := json.Marshal(msg)
		if err != nil {
			log.Println("Error marshaling typing message:", err)
			return
		}

		select {
		case targetClient.Send <- data:
			log.Printf("Sent typing status to %s", msg.To)
		default:
			log.Printf("Failed to send typing status to %s (channel blocked)", msg.To)
		}
	}
}

// cleanupOldTypingStatus removes stale typing statuses (optional, for cleanup)
func cleanupOldTypingStatus() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		now := time.Now()
		for userUUID, status := range typingUsers {
			if now.Sub(status.LastSeen) > 15*time.Second {
				log.Printf("Cleaning up stale typing status for user %s", userUUID)
				delete(typingUsers, userUUID)
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
