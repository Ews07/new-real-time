let socket = null
let chatWith = ""
let messagesOffset = 0
let currentUserUUID = ""
let postOffset = 0
const postLimit = 5
let allUsers = []


// SPA View Switcher
function showLoginUI() {
  document.getElementById("login-section").style.display = "block"
  document.getElementById("register-section").style.display = "none"
  document.getElementById("chat-section").style.display = "none"
}

function showChatUI() {
  document.getElementById("login-section").style.display = "none"
  document.getElementById("register-section").style.display = "none"
  document.getElementById("chat-section").style.display = "block"
  resetPostFeed()
  fetchAllUsers()
}
function createMessageElement(msg) {
  const div = document.createElement("div");
  div.classList.add("message-item");

  // Determine if the message is from the current user or someone else
  const isSelf = msg.from === currentUserUUID;
  const author = isSelf ? "You" : msg.from_nickname;

  div.classList.add(isSelf ? "self" : "other");

  // Format the timestamp
  const time = new Date(msg.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  div.innerHTML = `
    <div class="message-author">${author}</div>
    <div class="message-content">${msg.content}</div>
    <div class="message-time">${time}</div>
  `;
  return div;
}

// On Page Load
window.addEventListener("DOMContentLoaded", () => {
  // Check session
  fetch("/me", {
    method: "GET",
    credentials: "include"
  })
    .then(res => {
      if (!res.ok) throw new Error("Not logged in")
      return res.json()
    })
    .then(data => {
      currentUserUUID = data.user_uuid
      showChatUI()
      connectWebSocket()
    })
    .catch(() => {
      showLoginUI()
    })

  // Login form submit
  document.getElementById("login-form").addEventListener("submit", function (e) {
    e.preventDefault()
    login()
  })

  // Register form submit
  document.getElementById("register-form").addEventListener("submit", function (e) {
    e.preventDefault()
    register()
  })

  // Toggle between login/register
  const loginSection = document.getElementById("login-section")
  const registerSection = document.getElementById("register-section")
  const showRegisterBtn = document.getElementById("show-register")
  const showLoginBtn = document.getElementById("show-login")

  showRegisterBtn.addEventListener("click", () => {
    loginSection.style.display = "none"
    registerSection.style.display = "block"
  })

  showLoginBtn.addEventListener("click", () => {
    loginSection.style.display = "block"
    registerSection.style.display = "none"
  })

  document.getElementById("logout-btn").addEventListener("click", logout)

  document.getElementById("create-post-btn").addEventListener("click", () => {
    const form = document.getElementById("post-form")
    // if (form) {
    form.style.display = form.style.display === "none" ? "block" : "none"
    // }
  })
  document.getElementById("submit-post").addEventListener("click", submitPost)
})

// Login Logic
function login() {
  const identifier = document.getElementById("login-identifier").value.trim()
  const password = document.getElementById("login-password").value.trim()

  if (!identifier || !password) {
    alert("Please enter both identifier and password.")
    return
  }

  fetch("/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password })
  })
    .then(res => {
      if (!res.ok) throw new Error("Login failed")
      return res.text()
    })
    .then(() => {
      // Refetch user UUID and show chat
      fetch("/me", {
        method: "GET",
        credentials: "include"
      })
        .then(res => res.json())
        .then(data => {
          currentUserUUID = data.user_uuid
          showChatUI()
          connectWebSocket()
          fetchAllUsers()
        })
    })
    .catch(err => {
      alert("Login failed: " + err.message)
    })
}

// Register Logic
function register() {
  const data = {
    nickname: document.getElementById("reg-nickname").value,
    email: document.getElementById("reg-email").value,
    password: document.getElementById("reg-password").value,
    age: parseInt(document.getElementById("reg-age").value),
    gender: document.getElementById("reg-gender").value,
    first_name: document.getElementById("reg-first").value,
    last_name: document.getElementById("reg-last").value,
  }

  fetch("/register", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  }).then(res => {
    if (res.ok) {
      // alert("Registered! Now login.")
      showLoginUI()
    } else {
      res.text().then(alert)
    }
  })
}

//Fetch users
function fetchAllUsers() {
  fetch("/users", { credentials: "include" })
    .then(res => res.json())
    .then(users => {
      allUsers = users.map(user => ({
        uuid: user.uuid,
        nickname: user.nickname,
        isOnline: user.isOnline || false,
        lastMessage: "",
        lastMessageTime: null
      }))
      console.log("Fetched all users:", allUsers)
      updateUserList()
    })
    .catch(err => {
      console.error("Error fetching users:", err)
    })
}

