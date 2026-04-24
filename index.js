const mineflayer = require('mineflayer');
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

// ── Express + HTTP + WebSocket setup ─────────────────────────
const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// ── Bot State ─────────────────────────────────────────────────
let bot = null;
let reconnectTimer = null;
let reconnectCount = 0;

const STATE = {
  status: 'offline',       // offline | connecting | online
  config: {
    host: process.env.MC_HOST || '',
    port: parseInt(process.env.MC_PORT) || 25565,
    username: process.env.MC_USER || '',
    version: process.env.MC_VERSION || '1.20.1',
    auth: process.env.MC_AUTH || 'offline',
    password: process.env.MC_PASS || '',
    autoLogin: process.env.AUTO_LOGIN === 'true' || false,
    autoReconnect: true,
    reconnectDelay: 15
  },
  logs: [],
  chat: []
};

// ── Broadcast ke semua WebSocket client ───────────────────────
function broadcast(type, data) {
  const payload = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });
}

function addLog(msg, level = 'info') {
  const entry = { msg, level, ts: Date.now() };
  STATE.logs.push(entry);
  if (STATE.logs.length > 200) STATE.logs.shift();
  broadcast('log', entry);
  console.log(`[${level.toUpperCase()}] ${msg}`);
}

function addChat(username, message) {
  const entry = { username, message, ts: Date.now() };
  STATE.chat.push(entry);
  if (STATE.chat.length > 100) STATE.chat.shift();
  broadcast('chat', entry);
}

function setStatus(s) {
  STATE.status = s;
  broadcast('status', { status: s, reconnectCount });
}

// ── Bot Logic ─────────────────────────────────────────────────
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function stopBot(reason = 'manual') {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (bot) {
    try { bot.quit(); } catch (_) {}
    bot = null;
  }
  setStatus('offline');
  addLog(`Bot dihentikan: ${reason}`, 'warn');
}

function scheduleReconnect() {
  if (!STATE.config.autoReconnect) return;
  const delay = STATE.config.reconnectDelay * 1000;
  addLog(`Auto-reconnect dalam ${STATE.config.reconnectDelay}s... (attempt #${reconnectCount + 1})`, 'warn');
  reconnectTimer = setTimeout(() => {
    reconnectCount++;
    startBot();
  }, delay);
}

function startBot() {
  if (bot) stopBot('restart');
  if (!STATE.config.host || !STATE.config.username) {
    addLog('Host / Username belum diisi!', 'error');
    return;
  }

  setStatus('connecting');
  addLog(`Connecting ke ${STATE.config.host}:${STATE.config.port} sebagai ${STATE.config.username}...`);

  try {
    bot = mineflayer.createBot({
      host: STATE.config.host,
      port: STATE.config.port,
      username: STATE.config.username,
      version: STATE.config.version,
      auth: STATE.config.auth
    });
  } catch (err) {
    addLog(`Gagal membuat bot: ${err.message}`, 'error');
    setStatus('offline');
    scheduleReconnect();
    return;
  }

  bot.once('spawn', () => {
    setStatus('online');
    reconnectCount = 0;
    addLog(`✅ Spawn berhasil di ${STATE.config.host}`, 'success');

    // Auto login
    if (STATE.config.autoLogin && STATE.config.password) {
      setTimeout(() => {
        try {
          bot.chat(`/login ${STATE.config.password}`);
          addLog('🔐 Auto-login terkirim', 'success');
        } catch (_) {}
      }, 1500);
    }

    startAntiAfk();
  });

  bot.on('chat', (username, message) => {
    addChat(username, message);
    // Tangkap perintah register/login dari server
    const lower = message.toLowerCase();
    if (username === '' || username === bot.username) return;
  });

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString();
    // Deteksi prompt login dari server (AuthMe, etc)
    if (STATE.config.autoLogin && STATE.config.password) {
      const triggers = ['please login', 'use /login', 'login with', '/login', 'please register', '/register'];
      const low = text.toLowerCase();
      if (triggers.some(t => low.includes(t))) {
        setTimeout(() => {
          try {
            bot.chat(`/login ${STATE.config.password}`);
            addLog('🔐 Auto-login triggered by server message', 'success');
          } catch (_) {}
        }, 800);
      }
    }
  });

  bot.on('kicked', (reason) => {
    const r = typeof reason === 'object' ? JSON.stringify(reason) : reason;
    addLog(`❌ Kicked: ${r}`, 'error');
    bot = null;
    setStatus('offline');
    scheduleReconnect();
  });

  bot.on('end', (reason) => {
    addLog(`⚠️ Koneksi terputus: ${reason || 'unknown'}`, 'warn');
    bot = null;
    setStatus('offline');
    scheduleReconnect();
  });

  bot.on('error', (err) => {
    addLog(`Error: ${err.message}`, 'error');
  });
}

