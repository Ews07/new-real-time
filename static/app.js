let socket = null
let chatWith = ""
let messagesOffset = 0
let currentUserUUID = ""
let postOffset = 0
const postLimit = 5
let allUsers = []
let notificationTimeout;
let typingTimer = null
let isCurrentlyTyping = false
let typingUsers = new Map() // Map of userUUID -> {nickname, isTyping}


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

  // Initialize chat input handlers
  initializeChatInput()

  // Set up scroll event for loading more messages
  setupChatScrollHandler()
}
function setupChatScrollHandler() {
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) {
    console.error("chat-history element not found for scroll handler");
    return;
  }

  let debounceTimer;

  chatHistory.addEventListener("scroll", function () {
    if (chatHistory.scrollTop === 0 && chatWith) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log("Loading more messages due to scroll");
        loadMessages();
      }, 300); // 300ms debounce
    }
  });
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
  console.log("DOM loaded, initializing application...");
  const notificationPopup = document.getElementById('notification-popup');
  const notificationCloseBtn = document.getElementById('notification-close');

  if (notificationCloseBtn && notificationPopup) {
    notificationCloseBtn.addEventListener('click', () => {
      notificationPopup.classList.remove('visible');
      // If the user closes it manually, cancel the auto-hide timer
      if (notificationTimeout) {
        clearTimeout(notificationTimeout);
      }
    });
  }

  // Check session first
  fetch("/me", {
    method: "GET",
    credentials: "include"
  })
    .then(res => {
      if (!res.ok) throw new Error("Not logged in")
      return res.json()
    })
    .then(data => {
      console.log("User authenticated:", data);
      currentUserUUID = data.user_uuid
      showChatUI()
      connectWebSocket()
    })
    .catch((error) => {
      console.log("User not authenticated:", error);
      showLoginUI()
    })

  // Login form submit
  const loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", function (e) {
      e.preventDefault()
      login()
    })
  }

  // Register form submit  
  const registerForm = document.getElementById("register-form");
  if (registerForm) {
    registerForm.addEventListener("submit", function (e) {
      e.preventDefault()
      register()
    })
  }

  // Toggle between login/register
  const loginSection = document.getElementById("login-section")
  const registerSection = document.getElementById("register-section")
  const showRegisterBtn = document.getElementById("show-register")
  const showLoginBtn = document.getElementById("show-login")

  if (showRegisterBtn) {
    showRegisterBtn.addEventListener("click", () => {
      loginSection.style.display = "none"
      registerSection.style.display = "block"
    })
  }

  if (showLoginBtn) {
    showLoginBtn.addEventListener("click", () => {
      loginSection.style.display = "block"
      registerSection.style.display = "none"
    })
  }

  // Logout button
  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", logout)
  }

  // Create post button
  const createPostBtn = document.getElementById("create-post-btn");
  if (createPostBtn) {
    createPostBtn.addEventListener("click", () => {
      const form = document.getElementById("post-form")
      if (form) {
        form.style.display = form.style.display === "none" ? "block" : "none"
      }
    })
  }

  // Submit post button
  const submitPostBtn = document.getElementById("submit-post");
  if (submitPostBtn) {
    submitPostBtn.addEventListener("click", submitPost)
  }

  // Submit comment button
  const submitCommentBtn = document.getElementById("submit-comment");
  if (submitCommentBtn) {
    submitCommentBtn.addEventListener("click", () => {
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
  }

  console.log("Application initialization complete");
})

