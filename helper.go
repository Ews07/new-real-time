package main

import "context"

type contextKey string

const userContextKey = contextKey("userUUID")

// Helper to get user UUID from context
func UserUUIDFromContext(ctx context.Context) (string, bool) {
	userUUID, ok := ctx.Value(userContextKey).(string)
	return userUUID, ok
}
