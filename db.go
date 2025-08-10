package main

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

var ErrUserExists = errors.New("user already exists")

type MessageWithAuthor struct {
	From         string `json:"from"`
	To           string `json:"to"`
	Content      string `json:"content"`
	SentAt       string `json:"sent_at"`
	FromNickname string `json:"from_nickname"`
}

func InitDB(dbFile string) (*sql.DB, error) {
	db, err := sql.Open("sqlite3", dbFile)
	if err != nil {
		return nil, err
	}

	// Ping to check connection
	if err := db.Ping(); err != nil {
		return nil, err
	}

	// Read schema.sql
	schema, err := os.ReadFile("schema.sql")
	if err != nil {
		return nil, err
	}

	// Execute schema to create table if not exist
	_, err = db.Exec(string(schema))
	if err != nil {
		return nil, err
	}
	return db, nil
}

// Check if email or nickname already exists
func UserExists(db *sql.DB, email, nickname string) (bool, error) {
	var exists bool
	query := `SELECT EXISTS(SELECT 1 FROM users WHERE email = ? OR nickname = ?)`
	err := db.QueryRow(query, email, nickname).Scan(&exists)
	return exists, err
}

/*
  for security we can add:
  	// Only allow "email" or "nickname" as column names
	validColumns := map[string]bool{
		"email": true,
		"nickname": true,
	}

	if !validColumns[input] {
		fmt.Println("Invalid column name")
		return false, nil
	}
*/

