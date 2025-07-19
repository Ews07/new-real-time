let messagesOffset = 0
let chatWith = ""; // user UUID you're chatting with
let loading = false
const chatHistory = document.getElementById("chat-history")

function loadMessages() {
  if (loading) return
  loading = true

  fetch(`/messages?with=${chatWith}&offset=${messagesOffset}`, {
    method: "GET",
    credentials: "include",
  })
    .then((res) => res.json())
    .then((messages) => {
      messagesOffset += messages.length

      const oldHeight = chatHistory.scrollHeight

      messages.forEach((msg) => {
        const div = document.createElement("div")
        div.textContent = `${msg.from}: ${msg.content}`
        chatHistory.prepend(div)
      })

      // Restore scroll position
      chatHistory.scrollTop = chatHistory.scrollHeight - oldHeight

      loading = false;
    })
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
  chatWith = userUUID
  messagesOffset = 0
  chatHistory.innerHTML = ""
  loadMessages() // Load first 10 messages
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