function showCustomNotification(title, message) {
  const notificationPopup = document.getElementById('notification-popup');
  const notificationTitle = document.getElementById('notification-title');
  const notificationMessage = document.getElementById('notification-message');

  if (!notificationPopup || !notificationTitle || !notificationMessage) {
    console.error("Notification elements not found!");
    return;
  }

  // Populate the notification with the new message info
  notificationTitle.textContent = title;
  notificationMessage.textContent = message;

  // Make it visible by adding the 'visible' class
  notificationPopup.classList.add('visible');

  // If a notification is already showing, reset its hide timer
  if (notificationTimeout) {
    clearTimeout(notificationTimeout);
  }

  // Set a timer to automatically hide the notification after 5 seconds
  notificationTimeout = setTimeout(() => {
    notificationPopup.classList.remove('visible');
  }, 5000);
}

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
  console.log("Attempting to connect WebSocket...");
  socket = new WebSocket("ws://localhost:8080/ws")

  socket.onopen = () => {
    console.log("WebSocket connected successfully")
  }

  socket.onmessage = (event) => {
    console.log("WebSocket message received:", event.data);

    try {
      const data = JSON.parse(event.data)
      console.log("Parsed WebSocket data:", data);

      if (data.type === "user_list") {
        console.log("Received user list update");
        renderOnlineUsers(data.users)
      } else if (data.type === "typing_start") {
        console.log("User started typing:", data.nickname);
        // Only show typing indicator if it's from the current chat partner
        if (data.from === chatWith) {
          typingUsers.set(data.from, { nickname: data.nickname, isTyping: true });
          showTypingIndicator(data.nickname);
        }
      } else if (data.type === "typing_stop") {
        console.log("User stopped typing:", data.nickname);
        // Only hide typing indicator if it's from the current chat partner
        if (data.from === chatWith) {
          typingUsers.delete(data.from);
          hideTypingIndicator();
        }
      } else {
        console.log("Received chat message");
        // This is a chat message - hide typing indicator when message arrives
        if (data.from === chatWith) {
          hideTypingIndicator();
        }
        renderIncomingMessage(data)
      }
    } catch (error) {
      console.error("Error parsing WebSocket message:", error);
    }
  }

  socket.onerror = (error) => {
    console.error("WebSocket error:", error);
  }

  socket.onclose = (event) => {
    console.log("WebSocket closed. Code:", event.code, "Reason:", event.reason);
    console.log("Attempting to reconnect in 2 seconds...");
    setTimeout(connectWebSocket, 2000);
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
  console.log("Opening chat with user:", userUUID);

  if (!userUUID) {
    console.error("No userUUID provided to openChat");
    return;
  }

  // Highlight active user in the list
  document.querySelectorAll('.user-item').forEach(item => {
    item.classList.remove('active');
  });

  // Find and highlight the clicked user
  const userItems = document.querySelectorAll('.user-item');
  userItems.forEach(item => {
    // Check if this item's onclick contains the userUUID
    if (item.onclick && item.onclick.toString().includes(userUUID)) {
      item.classList.add('active');
    }
  });

  // Set the chat target
  chatWith = userUUID;
  messagesOffset = 0;

  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) {
    console.error("chat-history element not found");
    return;
  }

  // Clear chat history
  chatHistory.innerHTML = "";

  // Show loading indicator
  const loadingDiv = document.createElement("div");
  loadingDiv.textContent = "Loading messages...";
  loadingDiv.style.textAlign = "center";
  loadingDiv.style.color = "#666";
  loadingDiv.style.padding = "20px";
  loadingDiv.classList.add('loading-indicator'); // Add class for easy removal
  chatHistory.appendChild(loadingDiv);

  hideTypingIndicator();
  clearTimeout(typingTimer);
  handleTypingStop();

  // Load messages
  loadMessages();
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
  const isFirstLoad = messagesOffset === 0;

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

      // Handle null response or ensure it's an array
      if (!messages) {
        console.log("No messages returned (null response)");
        messages = [];
      }

      if (!Array.isArray(messages)) {
        console.error("Expected array of messages but got:", typeof messages, messages);
        messages = [];
      }

      // Remove loading indicator
      const loadingIndicators = chatHistory.querySelectorAll('.loading-indicator');
      loadingIndicators.forEach(indicator => indicator.remove());

      if (messages.length > 0) {
        messagesOffset += messages.length;

        if (isFirstLoad) {
          // First load: append messages in the order they come (oldest to newest)
          messages.forEach(msg => {
            const messageEl = createMessageElement(msg);
            chatHistory.appendChild(messageEl);
          });

          // Scroll to bottom for first load
          chatHistory.scrollTop = chatHistory.scrollHeight;
        } else {
          // Pagination load: prepend messages to top (but reverse them first since they come newest-first from DB)
          const oldHeight = chatHistory.scrollHeight;

          // Reverse the messages array since DB gives us newest-first but we want to prepend oldest-first
          messages.reverse().forEach(msg => {
            const messageEl = createMessageElement(msg);
            chatHistory.prepend(messageEl);
          });

          // Restore scroll position
          chatHistory.scrollTop = chatHistory.scrollHeight - oldHeight;
        }
      } else {
        console.log("No messages to load");

        // Show "no messages" indicator if chat is empty and this is the first load
        if (chatHistory.children.length === 0 && messagesOffset === 0) {
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

      // Remove loading indicator
      const loadingIndicators = chatHistory.querySelectorAll('.loading-indicator');
      loadingIndicators.forEach(indicator => indicator.remove());

      // Show error message
      const errorDiv = document.createElement("div");
      errorDiv.style.color = "red";
      errorDiv.style.padding = "10px";
      errorDiv.style.textAlign = "center";
      errorDiv.textContent = "Failed to load messages: " + err.message;
      chatHistory.appendChild(errorDiv);
    });
}
// Render new incoming message
function renderIncomingMessage(msg) {
  // PART 1: Determine if the message belongs to the chat window that is currently open.
  const isRelevantToCurrentChat =
    (msg.from === chatWith && msg.to === currentUserUUID) ||
    (msg.from === currentUserUUID && msg.to === chatWith);

  // PART 2: If the chat IS open, just append the new message to the history.
  // This is the simplest case. We don't need notifications if the user is already looking at the conversation.
  if (chatWith && isRelevantToCurrentChat) {
    const chatHistory = document.getElementById("chat-history");
    if (!chatHistory) return; // Safety check

    const messageEl = createMessageElement(msg);
    chatHistory.appendChild(messageEl);

    // Auto-scroll to the bottom to show the new message
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }

  // PART 3: Handle all notifications for messages that are NOT from the current user.
  // This block runs for any message received from another person.
  if (msg.from !== currentUserUUID) {

    // 3a. Add the persistent "unread dot" indicator to the user in the list.
    // This happens whether the pop-up appears or not. It marks the conversation as having new messages.
    const userList = document.getElementById("all-users");
    const userItem = userList.querySelector(`li[data-user-uuid="${msg.from}"]`);
    if (userItem) {
      userItem.classList.add('has-unread');
    }

    // 3b. If the chat with the sender is NOT the one that's currently open, show the pop-up notification.
    // This prevents a pop-up from appearing for a conversation you're actively viewing.
    if (!isRelevantToCurrentChat) {
      showCustomNotification(`New message from ${msg.from_nickname}`, msg.content);
    }
  }
}

