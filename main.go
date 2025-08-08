package main

import (
	"log"
	"net/http"

	"github.com/gorilla/mux"
)

func main() {
	//Database Initialization
	db, err := InitDB("forum.db")
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}

	defer db.Close()

	//Router Setup
	r := mux.NewRouter()
	//Public Routes
	r.HandleFunc("/register", RegisterHandler(db)).Methods("POST")
	r.HandleFunc("/login", LoginHandler(db)).Methods("POST")
	//Protected Routes
	r.Handle("/me", AuthMiddleware(MeHandler(), db)).Methods("GET")
	r.Handle("/logout", AuthMiddleware(LogoutHandler(db), db)).Methods("POST")
	r.Handle("/posts", AuthMiddleware(CreatePostHandler(db), db)).Methods("POST")
	r.Handle("/ws", AuthMiddleware(WebSocketHandler(db), db)).Methods("GET")
	r.Handle("/messages", AuthMiddleware(GetMessagesHandler(db), db)).Methods("GET")
	r.Handle("/posts", AuthMiddleware(GetPostsHandler(db), db)).Methods("GET")
	r.Handle("/post", AuthMiddleware(GetPostDetailsHandler(db), db)).Methods("GET")
	r.Handle("/comment", AuthMiddleware(CreateCommentHandler(db), db)).Methods("POST")
	r.Handle("/users", AuthMiddleware(GetAllUsersHandler(db), db)).Methods("GET")

	// Serve static files
	fs := http.FileServer(http.Dir("./static"))
	r.PathPrefix("/static/").Handler(http.StripPrefix("/static/", fs))

	// Serve index.html at root
	r.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./static/index2.html")
	})

	// Start server
	go handleMessages(db)
	go cleanupOldTypingStatus() // Add this line
	log.Println("Starting server on http://localhost:8080")
	err = http.ListenAndServe(":8080", r)
	if err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
