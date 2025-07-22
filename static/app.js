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
      allUsers = users
      console.log(allUsers)
      updateUserList()
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
  if (!chatWith) return

  fetch(`/messages?with=${chatWith}&offset=${messagesOffset}`, {
    credentials: "include"
  }).then(res => res.json())
    .then(messages => {
      messagesOffset += messages.length
      const chatHistory = document.getElementById("chat-history")
      messages.forEach(msg => {
        const div = document.createElement("div")
        div.textContent = `${msg.from === chatWith ? msg.from : "You"}: ${msg.content}`
        chatHistory.prepend(div)
      })
    })
}

// Render new incoming message
function renderIncomingMessage(msg) {
  if (msg.from !== chatWith && msg.to !== chatWith) return
  const div = document.createElement("div")
  div.textContent = `${msg.from === chatWith ? msg.from : "You"}: ${msg.content}`
  document.getElementById("chat-history").appendChild(div)
}

// Update online status and re-render
function renderOnlineUsers(onlineList) {
  allUsers.forEach(user => {
    user.isOnline = onlineList.some(u => u.UserUUID === user.uuid && u.IsOnline)
  })
  updateUserList()
}

// Render all users in the user list
function updateUserList() {
  const list = document.getElementById("all-users") // Match your HTML
  if (!list) {
    console.error("user-list element not found")
    return
  }
  list.innerHTML = ""

  allUsers.forEach(user => {
    if (user.uuid === currentUserUUID) return // skip self
    const li = document.createElement("li")
    li.innerHTML = `<span class="status">${user.isOnline ? "🟢" : "⚪"}</span> ${user.nickname}`
    li.onclick = () => openChat(user.uuid)
    list.appendChild(li)
  })
}


function loadPostFeed() {
  fetch(`/posts?offset=${postOffset}&limit=${postLimit}`, {
    credentials: "include",
  })
    .then(res => res.json())
    .then(posts => {
      const feed = document.getElementById("post-feed")
      console.log("postssss",posts)
      posts.forEach(p => {
        const div = document.createElement("div")
        div.className = "post-item"
        div.innerHTML = `<strong>${p.title}</strong><br>by ${p.nickname}<br><small>${new Date(p.created_at).toLocaleString()}</small>`
        div.onclick = () => openPostView(p.uuid)
        feed.appendChild(div)
        console.log("feed",feed);
        
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

