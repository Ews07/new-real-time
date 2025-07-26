-- Updated schema.sql - Make sure column names match what we use in code

--Users table
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    nickname TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    age INTEGER NOT NULL,
    gender TEXT,
    first_name TEXT,
    last_name TEXT,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

--Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_uuid TEXT UNIQUE NOT NULL,
    user_uuid TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY(user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
);

-- Categories table
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
);

-- Posts table
CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_uuid TEXT UNIQUE NOT NULL,
    user_uuid TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
);

-- PostCategories (Many-to-Many relation)
CREATE TABLE IF NOT EXISTS post_categories (
    post_id INTEGER NOT NULL,
    category_id INTEGER NOT NULL,
    PRIMARY KEY (post_id, category_id),
    FOREIGN KEY(post_id) REFERENCES posts(id),
    FOREIGN KEY(category_id) REFERENCES categories(id)
);

-- Comments table
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_uuid TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY(user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
);

-- LikesDislikes table (for posts and comments)
CREATE TABLE IF NOT EXISTS likes_dislikes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_uuid TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK(target_type IN ('post','comment')),
    target_id INTEGER NOT NULL,
    is_like BOOLEAN NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_uuid, target_type, target_id),
    FOREIGN KEY(user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
);

-- FIXED: PrivateMessages table - using 'sent_at' to match the code
CREATE TABLE IF NOT EXISTS private_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    sender_uuid TEXT NOT NULL,
    receiver_uuid TEXT NOT NULL,
    content TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(sender_uuid) REFERENCES users(uuid) ON DELETE CASCADE,
    FOREIGN KEY(receiver_uuid) REFERENCES users(uuid) ON DELETE CASCADE
);

-- for better query performance
CREATE INDEX IF NOT EXISTS idx_private_messages_conversation 
ON private_messages(sender_uuid, receiver_uuid, sent_at);

CREATE INDEX IF NOT EXISTS idx_private_messages_sent_at 
ON private_messages(sent_at);