// Logout
function logout() {
  fetch("/logout", {
    method: "POST",
    credentials: "include",
  }).then(() => {
    socket?.close()
    showLoginUI()
  })
}

// WebSocket
function connectWebSocket() {
  socket = new WebSocket("ws://localhost:8080/ws")

  socket.onopen = () => {
    console.log("WebSocket connected")
  }

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data)
    if (data.type === "user_list") {
      renderOnlineUsers(data.users)
    } else {
      renderIncomingMessage(data)
    }
  }

  socket.onclose = () => {
    console.log("Socket closed, retrying...")
    setTimeout(connectWebSocket, 2000)
  }
}

// Sending message
document.getElementById("chat-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    const content = this.value.trim()
    if (!content || !chatWith) return
    const msg = { to: chatWith, content: content }
    socket.send(JSON.stringify(msg))
    this.value = ""
  }
})

// Load Chat History
function openChat(userUUID) {
  chatWith = userUUID
  messagesOffset = 0
  const chatHistory = document.getElementById("chat-history")
  chatHistory.innerHTML = ""
  loadMessages()
}

function loadMessages() {
  if (!chatWith) return;

  console.log(`Loading messages with ${chatWith}, offset: ${messagesOffset}`);

  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) {
    console.error("chat-history element not found");
    return;
  }

  const shouldScroll = chatHistory.scrollTop === 0;

  fetch(`/messages?with=${chatWith}&offset=${messagesOffset}`, {
    method: "GET",
    credentials: "include"
  })
    .then(res => {
      console.log("Response status:", res.status);

      if (!res.ok) {
        return res.text().then(errorText => {
          throw new Error(`HTTP ${res.status}: ${errorText}`);
        });
      }

      // Check if response is JSON
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        return res.text().then(text => {
          throw new Error(`Expected JSON but got: ${text}`);
        });
      }

      return res.json();
    })
    .then(messages => {
      console.log("Received messages:", messages);

      // FIX: Handle null response or ensure it's an array
      if (!messages) {
        console.log("No messages returned (null response)");
        messages = []; // Convert null to empty array
      }

      if (!Array.isArray(messages)) {
        console.error("Expected array of messages but got:", typeof messages, messages);
        messages = []; // Convert non-array to empty array
      }

      if (messages.length > 0) {
        messagesOffset += messages.length;
        const oldHeight = chatHistory.scrollHeight;

        messages.forEach(msg => {
          const messageEl = createMessageElement(msg);
          chatHistory.prepend(messageEl); // Prepend to keep scroll position
        });

        // If we loaded messages by scrolling to the top, restore the view
        if (shouldScroll) {
          chatHistory.scrollTop = chatHistory.scrollHeight - oldHeight;
        }
      } else {
        console.log("No messages to load");
        // Remove any loading indicators
        const loadingDivs = chatHistory.querySelectorAll('div');
        loadingDivs.forEach(div => {
          if (div.textContent.includes('Loading messages...')) {
            div.remove();
          }
        });

        // Show "no messages" indicator if chat is empty
        if (chatHistory.children.length === 0) {
          const noMessagesDiv = document.createElement("div");
          noMessagesDiv.style.textAlign = "center";
          noMessagesDiv.style.color = "#666";
          noMessagesDiv.style.padding = "20px";
          noMessagesDiv.textContent = "No messages yet. Start the conversation!";
          chatHistory.appendChild(noMessagesDiv);
        }
      }
    })
    .catch(err => {
      console.error("Error loading messages:", err);

      // Remove loading indicator and show error
      const chatHistory = document.getElementById("chat-history");
      if (chatHistory) {
        // Remove loading divs
        const loadingDivs = chatHistory.querySelectorAll('div');
        loadingDivs.forEach(div => {
          if (div.textContent.includes('Loading messages...')) {
            div.remove();
          }
        });

        // Show error message
        const errorDiv = document.createElement("div");
        errorDiv.style.color = "red";
        errorDiv.style.padding = "10px";
        errorDiv.style.textAlign = "center";
        errorDiv.textContent = "Failed to load messages: " + err.message;
        chatHistory.appendChild(errorDiv);
      }
    });
}

