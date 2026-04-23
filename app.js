// =====================================================
// Baron — MyCU Virtual Assistant (frontend)
// =====================================================
// ChatGPT-style widget for the MyCU dashboard. Talks to
// the local Node server at /api/chat.
// =====================================================

(() => {
  "use strict";

  // If the page is served by our own Node server, same-origin works.
  // If opened as a plain file://, fall back to localhost.
  const OPENED_AS_FILE = location.protocol === "file:" || !location.host;
  const BACKEND_BASE = OPENED_AS_FILE ? "http://localhost:3000" : location.origin;
  const CHAT_URL   = BACKEND_BASE + "/api/chat";
  const RESET_URL  = BACKEND_BASE + "/api/reset";
  const HEALTH_URL = BACKEND_BASE + "/api/health";

  // Cached connectivity status so we don't ping before every message.
  let serverReachable = null;  // null = unknown, true/false once tested

  async function pingServer() {
    try {
      const res = await fetch(HEALTH_URL, { method: "GET", cache: "no-store" });
      if (!res.ok) return { ok: false, reason: "HTTP " + res.status };
      const data = await res.json().catch(() => ({}));
      return { ok: true, data };
    } catch (err) {
      return { ok: false, reason: (err && err.message) || "network error" };
    }
  }

  const WELCOME =
    "Hi! I'm **Baron**, your MyCU assistant. I can help you navigate the " +
    "portal, find forms, reset your password, register for courses, and " +
    "answer questions about Carolina University. What can I help you with?";

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    const trigger = document.getElementById("chat-trigger");
    const chatbox = document.getElementById("chatbox");
    const closeBtn = document.getElementById("chat-close");
    const resetBtn = document.getElementById("chat-reset");
    const messages = document.getElementById("messages");
    const form = document.getElementById("chat-form");
    const input = document.getElementById("chat-text");
    const quick = document.getElementById("quick-actions");

    if (!trigger || !chatbox || !form || !input || !messages) {
      console.error("[Baron] required elements missing");
      return;
    }

    // Show the file:// warning banner if the page wasn't loaded via
    // the Node server. This is the single biggest cause of "the server
    // isn't connected" reports.
    if (OPENED_AS_FILE) {
      const banner = document.getElementById("file-warning");
      if (banner) banner.hidden = false;
    }

    // Session id persists across reloads in the same tab
    let sessionId = sessionStorage.getItem("baron-session");
    if (!sessionId) {
      sessionId = "s_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem("baron-session", sessionId);
    }

    let welcomed = false;
    let sending = false;

    // ----- OPEN / CLOSE -----
    async function openChat() {
      chatbox.classList.add("active");
      chatbox.setAttribute("aria-hidden", "false");
      if (!welcomed) {
        appendMessage("bot", WELCOME);
        welcomed = true;

        // First-open connectivity check, so the user sees a clear
        // warning immediately if the backend isn't reachable —
        // instead of a mysterious error after the first message.
        const typing = appendTyping();
        const ping = await pingServer();
        typing.remove();
        serverReachable = ping.ok;
        if (!ping.ok) {
          appendMessage("bot", buildConnectionHelp(ping.reason));
        }
      }
      setTimeout(() => input.focus(), 250);
    }

    function buildConnectionHelp(reason) {
      const lines = [
        "**I can't reach the Baron server.** (" + (reason || "unknown error") + ")",
        "",
        "Please try this:",
        "1. Make sure the backend is running — in a terminal, go to the project folder and run `npm install` then `npm start`.",
        "2. Open the dashboard at **" + BACKEND_BASE + "** in your browser (not by double-clicking `index.html`).",
        "3. If port 3000 is in use, start the server with `PORT=3001 npm start` and open http://localhost:3001 instead."
      ];
      if (OPENED_AS_FILE) {
        lines.splice(
          1, 0,
          "",
          "It looks like you opened this page directly from your files (file://). " +
          "Modern browsers block that page from talking to `http://localhost`. " +
          "Open **" + BACKEND_BASE + "** in your browser instead."
        );
      }
      return lines.join("\n");
    }
    function closeChat() {
      chatbox.classList.remove("active");
      chatbox.setAttribute("aria-hidden", "true");
    }
    function toggleChat() {
      chatbox.classList.contains("active") ? closeChat() : openChat();
    }

    trigger.addEventListener("click", toggleChat);
    if (closeBtn) closeBtn.addEventListener("click", closeChat);

    // ----- RESET -----
    if (resetBtn) {
      resetBtn.addEventListener("click", async () => {
        try {
          await fetch(RESET_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId })
          });
        } catch (_) {
          // non-fatal
        }
        messages.innerHTML = "";
        welcomed = false;
        appendMessage("bot", WELCOME);
        welcomed = true;
        if (quick) quick.classList.remove("hidden");
        input.focus();
      });
    }

    // ----- INPUT UX -----
    function autoGrow() {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 120) + "px";
    }
    input.addEventListener("input", autoGrow);

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    if (quick) {
      quick.addEventListener("click", (e) => {
        const btn = e.target.closest(".chip");
        if (!btn) return;
        const q = btn.getAttribute("data-q");
        if (!q) return;
        input.value = q;
        autoGrow();
        form.requestSubmit();
      });
    }

    // ----- SUBMIT -----
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (sending) return;

      const text = input.value.trim();
      if (!text) return;

      appendMessage("user", text);
      input.value = "";
      autoGrow();
      hideQuickActions();

      const typing = appendTyping();
      sending = true;

      try {
        const res = await fetch(CHAT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, sessionId })
        });

        let reply = "";
        let sources = [];
        let usedSearch = false;
        try {
          const data = await res.json();
          reply = (data && data.reply) || "";
          sources = (data && Array.isArray(data.sources)) ? data.sources : [];
          usedSearch = Boolean(data && data.usedSearch);
        } catch {
          reply = "";
        }

        typing.remove();
        serverReachable = true;

        if (!reply) {
          if (!res.ok) {
            appendMessage(
              "bot",
              "The server returned an error (HTTP " + res.status + "). " +
              "Please check the terminal running `npm start` for details."
            );
          } else {
            appendMessage(
              "bot",
              "I got an empty response from the server. That usually means the " +
              "OpenAI API key is missing, invalid, or out of quota. Check your `.env` file and try again."
            );
          }
        } else {
          appendMessage("bot", reply, { sources, usedSearch });
        }
      } catch (err) {
        typing.remove();
        serverReachable = false;
        const reason = (err && err.message) || "network error";
        appendMessage("bot", buildConnectionHelp(reason));
      } finally {
        sending = false;
        input.focus();
      }
    });

    // ----- RENDERING -----
    function appendMessage(role, text, opts) {
      const wrap = document.createElement("div");
      wrap.className = "msg msg--" + (role === "user" ? "user" : "bot");
      const body = document.createElement("div");
      body.className = "msg__body";
      body.innerHTML = renderMarkdown(String(text == null ? "" : text));

      // Add a sources footer for bot messages that used web search.
      if (role !== "user" && opts && Array.isArray(opts.sources) && opts.sources.length) {
        const footer = document.createElement("div");
        footer.className = "msg__sources";
        const label = document.createElement("span");
        label.className = "msg__sources-label";
        label.textContent = "Sources: ";
        footer.appendChild(label);
        opts.sources.forEach((s, i) => {
          if (!s || !s.link) return;
          const a = document.createElement("a");
          a.href = s.link;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = (i + 1) + ". " + (s.title || s.link);
          footer.appendChild(a);
        });
        body.appendChild(footer);
      }

      wrap.appendChild(body);
      messages.appendChild(wrap);
      messages.scrollTop = messages.scrollHeight;
      return wrap;
    }

    function appendTyping() {
      const wrap = document.createElement("div");
      wrap.className = "msg msg--bot msg--typing";
      wrap.innerHTML =
        '<div class="msg__body"><span class="typing"><i></i><i></i><i></i></span></div>';
      messages.appendChild(wrap);
      messages.scrollTop = messages.scrollHeight;
      return wrap;
    }

    function hideQuickActions() {
      if (!quick) return;
      quick.classList.add("hidden");
    }

    // ----- SAFE MARKDOWN-LITE -----
    function renderMarkdown(raw) {
      let s = escapeHtml(raw);

      // Code spans
      s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");

      // Bold **text**
      s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      // Italic *text*
      s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?;:]|$)/g, "$1<em>$2</em>");

      // [label](url) — render BEFORE autolinker so it doesn't clobber them.
      s = s.replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_m, label, url) =>
          '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
      );

      // Auto-link bare http(s) URLs that aren't already inside an <a>.
      s = s.replace(
        /(^|[\s>])(https?:\/\/[^\s<]+)/g,
        (_m, pre, url) =>
          pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>'
      );

      // Lists
      const lines = s.split("\n");
      const out = [];
      let listType = null;
      const flush = () => {
        if (listType) {
          out.push("</" + listType + ">");
          listType = null;
        }
      };
      for (const ln of lines) {
        const ul = /^\s*[-•]\s+(.*)$/.exec(ln);
        const ol = /^\s*\d+\.\s+(.*)$/.exec(ln);
        if (ul) {
          if (listType !== "ul") { flush(); out.push("<ul>"); listType = "ul"; }
          out.push("<li>" + ul[1] + "</li>");
        } else if (ol) {
          if (listType !== "ol") { flush(); out.push("<ol>"); listType = "ol"; }
          out.push("<li>" + ol[1] + "</li>");
        } else {
          flush();
          out.push(ln);
        }
      }
      flush();
      s = out.join("\n");

      // Paragraph breaks / single line breaks
      s = s
        .split(/\n{2,}/)
        .map((block) =>
          /^\s*<(ul|ol|pre|h\d)/.test(block)
            ? block
            : "<p>" + block.replace(/\n/g, "<br>") + "</p>"
        )
        .join("");

      return s;
    }

    function escapeHtml(str) {
      return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }
  }
})();