// function showMessageNotification(msg) {
//   // Simple notification - you can make this more sophisticated
//   alert(`New message from ${msg.from_nickname}: ${msg.content}`);

//   // You could add a visual notification here, like:
//   // - A badge next to the user's name
//   // - A toast notification
//   // - Sound notification
//   // For now, just console log
// }

// Update online status and re-render
function renderOnlineUsers(users) {
  console.log("Rendering online users:", users)

  // Update our local allUsers array with the new data
  users.forEach(wsUser => {
    const existingUserIndex = allUsers.findIndex(u => u.uuid === wsUser.user_uuid)

    if (existingUserIndex !== -1) {
      // Update existing user
      allUsers[existingUserIndex].isOnline = wsUser.is_online
      allUsers[existingUserIndex].lastMessage = wsUser.last_message || ""
      allUsers[existingUserIndex].lastMessageTime = wsUser.last_message_time
      console.log(`Updated user ${wsUser.nickname}:`, allUsers[existingUserIndex]);
    } else {
      // Add new user if not found
      const newUser = {
        uuid: wsUser.user_uuid,
        nickname: wsUser.nickname,
        isOnline: wsUser.is_online,
        lastMessage: wsUser.last_message || "",
        lastMessageTime: wsUser.last_message_time
      };
      allUsers.push(newUser);
      console.log(`Added new user ${wsUser.nickname}:`, newUser);
    }
  })

  // Re-render the user list
  updateUserList()
  // showMessageNotification()
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
  console.log("Other users to display:", otherUsers);

  // Sort users the same way as backend
  otherUsers.sort((a, b) => {
    const aHasMessage = a.lastMessage && a.lastMessageTime
    const bHasMessage = b.lastMessage && b.lastMessageTime

    if (aHasMessage && bHasMessage) {
      const timeA = new Date(a.lastMessageTime)
      const timeB = new Date(b.lastMessageTime)
      return timeB - timeA
    }

    if (aHasMessage && !bHasMessage) {
      return -1
    }

    if (!aHasMessage && bHasMessage) {
      return 1
    }

    return a.nickname.localeCompare(b.nickname)
  })

  otherUsers.forEach(user => {
    const li = document.createElement("li")
    li.classList.add("user-item")

    // Store user UUID as data attribute for easy access
    li.dataset.userUuid = user.uuid;

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

    // Add click handler
    li.onclick = () => {
      console.log("User clicked:", user.nickname, user.uuid);
      openChat(user.uuid);
    }

    // Highlight if this is the currently active chat
    if (user.uuid === chatWith) {
      li.classList.add('active');
    }

    list.appendChild(li)
  })

  console.log("Updated user list with", otherUsers.length, "users")
}
function setupMessageInput() {
  const chatInput = document.getElementById("chat-input");
  if (!chatInput) {
    console.error("chat-input element not found");
    return;
  }

  // Handle typing events
  // NEW CODE - More responsive typing detection:
  chatInput.addEventListener("input", function (e) {
    if (!chatWith) return;

    const content = chatInput.value.trim();

    if (content.length > 0) {
      handleTypingStart();
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        handleTypingStop();
      }, 300); // Reduced to 300ms for immediate response
    } else {
      clearTimeout(typingTimer);
      handleTypingStop();
    }
  });

  // ADD THIS NEW EVENT LISTENER after the input listener:
  chatInput.addEventListener("keyup", function (e) {
    if (!chatWith) return;

    clearTimeout(typingTimer);
    const content = chatInput.value.trim();

    if (content.length > 0) {
      typingTimer = setTimeout(() => {
        handleTypingStop();
      }, 300); // Very short delay - almost immediate
    } else {
      handleTypingStop();
    }
  });

  // Handle focus events
  chatInput.addEventListener("focus", function (e) {
    if (!chatWith) return;
    // Optional: Could send typing_start on focus if there's content
    const content = chatInput.value.trim();
    if (content.length > 0) {
      handleTypingStart();
    }
  });

  chatInput.addEventListener("blur", function (e) {
    // User left the input field, stop typing
    clearTimeout(typingTimer);
    handleTypingStop();
  });

  chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();

      // Clear typing status immediately when sending message
      clearTimeout(typingTimer);
      handleTypingStop();

      const content = chatInput.value.trim()
      if (!content) {
        console.log("Empty message, not sending");
        return;
      }

      if (!chatWith) {
        console.log("No chat target selected");
        alert("Please select a user to chat with first");
        return;
      }

      if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.error("WebSocket is not connected");
        alert("Connection lost. Please refresh the page.");
        return;
      }

      const msg = {
        to: chatWith,
        content: content,
      }

      console.log("Sending message:", msg);

      try {
        socket.send(JSON.stringify(msg))
        chatInput.value = ""
        console.log("Message sent successfully");
      } catch (error) {
        console.error("Error sending message:", error);
        alert("Failed to send message. Please try again.");
      }
    }
  })
}
// Call this function when the chat UI is shown
function initializeChatInput() {
  setupMessageInput();
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

// Typing functionality
function handleTypingStart() {
  if (!chatWith || isCurrentlyTyping) return;

  isCurrentlyTyping = true;

  const typingMsg = {
    type: "typing_start",
    to: chatWith
  };

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(typingMsg));
    console.log("Sent typing_start to", chatWith);
  }
}

function handleTypingStop() {
  if (!chatWith || !isCurrentlyTyping) return;

  isCurrentlyTyping = false;

  const typingMsg = {
    type: "typing_stop",
    to: chatWith
  };

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(typingMsg));
    console.log("Sent typing_stop to", chatWith);
  }
}

function showTypingIndicator(nickname) {
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) return;

  // Remove any existing typing indicators
  const existingIndicator = chatHistory.querySelector('.typing-indicator');
  if (existingIndicator) {
    existingIndicator.remove();
  }

  // Create new typing indicator
  const typingDiv = document.createElement("div");
  typingDiv.classList.add("typing-indicator");
  typingDiv.innerHTML = `
        <div class="typing-message">
            <span class="typing-user">${nickname}</span> is typing
            <div class="typing-dots">
                <span></span>
                <span></span>
                <span></span>
            </div>
        </div>
    `;

  chatHistory.appendChild(typingDiv);
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

function hideTypingIndicator() {
  const typingIndicator = document.querySelector('.typing-indicator');
  if (typingIndicator) {
    typingIndicator.remove();
  }
}