// ── Anti-AFK ──────────────────────────────────────────────────
async function startAntiAfk() {
  addLog('🎮 Anti-AFK dimulai', 'info');
  while (bot && bot.entity) {
    try {
      if (!bot || !bot.entity) break;
      const action = randInt(1, 6);

      switch (action) {
        case 1:
          bot.setControlState('forward', true);
          await sleep(randInt(300, 800));
          bot.setControlState('forward', false);
          await sleep(randInt(100, 300));
          bot.setControlState('back', true);
          await sleep(randInt(300, 700));
          bot.setControlState('back', false);
          break;
        case 2:
          const arah = randInt(0, 1) === 0 ? 'left' : 'right';
          bot.setControlState(arah, true);
          await sleep(randInt(200, 500));
          bot.setControlState(arah, false);
          break;
        case 3:
          if (bot.look) {
            await bot.look(randFloat(-Math.PI, Math.PI), randFloat(-0.4, 0.4), false);
          }
          await sleep(randInt(500, 1500));
          break;
        case 4:
          bot.setControlState('jump', true);
          await sleep(randInt(80, 200));
          bot.setControlState('jump', false);
          break;
        case 5:
          bot.setControlState('sneak', true);
          await sleep(randInt(600, 2000));
          bot.setControlState('sneak', false);
          break;
        case 6:
          break; // diam
      }

      const jeda = randInt(10000, 28000);
      addLog(`Anti-AFK: aksi #${action}, next dalam ${Math.round(jeda/1000)}s`, 'info');
      await sleep(jeda);
    } catch (err) {
      addLog(`Anti-AFK error: ${err.message}`, 'error');
      await sleep(5000);
    }
  }
}

// ── WebSocket Handler ─────────────────────────────────────────
wss.on('connection', (ws) => {
  // Kirim state awal
  ws.send(JSON.stringify({ type: 'init', data: {
    status: STATE.status,
    config: { ...STATE.config, password: STATE.config.password ? '••••••' : '' },
    logs: STATE.logs.slice(-50),
    chat: STATE.chat.slice(-30)
  }}));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'start':
          reconnectCount = 0;
          startBot();
          break;
        case 'stop':
          STATE.config.autoReconnect = false;
          stopBot('manual stop');
          STATE.config.autoReconnect = true;
          break;
        case 'restart':
          reconnectCount = 0;
          startBot();
          break;
        case 'send_chat':
          if (bot && STATE.status === 'online' && msg.message) {
            try {
              bot.chat(msg.message);
              addChat(STATE.config.username + ' [BOT]', msg.message);
            } catch (e) {
              addLog(`Gagal kirim chat: ${e.message}`, 'error');
            }
          }
          break;
        case 'save_config':
          Object.assign(STATE.config, msg.config);
          addLog('⚙️ Konfigurasi disimpan', 'success');
          broadcast('config_saved', {});
          break;
        case 'clear_logs':
          STATE.logs = [];
          STATE.chat = [];
          broadcast('cleared', {});
          break;
      }
    } catch (err) {
      console.error('WS error:', err);
    }
  });
});

