let messagesOffset = 0
let chatWith = ""; // user UUID you're chatting with
let loading = false
const chatHistory = document.getElementById("chat-history")

function loadMessages() {
  if (!chatWith) {
    console.log("No chat selected")
    return;
  }

  if (loading) {
    console.log("Already loading messages")
    return;
  }

  loading = true;
  console.log(`Loading messages with ${chatWith}, offset: ${messagesOffset}`);

  const chatHistory = document.getElementById("chat-history");
  const shouldScroll = chatHistory.scrollTop === 0;

  fetch(`/messages?with=${chatWith}&offset=${messagesOffset}`, {
    method: "GET",
    credentials: "include"
  })
    .then(res => {
      console.log("Response status:", res.status);
      console.log("Response headers:", res.headers);

      if (!res.ok) {
        // Try to get error message from response
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

      if (!Array.isArray(messages)) {
        throw new Error("Expected array of messages but got: " + typeof messages);
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
        console.log("No more messages to load");
      }

      loading = false;
    })
    .catch(err => {
      console.error("Error loading messages:", err);
      loading = false;

      // Show user-friendly error message
      const errorDiv = document.createElement("div");
      errorDiv.style.color = "red";
      errorDiv.style.padding = "10px";
      errorDiv.style.textAlign = "center";
      errorDiv.textContent = "Failed to load messages: " + err.message;
      chatHistory.appendChild(errorDiv);
    });
}

// Scroll Trigger + Throttle
let debounceTimer

chatHistory.addEventListener("scroll", function () {
  if (chatHistory.scrollTop === 0) {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      loadMessages();
    }, 300) // 300ms debounce
  }
})

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
  const clickedUser = Array.from(document.querySelectorAll('.user-item')).find(item => {
    return item.onclick.toString().includes(userUUID);
  });
  if (clickedUser) {
    clickedUser.classList.add('active');
  }

  chatWith = userUUID;
  messagesOffset = 0;
  loading = false;

  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) {
    console.error("chat-history element not found");
    return;
  }

  chatHistory.innerHTML = "";

  // Show loading indicator
  const loadingDiv = document.createElement("div");
  loadingDiv.textContent = "Loading messages...";
  loadingDiv.style.textAlign = "center";
  loadingDiv.style.color = "#666";
  loadingDiv.style.padding = "20px";
  chatHistory.appendChild(loadingDiv);

  loadMessages();
}
//----------websocket-----------

let socket

//Connect WebSocket
function connectWebSocket() {
  socket = new WebSocket("ws://localhost:8080/ws")

  socket.onopen = () => {
    console.log("WebSocket connected")
  };

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data)

    if (data.type === "user_list") {
      renderOnlineUsers(data.users)
    } else {
      renderIncomingMessage(data)
    }
  }

  socket.onclose = () => {
    console.log("WebSocket closed. Reconnecting...")
    setTimeout(connectWebSocket, 2000); // retry
  };
}


const chatInput = document.getElementById("chat-input");

//Sending Messages via WebSocket
chatInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    const content = chatInput.value.trim()
    if (!content || !chatWith) return

    const msg = {
      to: chatWith,
      content: content,
    }

    socket.send(JSON.stringify(msg))
    chatInput.value = ""
  }
})

//Render Received Messages
function renderIncomingMessage(msg) {
  if (msg.from !== chatWith && msg.to !== chatWith) {
    // Optional: show notification if message is from another chat
    return
  }

  const div = document.createElement("div")
  div.textContent = `${msg.from === chatWith ? msg.from : "You"}: ${msg.content}`
  chatHistory.appendChild(div)

  // Scroll to bottom only if already near bottom
  if (chatHistory.scrollHeight - chatHistory.scrollTop < 300) {
    chatHistory.scrollTop = chatHistory.scrollHeight
  }
}

//Render Online Users List
function renderOnlineUsers(users) {
  const list = document.getElementById("online-users")
  list.innerHTML = ""

  users.sort((a, b) => {
    if (a.LastMessage && !b.LastMessage) return -1
    if (!a.LastMessage && b.LastMessage) return 1
    return a.UserUUID.localeCompare(b.UserUUID)
  })

  users.forEach((user) => {
    if (user.UserUUID === currentUserUUID) return

    const li = document.createElement("li")
    li.textContent = `${user.UserUUID} (${user.IsOnline ? "🟢" : "⚪️"})`

    li.onclick = () => {
      openChat(user.UserUUID)
    }

    list.appendChild(li)
  })
}