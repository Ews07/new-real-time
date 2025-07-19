package main

import (
	"context"
	"database/sql"
	"net/http"
)

// Session Middleware for Authentication
func AuthMiddleware(next http.Handler, db *sql.DB) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		//Session Cookie Check
		cookie, err := r.Cookie("session_token")
		if err != nil {
			http.Error(w, "Unauthorized: missing session token", http.StatusUnauthorized)
			return
		}
		//Session Validation
		session, err := GetSession(db, cookie.Value)
		if err != nil {
			http.Error(w, "Unauthorized: invalid or expired session", http.StatusUnauthorized)
			return
		}

		// Add user UUID to context
		ctx := context.WithValue(r.Context(), userContextKey, session.UserUUID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