// Render new incoming message
function renderIncomingMessage(msg) {
  // Only render if the message is for the currently active chat
  if (msg.from !== chatWith && msg.to !== chatWith) {
    // Optional: Add a notification for other chats here
    return;
  }

  const chatHistory = document.getElementById("chat-history");
  const messageEl = createMessageElement(msg);

  // Check if user is near the bottom of the chat before appending
  const isScrolledToBottom = chatHistory.scrollHeight - chatHistory.clientHeight <= chatHistory.scrollTop + 1;

  chatHistory.appendChild(messageEl);

  // Auto-scroll only if the user was already at the bottom
  if (isScrolledToBottom) {
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }
}

// Update online status and re-render
function renderOnlineUsers(users) {
  console.log("Received user list from WebSocket:", users)

  // Update our local allUsers array with the new data
  users.forEach(wsUser => {
    // Find existing user in allUsers array
    const existingUserIndex = allUsers.findIndex(u => u.uuid === wsUser.user_uuid)

    if (existingUserIndex !== -1) {
      // Update existing user
      allUsers[existingUserIndex].isOnline = wsUser.is_online
      allUsers[existingUserIndex].lastMessage = wsUser.last_message
      allUsers[existingUserIndex].lastMessageTime = wsUser.last_message_time
    } else {
      // Add new user if not found
      allUsers.push({
        uuid: wsUser.user_uuid,
        nickname: wsUser.nickname,
        isOnline: wsUser.is_online,
        lastMessage: wsUser.last_message,
        lastMessageTime: wsUser.last_message_time
      })
    }
  })

  // Re-render the user list
  updateUserList()
}

// Render all users in the user list
// Render all users in the user list with proper sorting
function updateUserList() {
  const list = document.getElementById("all-users")
  if (!list) {
    console.error("all-users element not found")
    return
  }

  list.innerHTML = ""

  // Filter out current user and sort the list
  const otherUsers = allUsers.filter(user => user.uuid !== currentUserUUID)

  // Sort users the same way as backend:
  // 1. Users with messages first (sorted by most recent message time)
  // 2. Users without messages second (sorted alphabetically by nickname)
  otherUsers.sort((a, b) => {
    const aHasMessage = a.lastMessage && a.lastMessageTime
    const bHasMessage = b.lastMessage && b.lastMessageTime

    // Both have messages - sort by most recent message time (newest first)
    if (aHasMessage && bHasMessage) {
      const timeA = new Date(a.lastMessageTime)
      const timeB = new Date(b.lastMessageTime)
      return timeB - timeA // Descending order (newest first)
    }

    // Only a has messages - a comes first
    if (aHasMessage && !bHasMessage) {
      return -1
    }

    // Only b has messages - b comes first  
    if (!aHasMessage && bHasMessage) {
      return 1
    }

    // Neither has messages - sort alphabetically by nickname
    return a.nickname.localeCompare(b.nickname)
  })

  otherUsers.forEach(user => {
    const li = document.createElement("li")
    li.classList.add("user-item")

    // Create status indicator
    const statusSpan = document.createElement("span")
    statusSpan.classList.add("status")
    statusSpan.textContent = user.isOnline ? "🟢" : "⚪"

    // Create nickname span
    const nicknameSpan = document.createElement("span")
    nicknameSpan.classList.add("nickname")
    nicknameSpan.textContent = user.nickname

    // Create last message preview (if exists)
    const previewSpan = document.createElement("span")
    previewSpan.classList.add("message-preview")
    if (user.lastMessage) {
      const preview = user.lastMessage.length > 30
        ? user.lastMessage.substring(0, 30) + "..."
        : user.lastMessage
      previewSpan.textContent = preview
    }

    // Assemble the list item
    li.appendChild(statusSpan)
    li.appendChild(nicknameSpan)
    if (user.lastMessage) {
      li.appendChild(document.createElement("br"))
      li.appendChild(previewSpan)
    }

    li.onclick = () => openChat(user.uuid)
    list.appendChild(li)
  })

  console.log("Updated user list with", otherUsers.length, "users")
}


function loadPostFeed() {
  fetch(`/posts?offset=${postOffset}&limit=${postLimit}`, {
    credentials: "include",
  })
    .then(res => res.json())
    .then(posts => {
      const feed = document.getElementById("post-feed")
      console.log("postssss", posts)
      posts.forEach(p => {
        const div = document.createElement("div")
        div.className = "post-item"
        div.innerHTML = `<strong>${p.title}</strong><br>by ${p.nickname}<br><small>${new Date(p.created_at).toLocaleString()}</small>`
        div.onclick = () => openPostView(p.uuid)
        feed.appendChild(div)
        console.log("feed", feed);

      })

      // Hide "Load More" if no more posts
      if (posts.length < postLimit) {
        document.getElementById("load-more-btn").style.display = "none"
      } else {
        document.getElementById("load-more-btn").style.display = "block"
      }

      postOffset += posts.length
    })
}