// ── HTML Dashboard ────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MC AFK Bot Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #080c10;
    --panel: #0d1117;
    --border: #1e2d3d;
    --accent: #00e5ff;
    --green: #00ff88;
    --red: #ff4757;
    --yellow: #ffd32a;
    --text: #c9d1d9;
    --dim: #4a5568;
    --font-mono: 'Share Tech Mono', monospace;
    --font-ui: 'Rajdhani', sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 15px;
    min-height: 100vh;
    overflow-x: hidden;
  }
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: radial-gradient(ellipse at 20% 0%, rgba(0,229,255,.04) 0%, transparent 60%),
                radial-gradient(ellipse at 80% 100%, rgba(0,255,136,.03) 0%, transparent 60%);
    pointer-events: none;
    z-index: 0;
  }

  /* HEADER */
  header {
    position: sticky; top: 0; z-index: 100;
    background: rgba(8,12,16,.92);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
    padding: 12px 20px;
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px;
  }
  .logo {
    font-family: var(--font-mono);
    font-size: 18px;
    color: var(--accent);
    letter-spacing: 2px;
    text-shadow: 0 0 20px rgba(0,229,255,.5);
  }
  .logo span { color: var(--green); }
  #status-badge {
    display: flex; align-items: center; gap: 8px;
    font-family: var(--font-mono);
    font-size: 13px;
    padding: 5px 14px;
    border-radius: 20px;
    border: 1px solid var(--border);
    background: rgba(13,17,23,.8);
    transition: all .3s;
  }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--dim);
    transition: all .3s;
  }
  .dot.online { background: var(--green); box-shadow: 0 0 8px var(--green); animation: pulse 2s infinite; }
  .dot.connecting { background: var(--yellow); box-shadow: 0 0 8px var(--yellow); animation: blink .8s infinite; }
  .dot.offline { background: var(--red); }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }

  /* LAYOUT */
  .container {
    position: relative; z-index: 1;
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: auto auto auto;
    gap: 16px;
  }
  @media(max-width:768px) {
    .container { grid-template-columns: 1fr; }
  }

  /* PANELS */
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .panel-head {
    background: rgba(0,0,0,.3);
    border-bottom: 1px solid var(--border);
    padding: 10px 16px;
    display: flex; align-items: center; justify-content: space-between;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--accent);
    letter-spacing: 1px;
    text-transform: uppercase;
  }
  .panel-body { padding: 16px; }

  /* CONTROLS */
  .ctrl-panel { grid-column: 1 / -1; }
  .btn-row { display: flex; gap: 10px; flex-wrap: wrap; }
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 10px 20px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: rgba(0,0,0,.4);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 13px;
    cursor: pointer;
    transition: all .2s;
    letter-spacing: .5px;
  }
  .btn:hover { transform: translateY(-1px); }
  .btn-green { border-color: var(--green); color: var(--green); }
  .btn-green:hover { background: rgba(0,255,136,.1); box-shadow: 0 0 16px rgba(0,255,136,.2); }
  .btn-red { border-color: var(--red); color: var(--red); }
  .btn-red:hover { background: rgba(255,71,87,.1); box-shadow: 0 0 16px rgba(255,71,87,.2); }
  .btn-blue { border-color: var(--accent); color: var(--accent); }
  .btn-blue:hover { background: rgba(0,229,255,.1); box-shadow: 0 0 16px rgba(0,229,255,.2); }
  .btn-yellow { border-color: var(--yellow); color: var(--yellow); }
  .btn-yellow:hover { background: rgba(255,211,42,.1); }
  .btn:disabled { opacity: .4; cursor: not-allowed; transform: none !important; box-shadow: none !important; }

  /* STATS BAR */
  .stats { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 14px; }
  .stat { display: flex; flex-direction: column; }
  .stat-label { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 1px; }
  .stat-value { font-family: var(--font-mono); font-size: 16px; color: var(--accent); }
  .stat-value.green { color: var(--green); }
  .stat-value.red { color: var(--red); }
  .stat-value.yellow { color: var(--yellow); }

  /* LOG & CHAT */
  .log-box {
    background: rgba(0,0,0,.4);
    border: 1px solid var(--border);
    border-radius: 6px;
    height: 260px;
    overflow-y: auto;
    padding: 10px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.6;
    scroll-behavior: smooth;
  }
  .log-box::-webkit-scrollbar { width: 4px; }
  .log-box::-webkit-scrollbar-track { background: transparent; }
  .log-box::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
  .log-entry { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,.03); }
  .log-entry .time { color: var(--dim); margin-right: 8px; }
  .log-entry.info .msg { color: var(--text); }
  .log-entry.success .msg { color: var(--green); }
  .log-entry.warn .msg { color: var(--yellow); }
  .log-entry.error .msg { color: var(--red); }

  .chat-entry { padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,.03); }
  .chat-entry .time { color: var(--dim); font-size: 11px; margin-right: 6px; }
  .chat-entry .user { color: var(--accent); font-weight: bold; }
  .chat-entry .user.bot-user { color: var(--green); }
  .chat-entry .cmsg { color: var(--text); }

  /* CHAT INPUT */
  .chat-input-row {
    display: flex; gap: 8px; margin-top: 12px;
  }
  .chat-input-row input {
    flex: 1;
    background: rgba(0,0,0,.4);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 13px;
    padding: 8px 12px;
    outline: none;
    transition: border-color .2s;
  }
  .chat-input-row input:focus { border-color: var(--accent); }
  .chat-input-row input::placeholder { color: var(--dim); }

  /* SETTINGS */
  .settings-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  @media(max-width:500px) { .settings-grid { grid-template-columns: 1fr; } }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--dim);
    font-family: var(--font-mono);
  }
  .field input, .field select {
    background: rgba(0,0,0,.4);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 13px;
    padding: 8px 10px;
    outline: none;
    transition: border-color .2s;
    width: 100%;
  }
  .field input:focus, .field select:focus { border-color: var(--accent); }
  .field select option { background: #0d1117; }
  .toggle-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .toggle-row:last-child { border-bottom: none; }
  .toggle-label { font-size: 13px; }
  .toggle-sub { font-size: 11px; color: var(--dim); margin-top: 2px; }
  .toggle {
    position: relative;
    width: 44px; height: 24px;
    background: var(--border);
    border-radius: 12px;
    cursor: pointer;
    transition: background .3s;
    flex-shrink: 0;
  }
  .toggle.on { background: var(--green); }
  .toggle::after {
    content: '';
    position: absolute;
    top: 3px; left: 3px;
    width: 18px; height: 18px;
    background: white;
    border-radius: 50%;
    transition: transform .3s;
  }
  .toggle.on::after { transform: translateX(20px); }

  .save-row { margin-top: 14px; display: flex; gap: 8px; align-items: center; }
  .save-msg { font-family: var(--font-mono); font-size: 12px; color: var(--green); opacity: 0; transition: opacity .3s; }
  .save-msg.show { opacity: 1; }

  .section-label {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--dim);
    margin: 14px 0 8px;
  }