// Insert user with all fields
func InsertUserFull(db *sql.DB, uuid, nickname, email, passwordHash string, age int, gender, firstName, lastName string) error {
	stmt := `INSERT INTO users (uuid, nickname, email, password_hash, age, gender, first_name, last_name) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	_, err := db.Exec(stmt, uuid, nickname, email, passwordHash, age, gender, firstName, lastName)
	fmt.Println(err)
	return err
}

// GetUserByEmailOrNickname fetches user with matching email OR nickname
func GetUserByEmailOrNickname(db *sql.DB, identifier string) (uuid, hashedPassword string, err error) {
	query := `SELECT uuid, password_hash FROM users WHERE email = ? OR nickname = ?`
	return getUserAuth(db, query, identifier)
}

func getUserAuth(db *sql.DB, query, id string) (string, string, error) {
	var uuid, hash string
	err := db.QueryRow(query, id, id).Scan(&uuid, &hash)
	return uuid, hash, err
}

// CreateSession inserts a session for a user
func CreateSession(db *sql.DB, sessionUUID, userUUID string, expiresAt time.Time) error {
	stmt := `INSERT INTO sessions (session_uuid, user_uuid, expires_at) VALUES (?, ?, ?)`
	_, err := db.Exec(stmt, sessionUUID, userUUID, expiresAt)
	return err
}

var ErrSessionNotFound = errors.New("session not found or expired")

type Session struct {
	SessionUUID string
	UserUUID    string
	ExpiresAt   time.Time
}

// GetSession returns session info if session exists and valid
func GetSession(db *sql.DB, sessionUUID string) (*Session, error) {
	var s Session
	query := "SELECT session_uuid, user_uuid, expires_at FROM sessions WHERE session_uuid = ?"
	err := db.QueryRow(query, sessionUUID).Scan(&s.SessionUUID, &s.UserUUID, &s.ExpiresAt)
	if err != nil {
		return nil, ErrSessionNotFound
	}

	if time.Now().After(s.ExpiresAt) {
		return nil, ErrSessionNotFound
	}

	return &s, nil
}

func DeleteSession(db *sql.DB, sessionUUID string) error {
	stmt := "DELETE FROM sessions WHERE session_uuid = ?"
	_, err := db.Exec(stmt, sessionUUID)
	return err
}

func InsertPost(db *sql.DB, postUUID, userUUID, title, content string, createdAt time.Time) error {
	stmt := "INSERT INTO posts (post_uuid, user_uuid, title, content, created_at) VALUES (?, ?, ?, ?, ?)"
	_, err := db.Exec(stmt, postUUID, userUUID, title, content, createdAt)
	return err
}

func InsertPostCategories(db *sql.DB, postUUID string, categories []string) error {
	if len(categories) == 0 {
		return nil
	}

	// Get the post ID (integer) using post_uuid
	var postID int
	err := db.QueryRow("SELECT id FROM posts WHERE post_uuid = ?", postUUID).Scan(&postID)
	if err != nil {
		return fmt.Errorf("failed to get post ID from post_uuid: %w", err)
	}

	for _, cat := range categories {
		// Insert category if it doesn't exist yet
		var categoryID int
		err := db.QueryRow("SELECT id FROM categories WHERE name = ?", cat).Scan(&categoryID)
		if err == sql.ErrNoRows {
			res, err := db.Exec("INSERT INTO categories (name) VALUES (?)", cat)
			if err != nil {
				return fmt.Errorf("failed to insert category %s: %w", cat, err)
			}
			newID, _ := res.LastInsertId()
			categoryID = int(newID)
		} else if err != nil {
			return fmt.Errorf("failed to query category %s: %w", cat, err)
		}

		// Insert into post_categories
		_, err = db.Exec("INSERT OR IGNORE INTO post_categories (post_id, category_id) VALUES (?, ?)", postID, categoryID)
		if err != nil {
			return fmt.Errorf("failed to link post and category: %w", err)
		}
	}

	return nil
}

func SaveMessage(db *sql.DB, uuid, sender, receiver, content string, createdAt time.Time) error {
	stmt := `
        INSERT INTO private_messages (uuid, sender_uuid, receiver_uuid, content, created_at, sent_at)
        VALUES (?, ?, ?, ?, ?, ?)`
	_, err := db.Exec(stmt, uuid, sender, receiver, content, createdAt, createdAt)
	if err != nil {
		log.Printf("SaveMessage error: %v", err)
	} else {
		log.Printf("SaveMessage success: %s -> %s: %s (UUID: %s)", sender, receiver, content, uuid)
	}
	return err
}
func LoadMessages(db *sql.DB, userA, userB string, limit, offset int) ([]MessageWithAuthor, error) {
	// Fixed SQL query - using correct column names from schema
	stmt := `
        SELECT m.sender_uuid, m.receiver_uuid, m.content, m.sent_at, u.nickname
        FROM private_messages m
        JOIN users u ON m.sender_uuid = u.uuid
        WHERE (m.sender_uuid = ? AND m.receiver_uuid = ?)
           OR (m.sender_uuid = ? AND m.receiver_uuid = ?)
        ORDER BY m.sent_at DESC
        LIMIT ? OFFSET ?`

	log.Printf("LoadMessages query: userA=%s, userB=%s, limit=%d, offset=%d", userA, userB, limit, offset)

	rows, err := db.Query(stmt, userA, userB, userB, userA, limit, offset)
	if err != nil {
		log.Printf("LoadMessages query error: %v", err)
		return []MessageWithAuthor{}, err // Return empty slice instead of nil
	}
	defer rows.Close()

	// Initialize as empty slice instead of nil slice
	messages := make([]MessageWithAuthor, 0)

	for rows.Next() {
		var m MessageWithAuthor
		var sentAt time.Time

		// Scan the fields - using correct field names
		if err := rows.Scan(&m.From, &m.To, &m.Content, &sentAt, &m.FromNickname); err != nil {
			log.Printf("Error scanning message: %v", err)
			continue
		}
		m.SentAt = sentAt.Format(time.RFC3339)
		messages = append([]MessageWithAuthor{m}, messages...)
	}

	// Check for errors during iteration
	if err = rows.Err(); err != nil {
		log.Printf("LoadMessages rows iteration error: %v", err)
		return []MessageWithAuthor{}, err // Return empty slice instead of nil
	}

	log.Printf("LoadMessages returning %d messages", len(messages))
	return messages, nil
}

type Post struct {
	UUID       string    `json:"uuid"`
	Title      string    `json:"title"`
	Content    string    `json:"content"`
	CreatedAt  time.Time `json:"created_at"`
	Nickname   string    `json:"nickname"` // author
	Categories []string  `json:"categories"`
}

func LoadAllPosts(db *sql.DB) ([]Post, error) {
	query := `
		SELECT posts.uuid, title, content, posts.created_at, users.nickname
		FROM posts
		JOIN users ON posts.user_uuid = users.uuid
		ORDER BY posts.created_at DESC
	`

	rows, err := db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var posts []Post
	for rows.Next() {
		var p Post
		err := rows.Scan(&p.UUID, &p.Title, &p.Content, &p.CreatedAt, &p.Nickname)
		if err != nil {
			continue
		}

		// FIXED: Load categories for each post
		categories, _ := GetPostCategories(db, p.UUID)
		p.Categories = categories

		posts = append(posts, p)
	}
	return posts, nil
}
func GetPostCategories(db *sql.DB, postUUID string) ([]string, error) {
	query := `
		SELECT c.name 
		FROM categories c
		JOIN post_categories pc ON c.id = pc.category_id
		JOIN posts p ON p.id = pc.post_id
		WHERE p.post_uuid = ?
	`
	rows, err := db.Query(query, postUUID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var categories []string
	for rows.Next() {
		var category string
		if err := rows.Scan(&category); err == nil {
			categories = append(categories, category)
		}
	}
	return categories, nil
}

type Comment struct {
	Content   string    `json:"content"`
	Author    string    `json:"author"` // nickname
	CreatedAt time.Time `json:"created_at"`
}

type FullPost struct {
	Post
	Comments []Comment `json:"comments"`
}

func LoadPostWithComments(db *sql.DB, postUUID string) (*FullPost, error) {
	post := Post{}
	err := db.QueryRow(`
        SELECT posts.post_uuid, title, content, posts.created_at, users.nickname
        FROM posts
        JOIN users ON posts.user_uuid = users.uuid
        WHERE posts.post_uuid = ?
    `, postUUID).Scan(&post.UUID, &post.Title, &post.Content, &post.CreatedAt, &post.Nickname)

	if err != nil {
		log.Printf("Error loading post with UUID %s: %v", postUUID, err)
		return nil, err
	}

	// Always initialize Comments slice
	comments := []Comment{}

	rows, err := db.Query(`
        SELECT comments.content, users.nickname, comments.created_at
        FROM comments
        JOIN users ON comments.user_uuid = users.uuid
        JOIN posts ON posts.id = comments.post_id
        WHERE posts.post_uuid = ?
        ORDER BY comments.created_at ASC
    `, postUUID)

	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var c Comment
			if err := rows.Scan(&c.Content, &c.Author, &c.CreatedAt); err == nil {
				comments = append(comments, c)
			}
		}
	} else {
		log.Printf("Error querying comments: %v", err)
	}

	return &FullPost{
		Post:     post,
		Comments: comments, // Always an array (empty if no comments)
	}, nil
}

func InsertComment(db *sql.DB, userUUID, postUUID, content string) error {
	stmt := `
		INSERT INTO comments (post_id, user_uuid, content, created_at)
		VALUES ((SELECT id FROM posts WHERE post_uuid = ?), ?, ?, ?)
	`
	_, err := db.Exec(stmt, postUUID, userUUID, content, time.Now())
	return err
}

func GetRecentPosts(db *sql.DB, limit int) ([]Post, error) {
	rows, err := db.Query(`SELECT title, content, created_at FROM posts ORDER BY created_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var posts []Post
	for rows.Next() {
		var p Post
		if err := rows.Scan(&p.Title, &p.Content, &p.CreatedAt); err != nil {
			return nil, err
		}
		posts = append(posts, p)
	}
	return posts, nil
}