let currentPostUUID = ""

function openPostView(uuid) {
  currentPostUUID = uuid
  document.getElementById("post-feed").classList.add("hidden")
  document.getElementById("single-post-view").classList.remove("hidden")

  fetch(`/post?uuid=${uuid}`, { credentials: "include" })
    .then(res => res.json())
    .then(data => {
      document.getElementById("single-post-author").textContent = "Posted by:  " + data.nickname
      document.getElementById("single-post-title").textContent = data.title
      document.getElementById("single-post-content").textContent = data.content

      const commentsDiv = document.getElementById("comments-list")
      commentsDiv.innerHTML = ""
      data.comments.forEach(c => {
        const d = document.createElement("div")
        d.innerHTML = `<b>${c.author}</b>: ${c.content}<br><small>${new Date(c.created_at).toLocaleString()}</small>`
        commentsDiv.appendChild(d)
      })
    })
}

function backToFeed() {
  document.getElementById("post-feed").classList.remove("hidden")
  document.getElementById("single-post-view").classList.add("hidden")
  currentPostUUID = ""
}

// function submitPost() {
//   const title = document.getElementById("post-title").value.trim()
//   const content = document.getElementById("post-content").value.trim()
//   const categoryInput = document.getElementById("post-categories").value.trim()

//   if (!title || !content) {
//     alert("Title and content are required.")
//     return
//   }

//   const categories = categoryInput
//     .split(",")
//     .map(c => c.trim())
//     .filter(c => c.length > 0)

//   fetch("/posts", {
//     method: "POST",
//     credentials: "include",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({ title, content, categories })
//   })
//     .then(res => {
//       if (!res.ok) throw new Error("Post failed")
//       return res.text()
//     })
//     .then(() => {
//       alert("Post created!")
//       document.getElementById("post-title").value = ""
//       document.getElementById("post-content").value = ""
//       document.getElementById("post-categories").value = ""

//       const postForm = document.getElementById("post-form")
//       console.log("form element:", postForm) 
//       if (postForm && postForm.style) postForm.style.display = "none"

//       resetPostFeed()
//     })
//     .catch(err => {
//       alert("Error posting: " + err.message)
//     })
// }

function submitPost() {
  const postForm = document.getElementById("post-form")
  if (!postForm) {
    console.error("post-form not found in DOM.")
    alert("Post form not found. Are you logged in?")
    return
  }

  const title = document.getElementById("post-title").value.trim()
  const content = document.getElementById("post-content").value.trim()
  const categoryInput = document.getElementById("post-categories").value.trim()

  if (!title || !content) {
    alert("Title and content are required.")
    return
  }

  const categories = categoryInput
    .split(",")
    .map(c => c.trim())
    .filter(c => c.length > 0)

  fetch("/posts", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, content, categories }),
  })
    // console.log(title, content, categories)

    .then(res => {
      if (!res.ok) throw new Error("Post failed")
      return res.text()
    })
    .then(() => {
      alert("Post created!")
      document.getElementById("post-title").value = ""
      document.getElementById("post-content").value = ""
      document.getElementById("post-categories").value = ""
      console.log(postForm, postForm.style)

      if (postForm && postForm.style) postForm.style.display = "none"
      resetPostFeed()
    })
    .catch(err => {
      alert("Error posting: " + err.message)
    })
}



document.getElementById("submit-comment").addEventListener("click", () => {
  const content = document.getElementById("comment-text").value.trim()
  if (!content || !currentPostUUID) return alert("Cannot post empty comment")

  fetch("/comment", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ post_uuid: currentPostUUID, content })
  }).then(res => {
    if (res.ok) {
      document.getElementById("comment-text").value = ""
      openPostView(currentPostUUID) // reload comments
    } else {
      res.text().then(alert)
    }
  })
})

function resetPostFeed() {
  postOffset = 0
  document.getElementById("post-feed").innerHTML = ""
  document.getElementById("load-more-btn").style.display = "block"
  loadPostFeed()
}