</style>
</head>
<body>

<header>
  <div class="logo">MC<span>AFK</span>.BOT</div>
  <div id="status-badge">
    <div class="dot" id="dot"></div>
    <span id="status-text">OFFLINE</span>
  </div>
</header>

<div class="container">

  <!-- CONTROL PANEL -->
  <div class="panel ctrl-panel">
    <div class="panel-head">
      <span>⚡ Control Panel</span>
      <span id="reconnect-count">Reconnects: 0</span>
    </div>
    <div class="panel-body">
      <div class="stats">
        <div class="stat">
          <span class="stat-label">Status</span>
          <span class="stat-value" id="stat-status">OFFLINE</span>
        </div>
        <div class="stat">
          <span class="stat-label">Server</span>
          <span class="stat-value" id="stat-server">—</span>
        </div>
        <div class="stat">
          <span class="stat-label">Username</span>
          <span class="stat-value" id="stat-user">—</span>
        </div>
        <div class="stat">
          <span class="stat-label">Uptime</span>
          <span class="stat-value" id="stat-uptime">—</span>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn btn-green" id="btn-start" onclick="sendCmd('start')">▶ START BOT</button>
        <button class="btn btn-red" id="btn-stop" onclick="sendCmd('stop')" disabled>⏹ STOP</button>
        <button class="btn btn-yellow" id="btn-restart" onclick="sendCmd('restart')">↺ RESTART</button>
        <button class="btn btn-blue" onclick="clearAll()">🗑 CLEAR LOGS</button>
      </div>
    </div>
  </div>

  <!-- LOG PANEL -->
  <div class="panel">
    <div class="panel-head">
      <span>📋 System Log</span>
      <span id="log-count">0 entries</span>
    </div>
    <div class="panel-body">
      <div class="log-box" id="log-box"></div>
    </div>
  </div>

  <!-- CHAT PANEL -->
  <div class="panel">
    <div class="panel-head">
      <span>💬 Server Chat</span>
      <span id="chat-count">0 messages</span>
    </div>
    <div class="panel-body">
      <div class="log-box" id="chat-box"></div>
      <div class="chat-input-row">
        <input type="text" id="chat-input" placeholder="Ketik pesan ke server..." maxlength="256"
          onkeydown="if(event.key==='Enter') sendChat()">
        <button class="btn btn-blue" onclick="sendChat()">SEND</button>
      </div>
    </div>
  </div>

  <!-- SETTINGS PANEL -->
  <div class="panel" style="grid-column:1/-1">
    <div class="panel-head">
      <span>⚙️ Settings</span>
      <span style="color:var(--dim)">Simpan sebelum start bot</span>
    </div>
    <div class="panel-body">
      <div class="settings-grid">
        <div class="field">
          <label>Server Host / IP</label>
          <input type="text" id="cfg-host" placeholder="play.example.net">
        </div>
        <div class="field">
          <label>Port</label>
          <input type="number" id="cfg-port" value="25565" min="1" max="65535">
        </div>
        <div class="field">
          <label>Username</label>
          <input type="text" id="cfg-username" placeholder="NamaBotmu">
        </div>
        <div class="field">
          <label>Versi Minecraft</label>
          <select id="cfg-version">
            <option value="1.20.4">1.20.4</option>
            <option value="1.20.1" selected>1.20.1</option>
            <option value="1.19.4">1.19.4</option>
            <option value="1.19.2">1.19.2</option>
            <option value="1.18.2">1.18.2</option>
            <option value="1.17.1">1.17.1</option>
            <option value="1.16.5">1.16.5</option>
            <option value="1.12.2">1.12.2</option>
            <option value="1.8.9">1.8.9</option>
          </select>
        </div>
        <div class="field">
          <label>Auth Mode</label>
          <select id="cfg-auth">
            <option value="offline" selected>Offline (Cracked)</option>
            <option value="microsoft">Microsoft (Premium)</option>
          </select>
        </div>
        <div class="field">
          <label>Password (untuk /login)</label>
          <input type="password" id="cfg-password" placeholder="Kosongkan jika tidak pakai">
        </div>
        <div class="field">
          <label>Reconnect Delay (detik)</label>
          <input type="number" id="cfg-delay" value="15" min="5" max="120">
        </div>
      </div>

      <div class="section-label">Opsi Bot</div>
      <div class="toggle-row">
        <div>
          <div class="toggle-label">🔐 Auto Login</div>
          <div class="toggle-sub">Otomatis kirim /login [password] saat spawn</div>
        </div>
        <div class="toggle" id="tog-login" onclick="toggleOpt('login')"></div>
      </div>
      <div class="toggle-row">
        <div>
          <div class="toggle-label">♻️ Auto Reconnect</div>
          <div class="toggle-sub">Reconnect otomatis saat disconnect/kicked</div>
        </div>
        <div class="toggle on" id="tog-reconnect" onclick="toggleOpt('reconnect')"></div>
      </div>

      <div class="save-row">
        <button class="btn btn-green" onclick="saveConfig()">💾 SIMPAN KONFIGURASI</button>
        <span class="save-msg" id="save-msg">✓ Tersimpan!</span>
      </div>
    </div>
  </div>