func GetPostsPaginated(db *sql.DB, offset, limit int, category string) ([]Post, error) {
	query := `
        SELECT p.id, p.post_uuid, p.title, p.content, p.created_at, u.nickname
        FROM posts p
        JOIN users u ON p.user_uuid = u.uuid
    `
	var args []interface{}

	if category != "" {
		query += `
            WHERE EXISTS (
                SELECT 1
                FROM post_categories pc
                JOIN categories c ON pc.category_id = c.id
                WHERE pc.post_id = p.id AND c.name = ?
            )
        `
		args = append(args, category)
	}

	query += `
        ORDER BY p.created_at DESC
        LIMIT ? OFFSET ?
    `
	args = append(args, limit, offset)

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var posts []Post
	var postIDs []int
	idToPostIndex := make(map[int]int)

	for rows.Next() {
		var p Post
		var id int
		err := rows.Scan(&id, &p.UUID, &p.Title, &p.Content, &p.CreatedAt, &p.Nickname)
		if err != nil {
			continue
		}
		posts = append(posts, p)
		postIDs = append(postIDs, id)
		idToPostIndex[id] = len(posts) - 1
	}

	if len(posts) > 0 {
		placeholders := strings.Repeat("?,", len(postIDs)-1) + "?"
		catQuery := `
            SELECT pc.post_id, c.name
            FROM post_categories pc
            JOIN categories c ON pc.category_id = c.id
            WHERE pc.post_id IN (` + placeholders + `)
        `
		catRows, err := db.Query(catQuery, toInterfaceSlice(postIDs)...)
		if err != nil {
			return nil, err
		}
		defer catRows.Close()

		for catRows.Next() {
			var postID int
			var category string
			if err := catRows.Scan(&postID, &category); err == nil {
				if idx, ok := idToPostIndex[postID]; ok {
					posts[idx].Categories = append(posts[idx].Categories, category)
				}
			}
		}
	}

	return posts, nil
}

func toInterfaceSlice(ints []int) []interface{} {
	s := make([]interface{}, len(ints))
	for i, v := range ints {
		s[i] = v
	}
	return s
}
