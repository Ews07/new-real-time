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
const postModal = document.getElementById('post-modal');
const modalCloseBtn = document.getElementById('modal-close-btn');
let currentCategory = "";
let isLoadingMessages = false;
let chatScrollHandlerAttached = false;


// Simple SPA router
function navigate(path) {
  window.history.pushState({}, "", path);
  renderRoute(path);
}

function renderRoute(path) {
  if (path === "/") {
    showChatUI();
  } else if (path === "/login") {
    showLoginUI();
  } else if (path === "/register") {
    showRegisterUI();
  } else {
    showNotFound(); // ✅ any unknown path
  }
}


// SPA View Switcher
function showLoginUI() {
  document.getElementById("login-section").style.display = "block"
  document.getElementById("register-section").style.display = "none"
  document.getElementById("forum-view").style.display = "none"
  document.getElementById("main-header").style.display = "none"
  document.getElementById("chat-popup").style.display = "none"
  document.getElementById("notification-popup").style.display = "none"
  document.getElementById("error-container").style.display = "none";
}

function showChatUI() {
  document.getElementById("error-container").style.display = "none";
  document.getElementById("login-section").style.display = "none"
  document.getElementById("register-section").style.display = "none"
  document.getElementById("main-header").style.display = "flex"
  document.getElementById("forum-view").style.display = "block"
  document.getElementById("chat-popup").style.display = "flex"
  document.getElementById("notification-popup").style.display = "flex"
  resetPostFeed()
  // fetchAllUsers()

  // Initialize chat input handlers
  initializeChatInput()

  // Set up scroll event for loading more messages
  setupChatScrollHandler()
  fetchCategories()
  populateCategoriesSelector()

}

function populateCategoriesSelector() {
  fetch("/categories", { credentials: "include" })
    .then(res => res.json())
    .then(categories => {
      const select = document.getElementById("post-categories-select");
      select.innerHTML = ""; // Clear existing options
      categories.forEach(cat => {
        const option = document.createElement("option");
        option.value = cat;
        option.textContent = cat;
        select.appendChild(option);
      });
    })
    .catch(err => {
      console.error("Error populating categories selector:", err);
    });
}


function showChatPopup() {
  const chatPopup = document.getElementById("chat-popup");
  chatPopup.classList.add("visible");
}

function hideChatPopup() {
  const chatPopup = document.getElementById("chat-popup");
  chatPopup.classList.remove("visible");

  // Clear chat state when closing
  chatWith = "";
  messagesOffset = 0;

  // Clear typing status
  clearTimeout(typingTimer);
  handleTypingStop();
  hideTypingIndicator();

  // Remove active state from user items
  document.querySelectorAll('.user-item').forEach(item => {
    item.classList.remove('active');
  });

  // Update popup title
  document.getElementById("chat-popup-title").textContent = "Select a user to chat";

  // Clear chat history
  document.getElementById("chat-history").innerHTML = "";
}

function updateChatPopupTitle(nickname) {
  document.getElementById("chat-popup-title").textContent = `Chat with ${nickname}`;
}