</div>

<script>
  let ws;
  let status = 'offline';
  let onlineSince = null;
  let uptimeInterval;
  let logCount = 0;
  let chatCount = 0;
  const toggles = { login: false, reconnect: true };
  let botUsername = '';

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host);

    ws.onopen = () => console.log('WS connected');

    ws.onmessage = (e) => {
      const { type, data } = JSON.parse(e.data);
      if (type === 'init') {
        applyConfig(data.config);
        data.logs.forEach(l => appendLog(l));
        data.chat.forEach(c => appendChat(c));
        updateStatus(data.status, 0);
        botUsername = data.config.username;
      } else if (type === 'log') {
        appendLog(data);
      } else if (type === 'chat') {
        appendChat(data);
      } else if (type === 'status') {
        updateStatus(data.status, data.reconnectCount);
      } else if (type === 'config_saved') {
        const msg = document.getElementById('save-msg');
        msg.classList.add('show');
        setTimeout(() => msg.classList.remove('show'), 2000);
      } else if (type === 'cleared') {
        document.getElementById('log-box').innerHTML = '';
        document.getElementById('chat-box').innerHTML = '';
        logCount = 0; chatCount = 0;
        updateCounts();
      }
    };

    ws.onclose = () => {
      setTimeout(connect, 3000);
    };
  }

  function updateStatus(s, rc) {
    status = s;
    document.getElementById('reconnect-count').textContent = 'Reconnects: ' + (rc || 0);
    const dot = document.getElementById('dot');
    const stText = document.getElementById('status-text');
    const statStatus = document.getElementById('stat-status');
    dot.className = 'dot ' + s;
    const labels = { online: 'ONLINE', connecting: 'CONNECTING...', offline: 'OFFLINE' };
    const colors = { online: 'green', connecting: 'yellow', offline: 'red' };
    stText.textContent = labels[s] || s.toUpperCase();
    statStatus.textContent = labels[s] || s.toUpperCase();
    statStatus.className = 'stat-value ' + (colors[s] || '');

    if (s === 'online') {
      onlineSince = Date.now();
      startUptimeTimer();
      document.getElementById('btn-start').disabled = true;
      document.getElementById('btn-stop').disabled = false;
      const cfg = getConfigFromForm();
      document.getElementById('stat-server').textContent = cfg.host + ':' + cfg.port;
      document.getElementById('stat-user').textContent = cfg.username;
    } else {
      onlineSince = null;
      stopUptimeTimer();
      document.getElementById('btn-start').disabled = false;
      document.getElementById('btn-stop').disabled = true;
      document.getElementById('stat-uptime').textContent = '—';
    }
  }

  function startUptimeTimer() {
    stopUptimeTimer();
    uptimeInterval = setInterval(() => {
      if (!onlineSince) return;
      const sec = Math.floor((Date.now() - onlineSince) / 1000);
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      document.getElementById('stat-uptime').textContent =
        (h > 0 ? h + 'h ' : '') + (m > 0 ? m + 'm ' : '') + s + 's';
    }, 1000);
  }

  function stopUptimeTimer() {
    if (uptimeInterval) { clearInterval(uptimeInterval); uptimeInterval = null; }
  }

  function appendLog(entry) {
    const box = document.getElementById('log-box');
    const d = document.createElement('div');
    d.className = 'log-entry ' + (entry.level || 'info');
    const t = new Date(entry.ts).toLocaleTimeString('id-ID', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    d.innerHTML = '<span class="time">' + t + '</span><span class="msg">' + escHtml(entry.msg) + '</span>';
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
    logCount++;
    document.getElementById('log-count').textContent = logCount + ' entries';
  }

  function appendChat(entry) {
    const box = document.getElementById('chat-box');
    const d = document.createElement('div');
    d.className = 'chat-entry';
    const t = new Date(entry.ts).toLocaleTimeString('id-ID', {hour:'2-digit',minute:'2-digit'});
    const isBot = entry.username && entry.username.includes('[BOT]');
    d.innerHTML =
      '<span class="time">' + t + '</span>' +
      '<span class="user' + (isBot ? ' bot-user' : '') + '">' + escHtml(entry.username) + '</span>' +
      ' <span class="cmsg">' + escHtml(entry.message) + '</span>';
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
    chatCount++;
    document.getElementById('chat-count').textContent = chatCount + ' messages';
  }

  function sendCmd(type) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type }));
  }

  function sendChat() {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if (!msg) return;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'send_chat', message: msg }));
      input.value = '';
    }
  }

  function clearAll() {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'clear_logs' }));
  }

  function getConfigFromForm() {
    return {
      host: document.getElementById('cfg-host').value.trim(),
      port: parseInt(document.getElementById('cfg-port').value) || 25565,
      username: document.getElementById('cfg-username').value.trim(),
      version: document.getElementById('cfg-version').value,
      auth: document.getElementById('cfg-auth').value,
      password: document.getElementById('cfg-password').value,
      reconnectDelay: parseInt(document.getElementById('cfg-delay').value) || 15,
      autoLogin: toggles.login,
      autoReconnect: toggles.reconnect
    };
  }

  function saveConfig() {
    const cfg = getConfigFromForm();
    botUsername = cfg.username;
    document.getElementById('stat-server').textContent = cfg.host + ':' + cfg.port;
    document.getElementById('stat-user').textContent = cfg.username;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'save_config', config: cfg }));
  }

  function applyConfig(cfg) {
    if (cfg.host) document.getElementById('cfg-host').value = cfg.host;
    if (cfg.port) document.getElementById('cfg-port').value = cfg.port;
    if (cfg.username) document.getElementById('cfg-username').value = cfg.username;
    if (cfg.version) document.getElementById('cfg-version').value = cfg.version;
    if (cfg.auth) document.getElementById('cfg-auth').value = cfg.auth;
    if (cfg.reconnectDelay) document.getElementById('cfg-delay').value = cfg.reconnectDelay;
    toggles.login = !!cfg.autoLogin;
    toggles.reconnect = cfg.autoReconnect !== false;
    document.getElementById('tog-login').className = 'toggle' + (toggles.login ? ' on' : '');
    document.getElementById('tog-reconnect').className = 'toggle' + (toggles.reconnect ? ' on' : '');
    document.getElementById('stat-server').textContent = cfg.host ? cfg.host + ':' + cfg.port : '—';
    document.getElementById('stat-user').textContent = cfg.username || '—';
    botUsername = cfg.username || '';
  }

  function toggleOpt(key) {
    toggles[key] = !toggles[key];
    document.getElementById('tog-' + key).className = 'toggle' + (toggles[key] ? ' on' : '');
  }

  function updateCounts() {
    document.getElementById('log-count').textContent = logCount + ' entries';
    document.getElementById('chat-count').textContent = chatCount + ' messages';
  }

  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  connect();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML));

server.listen(PORT, () => {
  addLog(`🌐 Dashboard berjalan di port ${PORT}`, 'success');
  addLog('Isi konfigurasi di dashboard lalu klik START BOT', 'info');
});
