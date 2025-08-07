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
	LastMessage     string    `json:"last_message"` // preview of last message content
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
			client.Send <- data
		}

		// Send back to sender as confirmation.
		if sender, ok := clients[msg.From]; ok {
			sender.Send <- data
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
    
    // Iterate over a copy of the keys to avoid race conditions if the map is modified elsewhere
    userUUIDs := make([]string, 0, len(onlineUsers))
    for k := range onlineUsers {
        userUUIDs = append(userUUIDs, k)
    }

    for _, otherUserUUID := range userUUIDs {
        // We don't need to show the viewer themselves in the list.
        if otherUserUUID == viewerUUID {
            continue
        }
        
        presenceInfo, ok := onlineUsers[otherUserUUID]
        if !ok {
            continue // Should not happen, but safe to check
        }
        
        // Get the last message specifically between the viewer and this other user
        lastMsg, lastTime := getLastMessageBetweenUsers(db, viewerUUID, otherUserUUID)
        
        // Create a new UserPresence struct with the correct contextual data
        contextualPresence := UserPresence{
            UserUUID:        presenceInfo.UserUUID,
            Nickname:        presenceInfo.Nickname,
            IsOnline:        presenceInfo.IsOnline,
            LastMessage:     lastMsg,
            LastMessageTime: lastTime,
        }
        users = append(users, contextualPresence)
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
		// Notify all users that this user went offline
		sendOnlineUsersToAllConnected(db) // Pass db handle
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

func writePump(client *Client) {
	for {
		msg, ok := <-client.Send
		if !ok {
			return
		}
		client.Conn.WriteMessage(websocket.TextMessage, msg)
	}
}

// In your WebSocketHandler, you must also pass the `db` handle when calling `sendOnlineUsersToAllConnected`
// ... inside WebSocketHandler ...
// sendOnlineUsersToAllConnected(db) // on connect
// go writePump(client)
// readPump(db, client) // already passes db
// ...