function setupChatScrollHandler() {
  if (chatScrollHandlerAttached) return; // Prevent duplicate binding
  chatScrollHandlerAttached = true;

  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) {
    console.error("chat-history element not found for scroll handler");
    return;
  }

  let debounceTimer;

  chatHistory.addEventListener("scroll", function () {
    if (chatHistory.scrollTop === 0 && chatWith && !isLoadingMessages) {
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
  // html escaping to prevent html injections
  const safeContent = msg.content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;");

  // Format the timestamp
  const time = new Date(msg.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  div.innerHTML = `
    <div class="message-author">${author}</div>
    <div class="message-content">${safeContent}</div>
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
  const toggleBtn = document.getElementById('toggle-theme-btn');
  if (toggleBtn) {
    const saved = localStorage.getItem('theme');
    if (saved === 'light') document.body.classList.add('light-mode');

    toggleBtn.addEventListener('click', () => {
      document.body.classList.toggle('light-mode');
      localStorage.setItem('theme', document.body.classList.contains('light-mode') ? 'light' : 'dark');
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
      updateWelcomeMessage(data.nickname);
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
  initializeChatInput();

  console.log("Application initialization complete");
})

function updateWelcomeMessage(nickname) {
  const welcomeElement = document.querySelector('#main-header .logo h4');
  console.log("Welcome msg ==== ", welcomeElement);

  if (welcomeElement) {
    welcomeElement.textContent = `${nickname}`;
  }
}

function showCustomNotification(title, message, senderUUID = null) {
  const notificationPopup = document.getElementById('notification-popup');
  const notificationTitle = document.getElementById('notification-title');
  const notificationMessage = document.getElementById('notification-message');

  if (!notificationPopup || !notificationTitle || !notificationMessage) {
    console.error("Notification elements not found!");
    return;
  }

  // Clear any existing timeout
  if (notificationTimeout) {
    clearTimeout(notificationTimeout);
  }

  // Remove any existing click listeners by cloning the element
  const newNotificationPopup = notificationPopup.cloneNode(true);
  notificationPopup.parentNode.replaceChild(newNotificationPopup, notificationPopup);

  // Get the new elements after replacement
  const newNotificationTitle = newNotificationPopup.querySelector('#notification-title');
  const newNotificationMessage = newNotificationPopup.querySelector('#notification-message');
  const newCloseBtn = newNotificationPopup.querySelector('#notification-close');

  // Populate the notification with the new message info
  newNotificationTitle.textContent = title;
  newNotificationMessage.textContent = message;

  // Always re-attach the close button listener
  if (newCloseBtn) {
    newCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent any other click handlers from firing
      newNotificationPopup.classList.remove('visible');
      if (notificationTimeout) {
        clearTimeout(notificationTimeout);
      }
    });
  }

  // Make the notification clickable if we have a sender UUID
  if (senderUUID) {
    newNotificationPopup.style.cursor = 'pointer';

    // Add click listener to the notification content area
    newNotificationPopup.addEventListener('click', (e) => {
      // Don't trigger if they clicked the close button
      if (e.target.id === 'notification-close' || e.target.closest('#notification-close')) {
        return;
      }

      console.log(`Opening chat with ${senderUUID} from notification click`);

      // Hide the notification
      newNotificationPopup.classList.remove('visible');

      // Clear timeout since we're manually hiding it
      if (notificationTimeout) {
        clearTimeout(notificationTimeout);
      }

      // Open the chat with the sender
      openChat(senderUUID);

      // Optional: Focus the chat input after opening
      setTimeout(() => {
        const chatInput = document.getElementById('chat-input');
        if (chatInput) {
          chatInput.focus();
        }
      }, 100);
    });
  } else {
    newNotificationPopup.style.cursor = 'default';
  }

  // Make it visible by adding the 'visible' class
  newNotificationPopup.classList.add('visible');

  // Set a timer to automatically hide the notification after 5 seconds
  notificationTimeout = setTimeout(() => {
    newNotificationPopup.classList.remove('visible');
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
          updateWelcomeMessage(data.nickname);
          showChatUI()
          connectWebSocket()
          // fetchAllUsers()
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

// //Fetch users
// function fetchAllUsers() {
//   fetch("/users", { credentials: "include" })
//     .then(res => res.json())
//     .then(users => {
//       allUsers = users.map(user => ({
//         uuid: user.uuid,
//         nickname: user.nickname,
//         isOnline: user.isOnline || false,
//         lastMessage: user.lastMessage || "",
//         lastMessageTime: user.lastMessageTime || null
//       }))
//       console.log("Fetched all users:", allUsers)
//       updateUserList()
//     })
//     .catch(err => {
//       console.error("Error fetching users:", err)
//     })
// }

// Logout
function logout() {
  fetch("/logout", {
    method: "POST",
    credentials: "include",
  }).then(() => {
    // Close WebSocket
    if (socket) {
      socket.close();
      socket = null;
    }

    // Reset app state
    currentUserUUID = "";
    chatWith = "";
    messagesOffset = 0;
    isCurrentlyTyping = false;
    typingUsers.clear();
    allUsers = [];

    // Clear chat history (only messages, keep structure intact)
    const chatHistory = document.getElementById("chat-history");
    if (chatHistory) {
      chatHistory.innerHTML = "";
    }

    // ✅ Always hide popup completely on logout
    hideChatPopup();

    // Reset user list
    const userList = document.getElementById("all-users");
    if (userList) {
      userList.innerHTML = "";
    }

    // Show login page
    showLoginUI();
  });
}



// WebSocket
function connectWebSocket() {
  // Cleanup old socket before making a new one
  if (socket) {
    try {
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    } catch (e) {
      console.warn("Error cleaning old socket:", e);
    }
    socket = null;
  }

  console.log("Attempting to connect WebSocket...");
  socket = new WebSocket("ws://localhost:8080/ws")

  socket.onopen = () => {
    console.log("WebSocket connected successfully")
  }

  socket.onmessage = function (event) {
    try {
      const data = JSON.parse(event.data);
      console.log("WebSocket message received:", data);

      if (data.type === "force_logout") {
        alert("You have been logged out.");
        currentUserUUID = "";
        allUsers = [];
        showLoginUI(); // Switch to login screen immediately
        return;
      } else if (data.type === "user_registered") {
        const u = data.user;
        const newUser = {
          uuid: u.user_uuid,
          nickname: u.nickname,
          isOnline: false,
          lastMessage: "",
          lastMessageTime: null
        };
        allUsers.push(newUser);
        updateUserList(data.users);
      } else if (data.type === "user_list") {
        renderOnlineUsers(data.users);
      } else if (data.type === "typing_start") {
        if (data.from === chatWith) {
          typingUsers.set(data.from, { nickname: data.nickname, isTyping: true });
          showTypingIndicator(data.nickname);
        }
      } else if (data.type === "typing_stop") {
        if (data.from === chatWith) {
          typingUsers.delete(data.from);
          hideTypingIndicator();
        }
      } else {
        if (data.from === chatWith) hideTypingIndicator();
        console.log("message dat in socket:::::", data);

        renderIncomingMessage(data);
      }
    } catch (error) {
      console.error("Error parsing WebSocket message:", error);
    }
  };

  socket.onerror = (error) => {
    console.error("WebSocket error:", error);
  };

  socket.onclose = (event) => {
    console.log("WebSocket closed. Code:", event.code, "Reason:", event.reason);
    setTimeout(connectWebSocket, 2000);
  };
}

// // Sending message
// document.getElementById("chat-input").addEventListener("keydown", function (e) {
//   if (e.key === "Enter") {
//     const content = this.value.trim()
//     if (!content || !chatWith) return
//     const msg = { to: chatWith, content: content }
//     socket.send(JSON.stringify(msg))
//     this.value = ""
//   }
// })

// Load Chat History
function openChat(userUUID) {
  console.log("Opening chat with user:", userUUID);

  if (!userUUID) {
    console.error("No userUUID provided to openChat");
    return;
  }
  // Find user nickname
  const user = allUsers.find(u => u.uuid === userUUID);
  const nickname = user ? user.nickname : "Unknown User";

  // Show chat popup
  showChatPopup();
  updateChatPopupTitle(nickname);

  // MODIFIED: Search both lists for the user item to remove unread indicator
  const onlineList = document.getElementById("online-users-list");
  const allUsersList = document.getElementById("all-users-list"); let userItem = onlineList.querySelector(`li[data-user-uuid="${userUUID}"]`);
  if (!userItem) {
    userItem = allUsersList.querySelector(`li[data-user-uuid="${userUUID}"]`);
  }
  if (userItem) {
    userItem.classList.remove('has-unread');
  }

  // Highlight active user in the list
  document.querySelectorAll('.user-item').forEach(item => {
    item.classList.remove('active');
  });

  // Re-select the correct user item after clearing all
  if (userItem) {
    userItem.classList.add('active');
  }


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
  if (!chatWith || isLoadingMessages) return;
  isLoadingMessages = true; // lock here

  console.log(`Loading messages with ${chatWith}, offset: ${messagesOffset}`);

  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) {
    console.error("chat-history element not found");
    isLoadingMessages = false
    return;
  }

  // const shouldScroll = chatHistory.scrollTop === 0;
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
    })
    .finally(() => {
      isLoadingMessages = false; // unlock after done
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
    console.log("message data in renderIncomingMessage", msg);

    // Auto-scroll to the bottom to show the new message
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }

  // PART 3: Handle all notifications for messages that are NOT from the current user.
  // This block runs for any message received from another person.
  if (msg.from !== currentUserUUID) {

    // MODIFIED: Find the user item in either the online or offline list
    const onlineList = document.getElementById("online-users-list");
    const allUsersList = document.getElementById("all-users-list"); let userItem = onlineList.querySelector(`li[data-user-uuid="${msg.from}"]`);
    if (!userItem) {
      userItem = allUsersList.querySelector(`li[data-user-uuid="${msg.from}"]`);
    }

    if (userItem) {
      userItem.classList.add('has-unread');
    }

    // 3b. If the chat with the sender is NOT the one that's currently open, show the pop-up notification.
    // This prevents a pop-up from appearing for a conversation you're actively viewing.
    if (!isRelevantToCurrentChat) {
      // Pass the sender UUID so the notification becomes clickable
      showCustomNotification(`New message from ${msg.from_nickname}`, msg.content, msg.from);
    }
  }
}


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


// MODIFIED: This function now separates users into online and offline lists.
function updateUserList() {
  const onlineList = document.getElementById("online-users-list");
  const allUsersList = document.getElementById("all-users-list");

  if (!onlineList || !allUsersList) {
    console.error("User list elements ('online-users-list' or 'all-users-list') not found");
    return;
  }

  onlineList.innerHTML = "";
  allUsersList.innerHTML = "";

  // 1. Filter out the current user from the main list
  const otherUsers = allUsers.filter(user => user.uuid !== currentUserUUID);

  // 2. Separate the remaining users into online and offline groups
  const onlineUsers = otherUsers.filter(user => user.isOnline);
  const allOtherUsers = [...otherUsers];
  // 3. Define a reusable sorting function
  const sortUsers = (a, b) => {
    const aHasMessage = a.lastMessage && a.lastMessageTime;
    const bHasMessage = b.lastMessage && b.lastMessageTime;

    if (aHasMessage && bHasMessage) {
      const timeA = new Date(a.lastMessageTime);
      const timeB = new Date(b.lastMessageTime);
      return timeB - timeA; // Sort by most recent message first
    }
    if (aHasMessage) return -1; // Users with messages come before users without
    if (bHasMessage) return 1;
    return a.nickname.localeCompare(b.nickname); // Fallback to alphabetical sorting
  };

  // 4. Sort both lists independently
  onlineUsers.sort(sortUsers);
  allOtherUsers.sort(sortUsers);

  // 5. Define a function to render a list of users into a given element
  const renderUserGroup = (users, element) => {
    if (users.length === 0) {
      const li = document.createElement("li");
      li.textContent = "None";
      li.style.padding = "var(--space-4)";
      li.style.color = "var(--text-muted)";
      element.appendChild(li);
      return;
    }

    users.forEach(user => {
      const li = document.createElement("li");
      li.classList.add("user-item");
      li.dataset.userUuid = user.uuid;

      // Status indicator (green for online, white for offline)
      const statusSpan = document.createElement("span");
      statusSpan.classList.add("status");
      statusSpan.textContent = user.isOnline ? "🟢" : "⚪";

      // Wrapper for nickname and message preview
      const userInfoDiv = document.createElement('div');
      userInfoDiv.style.display = 'flex';
      userInfoDiv.style.flexDirection = 'column';
      userInfoDiv.style.flex = 1; // Allow text to take up available space

      const nicknameSpan = document.createElement("span");
      nicknameSpan.classList.add("nickname");
      nicknameSpan.textContent = user.nickname;
      userInfoDiv.appendChild(nicknameSpan);

      // Display a preview of the last message if it exists
      if (user.lastMessage) {
        const previewSpan = document.createElement("span");
        previewSpan.classList.add("message-preview");
        const preview = user.lastMessage.length > 30 ?
          user.lastMessage.substring(0, 30) + "..." :
          user.lastMessage;
        previewSpan.textContent = preview;
        userInfoDiv.appendChild(previewSpan);
      }

      li.appendChild(statusSpan);
      li.appendChild(userInfoDiv);

      // Set click event to open chat with this user
      li.onclick = () => {
        openChat(user.uuid);
        showChatPopup();
      };

      // Highlight the user if they are the currently active chat partner
      if (user.uuid === chatWith) {
        li.classList.add('active');
      }

      element.appendChild(li);
    });
  };

  // 6. Render both the online and all user lists
  renderUserGroup(onlineUsers, onlineList);
  renderUserGroup(allOtherUsers, allUsersList);

  console.log(`Updated user list: ${onlineUsers.length} online, ${offlineUsers.length} offline.`);
}

function setupMessageInput() {
  const chatInput = document.getElementById("chat-input");
  if (!chatInput) {
    console.error("chat-input element not found");
    return;
  }
  const chatPopupClose = document.getElementById("chat-popup-close");
  if (chatPopupClose) {
    chatPopupClose.addEventListener("click", hideChatPopup);
  }

  // Track the last input content to detect changes
  let lastInputContent = "";
  let typingTimer = null;

  // Handle typing events
  chatInput.addEventListener("input", function (e) {
    if (!chatWith) return;

    const content = chatInput.value.trim();

    // Send typing_start only if content has changed and is non-empty
    if (content !== lastInputContent && content.length > 0 && !isCurrentlyTyping) {
      handleTypingStart();
      isCurrentlyTyping = true;
    } else if (content.length === 0 && isCurrentlyTyping) {
      handleTypingStop();
      isCurrentlyTyping = false;
    }

    // Update last known content
    lastInputContent = content;

    // Reset the typing stop timer
    clearTimeout(typingTimer);
    if (content.length > 0) {
      typingTimer = setTimeout(() => {
        handleTypingStop();
        isCurrentlyTyping = false;
        lastInputContent = chatInput.value.trim();
      }, 300); // 300ms delay for immediate stop
    }
  });

  // Handle keyup for faster typing stop detection
  chatInput.addEventListener("keyup", function (e) {
    if (!chatWith) return;

    const content = chatInput.value.trim();

    // Reset the typing stop timer
    clearTimeout(typingTimer);
    if (content.length > 0) {
      typingTimer = setTimeout(() => {
        handleTypingStop();
        isCurrentlyTyping = false;
        lastInputContent = chatInput.value.trim();
      }, 300); // 300ms delay for immediate stop
    } else if (isCurrentlyTyping) {
      handleTypingStop();
      isCurrentlyTyping = false;
      lastInputContent = "";
    }
  });

  // Handle blur to stop typing
  chatInput.addEventListener("blur", function (e) {
    if (!chatWith) return;
    clearTimeout(typingTimer);
    if (isCurrentlyTyping) {
      handleTypingStop();
      isCurrentlyTyping = false;
      lastInputContent = chatInput.value.trim();
    }
  });

  // Handle Enter key to send message
  chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();

      // Clear typing status immediately when sending message
      clearTimeout(typingTimer);
      if (isCurrentlyTyping) {
        handleTypingStop();
        isCurrentlyTyping = false;
      }

      const content = chatInput.value.trim();
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
      };

      console.log("Sending message:", msg);

      try {
        socket.send(JSON.stringify(msg));
        chatInput.value = "";
        lastInputContent = "";
        console.log("Message sent successfully");
      } catch (error) {
        console.error("Error sending message:", error);
        alert("Failed to send message. Please try again.");
      }
    }
  });

  setupChatScrollHandler();
}
// Call this function when the chat UI is shown
function initializeChatInput() {
  setupMessageInput();
}
function fetchCategories() {
  fetch("/categories", { credentials: "include" })
    .then(res => res.json())
    .then(categories => {
      const categoryFilter = document.getElementById("category-filter");
      categoryFilter.innerHTML = `
        <h4> CATEGORIES</h4 >
          <button class="category-btn active" data-category="">All Categories</button>
      `;

      categories.forEach(cat => {
        const btn = document.createElement("button");
        btn.className = "category-btn";
        btn.dataset.category = cat;
        btn.textContent = cat;
        btn.onclick = () => selectCategory(cat);
        categoryFilter.appendChild(btn);
      });

      const allBtn = categoryFilter.querySelector('button[data-category=""]');
      allBtn.onclick = () => selectCategory("");
    })
    .catch(err => {
      console.error("Error fetching categories:", err);
    });
}

function selectCategory(category) {
  currentCategory = category;
  postOffset = 0;
  document.getElementById("post-feed").innerHTML = "";
  loadPostFeed();

  const buttons = document.querySelectorAll(".category-btn");
  buttons.forEach(btn => {
    if (btn.dataset.category === category) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
}

function loadPostFeed() {
  let url = `/posts?offset=${postOffset}&limit=${postLimit}`;
  if (currentCategory) {
    url += `&category=${encodeURIComponent(currentCategory)}`;
  }

  fetch(url, {
    credentials: "include",
  })
    .then(res => res.json())
    .then(posts => {
      const feed = document.getElementById("post-feed");
      console.log("postssss", posts);
      posts.forEach(p => {
        const div = document.createElement("div");
        div.className = "post-item";
        const safeTitle = p.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeContent = p.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        div.innerHTML = `
          <strong>${safeTitle}</strong><br>
          by ${p.nickname}<br>
          <small>${new Date(p.created_at).toLocaleString()}</small><br>
          <small>Categories: ${p.categories ? p.categories.join(', ') : 'None'}</small>
          <p>${safeContent}</p>
        `;
        div.onclick = () => openPostView(p.uuid);
        feed.appendChild(div);
        console.log("feed", feed);
      });

      if (posts.length < postLimit) {
        document.getElementById("load-more-btn").style.display = "none";
      } else {
        document.getElementById("load-more-btn").style.display = "block";
      }

      postOffset += posts.length;
    })
    .catch(err => {
      console.error("Error loading posts:", err);
    });
}

let currentPostUUID = ""

function openPostView(uuid) {
  currentPostUUID = uuid

  fetch(`/post?uuid=${uuid}`, { credentials: "include" })
    .then(res => res.json())
    .then(data => {
      document.getElementById("modal-post-author").textContent = data.nickname;
      document.getElementById("modal-post-timestamp").textContent = new Date(data.created_at).toLocaleString();
      document.getElementById("modal-post-title").textContent = data.title;
      document.getElementById("modal-post-content").textContent = data.content;

      const commentsDiv = document.getElementById("modal-comments-list")
      commentsDiv.innerHTML = ""
      if (data.comments) {
        data.comments.forEach(c => {
          const d = document.createElement("div")
          d.className = "comment-item";
          const safeContent = c.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          d.innerHTML = `
          <div class="comment-body">
            <div class="comment-author">${c.author}</div>
            <div class="comment-content">${safeContent}</div>
          </div>
        `;
          commentsDiv.appendChild(d);
        })
      }
      postModal.classList.remove("hidden");
      document.body.classList.add("modal-open");
    })
}
function closePostModal() {
  postModal.classList.add("hidden");
  document.body.classList.remove("modal-open");
}

function backToFeed() {
  closePostModal()
}
modalCloseBtn.addEventListener('click', closePostModal);

postModal.addEventListener('click', (event) => {
  // Close modal if user clicks on the overlay (outside the content)
  if (event.target === postModal) {
    closePostModal();
  }
});

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
  const postForm = document.getElementById("post-form");
  if (!postForm) {
    console.error("post-form not found in DOM.");
    return;
  }

  const title = document.getElementById("post-title").value.trim();
  const content = document.getElementById("post-content").value.trim();
  const select = document.getElementById("post-categories-select");

  // Correctly get all selected categories from the new dropdown
  const categories = [...select.selectedOptions].map(option => option.value);

  if (!title || !content) {
    alert("Title and content are required.");
    return;
  }

  if (categories.length === 0) {
    alert("Please select at least one category.");
    return;
  }

  fetch("/posts", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, content, categories }),
  })
    .then(res => {
      if (!res.ok) {
        // If the server returns an error, show it to the user
        return res.text().then(text => { throw new Error(text) });
      }
      return res.text();
    })
    .then(() => {
      console.log("Post created successfully!");

      // 1. Clear the form fields correctly
      document.getElementById("post-title").value = "";
      document.getElementById("post-content").value = "";
      select.selectedIndex = -1; // This deselects all options in the dropdown

      // 2. Hide the form
      postForm.style.display = "none";

      // 3. Reset the category filter to "All" and reload the feed
      // This ensures your new post is visible regardless of the previous filter
      selectCategory("");
    })
    .catch(err => {
      // This will now catch the TypeError and any server errors
      console.error("Error posting:", err);
      alert("Error posting: " + err.message);
    });
}



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

function showNotFound() {
  const errorDiv = document.getElementById("error-container");
  errorDiv.style.display = "block";
  errorDiv.innerHTML = `
    <div class="error-page">
      <h1>404</h1>
      <p>Oops! The page you are looking for does not exist.</p>
      <button onclick="navigate('/')">Go Home</button>
    </div>
  `;

  // hide other sections
  document.getElementById("login-section").style.display = "none";
  document.getElementById("register-section").style.display = "none";
  document.getElementById("forum-view").style.display = "none";
}

function showServerError() {
  const errorDiv = document.getElementById("error-container");
  errorDiv.style.display = "block";
  errorDiv.innerHTML = `
    <div class="error-page">
      <h1>500</h1>
      <p>Something went wrong on our side. Please try again later.</p>
      <button onclick="navigate('/')">Go Home</button>
    </div>
  `;

  document.getElementById("login-section").style.display = "none";
  document.getElementById("register-section").style.display = "none";
  document.getElementById("forum-view").style.display = "none";
}

// Handle back/forward
window.addEventListener("popstate", () => {
  renderRoute(window.location.pathname);
});

// Initial load
document.addEventListener("DOMContentLoaded", () => {
  renderRoute(window.location.pathname);
});