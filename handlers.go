package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

type RegisterRequest struct {
	Nickname  string `json:"nickname"`
	Age       int    `json:"age"`
	Gender    string `json:"gender"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Email     string `json:"email"`
	Password  string `json:"password"`
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func RegisterHandler(db *sql.DB) http.HandlerFunc {
	fmt.Println("register func")
	return func(w http.ResponseWriter, r *http.Request) {
		fmt.Println("register handler")
		var req RegisterRequest

		// Decode JSON body
		err := json.NewDecoder(r.Body).Decode(&req)
		if err != nil {
			fmt.Println("Error: invalid Json")
			http.Error(w, "Invalid JSON", http.StatusBadRequest)
			return
		}

		// Basic validation
		req.Nickname = strings.TrimSpace(req.Nickname)
		req.Email = strings.TrimSpace(req.Email)
		req.Password = strings.TrimSpace(req.Password)

		if req.Nickname == "" || req.Email == "" || req.Password == "" || req.Age <= 0 {
			fmt.Println("Eroor: missing fields")
			http.Error(w, "Missing required fields", http.StatusBadRequest)
			return
		}

		// Check if user already exists
		exists, err := UserExists(db, req.Email, req.Nickname)
		if err != nil {
			fmt.Println("error checking User existence")
			log.Printf("DB error checking user existence: %v", err)
			http.Error(w, "Server error", http.StatusInternalServerError)
			return
		}
		if exists {
			fmt.Println("Error: This User exist")
			http.Error(w, "Email or Nickname already taken", http.StatusConflict)
			return
		}

		// Hash password
		hashedPass, err := HashPassword(req.Password)
		if err != nil {
			fmt.Println("Error hashing passworde")
			log.Printf("Error hashing password: %v", err)
			http.Error(w, "Server error", http.StatusInternalServerError)
			return
		}

		// Create UUID for user
		userUUID := uuid.New().String()

		// Insert user in DB
		err = InsertUserFull(db, userUUID, req.Nickname, req.Email, hashedPass, req.Age, req.Gender, req.FirstName, req.LastName)
		if err != nil {
			fmt.Println("Error inserting user")
			log.Printf("Error inserting user: %v", err)
			http.Error(w, "Server error", http.StatusInternalServerError)
			return
		}

		// After successful InsertUserFull:
		newUser := UserPresence{
			UserUUID:        userUUID,
			Nickname:        req.Nickname,
			IsOnline:        false, // not connected yet
			LastMessage:     "",
			LastMessageTime: time.Time{},
		}

		data := map[string]interface{}{
			"type": "user_registered",
			"user": newUser,
		}
		encoded, _ := json.Marshal(data)

		// Push to all connected clients (all users, all tabs)
		for userUUID, conns := range clients {
			for client := range conns {
				select {
				case client.Send <- encoded:
				default:
					log.Printf("Client %s channel full, skipping", userUUID)
				}
			}
		}

		w.WriteHeader(http.StatusCreated)
		w.Write([]byte("User registered successfully"))
		fmt.Println("User registred succussfully")
	}
}

type LoginRequest struct {
	Identifier string `json:"identifier"` // email or nickname
	Password   string `json:"password"`
}

func LoginHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req LoginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid JSON", http.StatusBadRequest)
			return
		}

		// Basic input validation
		if req.Identifier == "" || req.Password == "" {
			http.Error(w, "Missing credentials", http.StatusBadRequest)
			return
		}

		// Get user by email or nickname
		userUUID, hashedPassword, err := GetUserByEmailOrNickname(db, req.Identifier)
		if err != nil {
			http.Error(w, "Invalid email/nickname or password", http.StatusUnauthorized)
			return
		}

		// Compare password
		if !CheckPasswordHash(hashedPassword, req.Password) {
			http.Error(w, "Invalid email/nickname or password", http.StatusUnauthorized)
			return
		}

		// Create session UUID and expiry
		sessionUUID := uuid.New().String()
		expiresAt := time.Now().Add(24 * time.Hour)

		// Save session in DB
		err = CreateSession(db, sessionUUID, userUUID, expiresAt)
		if err != nil {
			http.Error(w, "Server error", http.StatusInternalServerError)
			return
		}

		log.Println("Setting cookie with session_token:", sessionUUID)

		// Set cookie with session UUID
		http.SetCookie(w, &http.Cookie{
			Name:     "session_token",
			Value:    sessionUUID,
			Expires:  expiresAt,
			HttpOnly: true,
			Path:     "/",
			SameSite: http.SameSiteLaxMode, // <--- important! //If SameSite is not explicitly set, some browsers block the cookie for fetch() even to localhost.
		})

		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("Login successful"))

		log.Println("Login successful, session cookie set for", userUUID)
	}
}

func LogoutHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("session_token")
		if err != nil {
			http.Error(w, "No session found", http.StatusUnauthorized)
			return
		}

		sessionToken := cookie.Value

		// Delete session from DB
		err = DeleteSession(db, sessionToken)
		if err != nil {
			http.Error(w, "Error logging out", http.StatusInternalServerError)
			return
		}

		// Expire the session cookie
		expiredCookie := &http.Cookie{
			Name:     "session_token",
			Value:    "",
			Path:     "/",
			MaxAge:   -1,
			HttpOnly: true,
		}
		http.SetCookie(w, expiredCookie)

		w.Write([]byte("Logged out successfully"))
	}
}

type CreatePostRequest struct {
	Title      string   `json:"title"`
	Content    string   `json:"content"`
	Categories []string `json:"categories"`
}

func GetCategoriesHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.Query("SELECT name FROM categories")
		if err != nil {
			http.Error(w, "Failed to fetch categories", http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		var categories []string
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err == nil {
				categories = append(categories, name)
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(categories)
	}
}

func CreatePostHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userUUID, ok := UserUUIDFromContext(r.Context())
		if !ok {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		var req CreatePostRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			log.Println("JSON decode error:", err)
			http.Error(w, "Invalid JSON", http.StatusBadRequest)
			return
		}

		req.Title = strings.TrimSpace(req.Title)
		req.Content = strings.TrimSpace(req.Content)

		if req.Title == "" || req.Content == "" {
			http.Error(w, "Title and content are required", http.StatusBadRequest)
			return
		}

		postUUID := uuid.New().String()
		now := time.Now()

		log.Println("Creating post:", postUUID, userUUID, req.Title, req.Content, now)

		err := InsertPost(db, postUUID, userUUID, req.Title, req.Content, now)
		if err != nil {
			log.Println("InsertPost error:", err)
			http.Error(w, "Failed to insert post", http.StatusInternalServerError)
			return
		}

		log.Println("Inserting categories:", req.Categories)
		err = InsertPostCategories(db, postUUID, req.Categories)
		if err != nil {
			log.Println("InsertPostCategories error:", err)
			http.Error(w, "Failed to insert categories", http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusCreated)
		w.Write([]byte("Post created successfully"))
	}
}

func WebSocketHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userUUID, ok := UserUUIDFromContext(r.Context())
		if !ok {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		// Fetch user's nickname from DB on connection.
		var nickname string
		err := db.QueryRow("SELECT nickname FROM users WHERE uuid = ?", userUUID).Scan(&nickname)
		if err != nil {
			log.Printf("Could not find nickname for user %s: %v", userUUID, err)
			http.Error(w, "User not found", http.StatusInternalServerError)
			return
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Println("WebSocket upgrade error:", err)
			return
		}

		client := &Client{
			Conn:     conn,
			UserUUID: userUUID,
			Send:     make(chan []byte, 256),
		}

		// ✅ Add client into map of connections for this user
		if _, ok := clients[userUUID]; !ok {
			clients[userUUID] = make(map[*Client]bool)
		}
		clients[userUUID][client] = true

		log.Printf("User %s (%s) connected. Total clients for user: %d", userUUID, nickname, len(clients[userUUID]))

		// STEP 1: Establish presence
		var currentUserLastMsg string
		var currentUserLastTime time.Time
		row := db.QueryRow(`
            SELECT content, sent_at 
            FROM private_messages 
            WHERE sender_uuid = ? 
            ORDER BY sent_at DESC 
            LIMIT 1`, userUUID)
		err = row.Scan(&currentUserLastMsg, &currentUserLastTime)
		if err == sql.ErrNoRows {
			currentUserLastMsg = ""
			currentUserLastTime = time.Time{}
		} else if err != nil {
			log.Printf("Error getting user's last message: %v", err)
		}

		if existingUser, exists := onlineUsers[userUUID]; exists {
			existingUser.IsOnline = true
			existingUser.Nickname = nickname
			if !currentUserLastTime.IsZero() && currentUserLastTime.After(existingUser.LastMessageTime) {
				existingUser.LastMessage = currentUserLastMsg
				existingUser.LastMessageTime = currentUserLastTime
			}
		} else {
			onlineUsers[userUUID] = &UserPresence{
				UserUUID:        userUUID,
				Nickname:        nickname,
				IsOnline:        true,
				LastMessage:     currentUserLastMsg,
				LastMessageTime: currentUserLastTime,
			}
		}

		// STEP 2: Load presence for other users
		loadUserPresenceFromDB(db, userUUID)

		rows, _ := db.Query(`
            SELECT DISTINCT CASE
                WHEN sender_uuid = ? THEN receiver_uuid
                ELSE sender_uuid
            END AS other_uuid
            FROM private_messages
            WHERE sender_uuid = ? OR receiver_uuid = ?`,
			userUUID, userUUID, userUUID)
		defer rows.Close()
		for rows.Next() {
			var other string
			if err := rows.Scan(&other); err == nil {
				if _, ok := onlineUsers[other]; !ok {
					var nickname string
					if err := db.QueryRow("SELECT nickname FROM users WHERE uuid = ?", other).Scan(&nickname); err == nil {
						onlineUsers[other] = &UserPresence{
							UserUUID: other,
							Nickname: nickname,
							IsOnline: false,
						}
					}
				}
			}
		}

		sendOnlineUsersToAllConnected(db)

		// Run pumps
		go writePump(client)
		readPump(db, client)

		// ✅ Cleanup when this client disconnects
		delete(clients[userUUID], client)
		if len(clients[userUUID]) == 0 {
			delete(clients, userUUID)
			if u, ok := onlineUsers[userUUID]; ok {
				u.IsOnline = false
			}
			sendOnlineUsersToAllConnected(db)
		}

		log.Printf("User %s (%s) disconnected. Remaining connections: %d", userUUID, nickname, len(clients[userUUID]))
	}
}

// fetch chat history
func GetMessagesHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userUUID, ok := UserUUIDFromContext(r.Context())
		if !ok {
			log.Println("GetMessagesHandler: Unauthorized - no user UUID in context")
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		otherUser := r.URL.Query().Get("with")
		offsetStr := r.URL.Query().Get("offset")

		if otherUser == "" {
			log.Println("GetMessagesHandler: Missing 'with' parameter")
			http.Error(w, "Missing 'with' parameter", http.StatusBadRequest)
			return
		}

		offset, err := strconv.Atoi(offsetStr)
		if err != nil {
			log.Printf("GetMessagesHandler: Invalid offset '%s', using 0", offsetStr)
			offset = 0
		}

		log.Printf("GetMessagesHandler: Loading messages between %s and %s, offset=%d", userUUID, otherUser, offset)

		messages, err := LoadMessages(db, userUUID, otherUser, 10, offset)
		if err != nil {
			log.Printf("GetMessagesHandler: LoadMessages error: %v", err)
			http.Error(w, "Failed to fetch messages: "+err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(messages); err != nil {
			log.Printf("GetMessagesHandler: JSON encoding error: %v", err)
			http.Error(w, "Failed to encode messages", http.StatusInternalServerError)
			return
		}
		log.Printf("API: Loading messages between %s and %s with offset %d. Found %d messages.", userUUID, otherUser, offset, len(messages))

		log.Printf("GetMessagesHandler: Successfully returned %d messages", len(messages))
	}
}

// Add this updated MeHandler function to your handlers.go

func MeHandler(db *sql.DB) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userUUID, ok := UserUUIDFromContext(r.Context())
		if !ok {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		// Fetch user's nickname from database
		var nickname string
		err := db.QueryRow("SELECT nickname FROM users WHERE uuid = ?", userUUID).Scan(&nickname)
		if err != nil {
			log.Printf("Could not find nickname for user %s: %v", userUUID, err)
			http.Error(w, "User not found", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"user_uuid": userUUID,
			"nickname":  nickname,
		})
	})
}

func GetPostsHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		offsetStr := r.URL.Query().Get("offset")
		limitStr := r.URL.Query().Get("limit")
		category := r.URL.Query().Get("category")
		offset, err := strconv.Atoi(offsetStr)
		if err != nil {
			offset = 0
		}

		limit, err := strconv.Atoi(limitStr)
		if err != nil || limit <= 0 || limit > 50 {
			limit = 10
		}
		posts, err := GetPostsPaginated(db, offset, limit, category)
		log.Println("posts bck", posts)

		if err != nil {
			http.Error(w, "Failed to load posts", http.StatusInternalServerError)
			return
		}

		json.NewEncoder(w).Encode(posts)
	}
}

func GetPostDetailsHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		postUUID := r.URL.Query().Get("uuid")
		if postUUID == "" {
			http.Error(w, "Missing post UUID", http.StatusBadRequest)
			return
		}

		post, err := LoadPostWithComments(db, postUUID)
		if err != nil {
			log.Printf("Error loading post: %v", err)
			http.Error(w, "Failed to load post", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(post)
	}
}

type CommentRequest struct {
	PostUUID string `json:"post_uuid"`
	Content  string `json:"content"`
}

func CreateCommentHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userUUID, ok := UserUUIDFromContext(r.Context())
		if !ok {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		var req CommentRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid JSON", http.StatusBadRequest)
			return
		}

		if req.PostUUID == "" || strings.TrimSpace(req.Content) == "" {
			http.Error(w, "Missing comment content or post UUID", http.StatusBadRequest)
			return
		}

		err := InsertComment(db, userUUID, req.PostUUID, req.Content)
		if err != nil {
			http.Error(w, "Failed to save comment", http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusCreated)
		w.Write([]byte("Comment posted"))
	}
}

func GetAllUsersHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.Query(`SELECT uuid, nickname FROM users`)
		if err != nil {
			http.Error(w, "Failed to fetch users", http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		var users []map[string]interface{}
		for rows.Next() {
			var uuid, nickname string
			if err := rows.Scan(&uuid, &nickname); err == nil {
				isOnline := false
				if userPresence, ok := onlineUsers[uuid]; ok && userPresence.IsOnline {
					isOnline = true
				}
				users = append(users, map[string]interface{}{
					"uuid":     uuid,
					"nickname": nickname,
					"isOnline": isOnline,
				})
			}
		}
		log.Println("Users in the /users handler", users)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(users)
	}
}
