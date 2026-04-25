const mineflayer = require('mineflayer');
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

// ── Server setup ──────────────────────────────────────────────
const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 5000; // Replit pakai 5000

// ── Bot State ─────────────────────────────────────────────────
let bot = null;
let reconnectTimer = null;
let reconnectCount = 0;
let isStopping = false;

// Exponential backoff: makin banyak gagal, makin lama tunggu
// [0,1,2,3,4,5,6+] attempt → delay detik
const BACKOFF_DELAYS = [15, 20, 30, 45, 60, 90, 120];

function getReconnectDelay() {
  const idx = Math.min(reconnectCount, BACKOFF_DELAYS.length - 1);
  const base = BACKOFF_DELAYS[idx];
  // tambah jitter ±5 detik biar tidak terlalu mekanis
  const jitter = Math.floor(Math.random() * 10) - 5;
  return Math.max(10, base + jitter);
}

const STATE = {
  status: 'offline',
  config: {
    host: process.env.MC_HOST || '',
    port: parseInt(process.env.MC_PORT) || 25565,
    username: process.env.MC_USER || '',
    version: process.env.MC_VERSION || '1.20.1',
    auth: process.env.MC_AUTH || 'offline',
    password: process.env.MC_PASS || '',
    autoLogin: process.env.AUTO_LOGIN === 'true' || false,
    autoReconnect: true,
    loginDelay: 3000,    // delay sebelum kirim /login (ms)
    maxReconnect: 10     // max attempt sebelum stop total
  },
  logs: [],
  chat: []
};

// ── Broadcast ─────────────────────────────────────────────────
function broadcast(type, data) {
  const payload = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
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

// ── Utilities ─────────────────────────────────────────────────
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min, max) { return Math.random() * (max - min) + min; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Bot ───────────────────────────────────────────────────────
function stopBot(reason = 'manual', preventReconnect = false) {
  isStopping = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (bot) {
    try { bot.quit(); } catch (_) {}
    bot = null;
  }
  setStatus('offline');
  addLog(`Bot dihentikan: ${reason}`, 'warn');
  if (preventReconnect) {
    reconnectCount = 0;
    isStopping = false;
  } else {
    setTimeout(() => { isStopping = false; }, 500);
  }
}

function scheduleReconnect() {
  if (!STATE.config.autoReconnect || isStopping) return;

  // Cek max reconnect
  if (STATE.config.maxReconnect > 0 && reconnectCount >= STATE.config.maxReconnect) {
    addLog(`⛔ Max reconnect (${STATE.config.maxReconnect}x) tercapai. Bot berhenti.`, 'error');
    addLog('Klik START BOT manual untuk mencoba lagi.', 'warn');
    reconnectCount = 0;
    return;
  }

  const delay = getReconnectDelay();
  addLog(`♻️ Auto-reconnect dalam ${delay}s... (attempt #${reconnectCount + 1})`, 'warn');
  reconnectTimer = setTimeout(() => {
    reconnectCount++;
    startBot();
  }, delay * 1000);
}

async function startBot() {
  if (bot) stopBot('restart', true);
  isStopping = false;

  if (!STATE.config.host || !STATE.config.username) {
    addLog('❌ Host / Username belum diisi!', 'error');
    return;
  }

  // ── Pre-connect delay (simulasi loading screen player asli) ──
  const preDelay = randInt(3000, 7000);
  addLog(`⏳ Pre-connect delay ${Math.round(preDelay/1000)}s (simulasi player asli)...`, 'info');
  setStatus('connecting');
  await sleep(preDelay);
  if (isStopping) return;

  addLog(`🔌 Connecting ke ${STATE.config.host}:${STATE.config.port} sebagai ${STATE.config.username}...`);

  try {
    bot = mineflayer.createBot({
      host: STATE.config.host,
      port: STATE.config.port,
      username: STATE.config.username,
      version: STATE.config.version,
      auth: STATE.config.auth,
      hideErrors: false,
      physicsEnabled: false,        // KUNCI: matikan physics engine Mineflayer
      checkTimeoutInterval: 30000   // timeout lebih longgar
    });
  } catch (err) {
    addLog(`❌ Gagal buat bot: ${err.message}`, 'error');
    setStatus('offline');
    scheduleReconnect();
    return;
  }

  // ── Spoof brand di level packet write ─────────────────────
  try {
    const origWrite = bot._client.write.bind(bot._client);
    bot._client.write = function(name, params) {
      if (name === 'plugin_message' && params && params.channel) {
        if (params.channel === 'MC|Brand' || params.channel === 'minecraft:brand') {
          params.data = Buffer.from('\x07vanilla');
        }
      }
      return origWrite(name, params);
    };
    addLog('🎭 Brand spoof: vanilla', 'info');
  } catch (e) {
    addLog('Brand spoof gagal: ' + e.message, 'warn');
  }

  // ── Intercept kick dini ───────────────────────────────────
  bot._client.on('kick_disconnect', (packet) => {
    addLog(`⚡ Kick packet dini: ${JSON.stringify(packet.reason)}`, 'error');
  });

  // ── Saat login state: kirim packet dalam urutan VANILLA ───
  // Vanilla order: client_information → minecraft:register → minecraft:brand
  bot._client.on('login', async () => {
    await sleep(randInt(300, 700));

    // 1. client_information DULU (vanilla kirim ini sebelum brand)
    try {
      bot._client.write('settings', {
        locale: 'en_US',
        viewDistance: 10,
        chatFlags: 0,
        chatColors: true,
        skinParts: 127,
        mainHand: 1,
        enableTextFiltering: false,
        enableServerListing: true
      });
    } catch(_) {}

    await sleep(randInt(100, 300));

    // 2. minecraft:register (vanilla selalu kirim ini, Mineflayer tidak)
    try {
      bot._client.write('plugin_message', {
        channel: 'minecraft:register',
        data: Buffer.from('minecraft:brand')
      });
    } catch(_) {}

    await sleep(randInt(100, 200));

    // 3. minecraft:brand terakhir
    try {
      bot._client.write('plugin_message', {
        channel: 'minecraft:brand',
        data: Buffer.from('\x07vanilla')
      });
    } catch(_) {}

    addLog('📦 Packet login vanilla terkirim (info→register→brand)', 'info');
  });

  bot.once('spawn', async () => {
    setStatus('online');
    reconnectCount = 0;
    addLog(`✅ Spawn berhasil di ${STATE.config.host}`, 'success');

    // Tunggu sebentar (player asli juga butuh waktu load chunk)
    await sleep(randInt(1000, 2500));

    // Kirim position awal — vanilla selalu kirim ini sesaat setelah spawn
    try {
      if (bot.entity) {
        bot._client.write('position', {
          x: bot.entity.position.x,
          y: bot.entity.position.y,
          z: bot.entity.position.z,
          yaw: 0,
          pitch: 0,
          onGround: true
        });
      }
    } catch(_) {}

    // Tunggu lebih lama sebelum /login agar server tidak curiga
    if (STATE.config.autoLogin && STATE.config.password) {
      const loginDelay = STATE.config.loginDelay || 3000;
      addLog(`🔐 Menunggu ${loginDelay/1000}s sebelum auto-login...`, 'info');
      await sleep(loginDelay);
      if (bot && STATE.status === 'online') {
        try {
          bot.chat(`/login ${STATE.config.password}`);
          addLog('🔐 /login terkirim', 'success');
        } catch (e) {
          addLog('Gagal kirim /login: ' + e.message, 'error');
        }
      }
    }

    // Kirim position packet berkala (simulasi vanilla client idle)
    startPositionKeepAlive();
    startAntiAfk();
  });

  // Tangkap pesan server (AuthMe prompt, dll)
  bot.on('message', async (jsonMsg) => {
    const text = jsonMsg.toString();
    if (!text) return;

    const lower = text.toLowerCase();
    const loginTriggers = ['/login', 'use /login', 'please login', 'log in to continue', 'masukkan password'];
    const registerTriggers = ['/register', 'please register', 'use /register'];

    if (STATE.config.autoLogin && STATE.config.password) {
      if (loginTriggers.some(t => lower.includes(t))) {
        addLog('📩 Server minta login, kirim /login...', 'info');
        await sleep(1500 + randInt(0, 1000)); // delay sedikit random
        if (bot && STATE.status === 'online') {
          try { bot.chat(`/login ${STATE.config.password}`); } catch (_) {}
        }
      } else if (registerTriggers.some(t => lower.includes(t))) {
        addLog('📩 Server minta register, kirim /register...', 'info');
        await sleep(1500 + randInt(0, 1000));
        if (bot && STATE.status === 'online') {
          try { bot.chat(`/register ${STATE.config.password} ${STATE.config.password}`); } catch (_) {}
        }
      }
    }
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    addChat(username, message);
  });

  bot.on('kicked', (reason) => {
    const r = typeof reason === 'object' ? JSON.stringify(reason) : String(reason);
    addLog(`❌ Kicked: ${r}`, 'error');

    const rLow = r.toLowerCase();

    // Kalau server detect bot → jangan spam reconnect, tunggu sangat lama
    if (rLow.includes('bot terdeteksi') || rLow.includes('bot detected') || rLow.includes('detected')) {
      addLog('🤖 Server mendeteksi bot! Tunggu 3 menit sebelum coba lagi...', 'error');
      addLog('💡 Tips: Coba ganti username di Settings, atau buka tiket ke admin server.', 'warn');
      reconnectCount = BACKOFF_DELAYS.length - 1; // langsung ke delay maksimal (120s)
      // Tambah delay ekstra 3 menit di atas backoff normal
      bot = null;
      setStatus('offline');
      const extraDelay = 180000 + randInt(0, 60000); // 3-4 menit
      addLog(`⏳ Extra delay ${Math.round(extraDelay/1000)}s karena deteksi bot...`, 'warn');
      setTimeout(() => scheduleReconnect(), extraDelay - (BACKOFF_DELAYS[BACKOFF_DELAYS.length-1] * 1000));
      return;
    }

    // Rate limit login
    if (rLow.includes('too fast') || rLow.includes('too many')) {
      addLog('⏳ Rate-limit login, paksa delay lebih lama...', 'warn');
      reconnectCount = Math.min(reconnectCount + 2, BACKOFF_DELAYS.length - 1);
    }

    bot = null;
    setStatus('offline');
    scheduleReconnect();
  });

  bot.on('end', (reason) => {
    if (isStopping) return;
    addLog(`⚠️ Disconnect: ${reason || 'unknown'}`, 'warn');
    bot = null;
    setStatus('offline');
    scheduleReconnect();
  });

  bot.on('error', (err) => {
    addLog(`⚠️ Error: ${err.message}`, 'error');
  });
}

// ── Anti-AFK ──────────────────────────────────────────────────
async function startAntiAfk() {
  addLog('🎮 Anti-AFK aktif', 'success');
  while (bot && bot.entity && STATE.status === 'online') {
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
          const arah = randInt(0,1) === 0 ? 'left' : 'right';
          bot.setControlState(arah, true);
          await sleep(randInt(200, 500));
          bot.setControlState(arah, false);
          break;
        case 3:
          // Gerak kepala smooth (bukan instant snap)
          if (bot.entity) {
            const targetYaw = randFloat(-Math.PI, Math.PI);
            const targetPitch = randFloat(-0.3, 0.3);
            const steps = randInt(5, 12);
            const startYaw = bot.entity.yaw || 0;
            const startPitch = bot.entity.pitch || 0;
            for (let i = 1; i <= steps; i++) {
              const yaw = startYaw + (targetYaw - startYaw) * (i / steps);
              const pitch = startPitch + (targetPitch - startPitch) * (i / steps);
              try { if (bot.look) await bot.look(yaw, pitch, false); } catch(_) {}
              await sleep(randInt(60, 120));
            }
          }
          await sleep(randInt(500, 2000));
          break;
        case 4:
          // Micro-movement packet (sangat kecil, tidak terlihat tapi ada di packet)
          if (bot.entity) {
            try {
              const offsetX = (Math.random() - 0.5) * 0.04;
              const offsetZ = (Math.random() - 0.5) * 0.04;
              bot._client.write('position', {
                x: bot.entity.position.x + offsetX,
                y: bot.entity.position.y,
                z: bot.entity.position.z + offsetZ,
                yaw: bot.entity.yaw || 0,
                pitch: bot.entity.pitch || 0,
                onGround: true
              });
            } catch(_) {}
          }
          await sleep(randInt(200, 600));
          break;
        case 5:
          // Sneak toggle
          bot.setControlState('sneak', true);
          await sleep(randInt(400, 1200));
          bot.setControlState('sneak', false);
          break;
        case 6:
          // Diam total
          break;
      }
      const jeda = randInt(15000, 35000);
      await sleep(jeda);
    } catch (err) {
      addLog('Anti-AFK error: ' + err.message, 'error');
      await sleep(5000);
    }
  }
}

// ── Position Keep-Alive (simulasi vanilla idle ~1 detik/packet) ──
let posInterval = null;
function startPositionKeepAlive() {
  if (posInterval) { clearInterval(posInterval); posInterval = null; }
  function sendPos() {
    if (!bot || !bot.entity || STATE.status !== 'online') {
      if (posInterval) { clearInterval(posInterval); posInterval = null; }
      return;
    }
    try {
      const jX = (Math.random() - 0.5) * 0.002;
      const jZ = (Math.random() - 0.5) * 0.002;
      bot._client.write('position', {
        x: bot.entity.position.x + jX,
        y: bot.entity.position.y,
        z: bot.entity.position.z + jZ,
        yaw: bot.entity.yaw || 0,
        pitch: bot.entity.pitch || 0,
        onGround: true
      });
    } catch(_) {}
  }
  posInterval = setInterval(sendPos, 950 + randInt(-50, 50));
  addLog('📍 Position keep-alive aktif', 'info');
}

// ── WebSocket ─────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', data: {
    status: STATE.status,
    config: { ...STATE.config, password: STATE.config.password ? '••••••' : '' },
    logs: STATE.logs.slice(-50),
    chat: STATE.chat.slice(-30),
    reconnectCount
  }}));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'start':
          reconnectCount = 0;
          isStopping = false;
          startBot();
          break;
        case 'stop':
          stopBot('manual stop', true);
          break;
        case 'restart':
          reconnectCount = 0;
          startBot();
          break;
        case 'send_chat':
          if (bot && STATE.status === 'online' && msg.message) {
            try {
              bot.chat(msg.message);
              addChat('§a[KAMU]', msg.message);
            } catch (e) { addLog('Gagal kirim chat: ' + e.message, 'error'); }
          }
          break;
        case 'save_config':
          Object.assign(STATE.config, msg.config);
          addLog('⚙️ Konfigurasi disimpan!', 'success');
          broadcast('config_saved', {});
          break;
        case 'clear_logs':
          STATE.logs = []; STATE.chat = [];
          broadcast('cleared', {});
          break;
      }
    } catch (e) { console.error('WS parse error:', e); }
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
    --bg:#080c10;--panel:#0d1117;--border:#1e2d3d;
    --accent:#00e5ff;--green:#00ff88;--red:#ff4757;--yellow:#ffd32a;
    --text:#c9d1d9;--dim:#4a5568;
    --font-mono:'Share Tech Mono',monospace;
    --font-ui:'Rajdhani',sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:var(--font-ui);font-size:15px;min-height:100vh;overflow-x:hidden}
  body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse at 20% 0%,rgba(0,229,255,.04),transparent 60%),radial-gradient(ellipse at 80% 100%,rgba(0,255,136,.03),transparent 60%);pointer-events:none;z-index:0}
  header{position:sticky;top:0;z-index:100;background:rgba(8,12,16,.92);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:12px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px}
  .logo{font-family:var(--font-mono);font-size:18px;color:var(--accent);letter-spacing:2px;text-shadow:0 0 20px rgba(0,229,255,.5)}
  .logo span{color:var(--green)}
  #status-badge{display:flex;align-items:center;gap:8px;font-family:var(--font-mono);font-size:13px;padding:5px 14px;border-radius:20px;border:1px solid var(--border);background:rgba(13,17,23,.8)}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--dim);transition:all .3s}
  .dot.online{background:var(--green);box-shadow:0 0 8px var(--green);animation:pulse 2s infinite}
  .dot.connecting{background:var(--yellow);box-shadow:0 0 8px var(--yellow);animation:blink .8s infinite}
  .dot.offline{background:var(--red)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
  .container{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:20px;display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media(max-width:768px){.container{grid-template-columns:1fr}}
  .panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden}
  .panel-head{background:rgba(0,0,0,.3);border-bottom:1px solid var(--border);padding:10px 16px;display:flex;align-items:center;justify-content:space-between;font-family:var(--font-mono);font-size:12px;color:var(--accent);letter-spacing:1px;text-transform:uppercase}
  .panel-body{padding:16px}
  .ctrl-panel{grid-column:1/-1}
  .btn-row{display:flex;gap:10px;flex-wrap:wrap}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:10px 20px;border:1px solid var(--border);border-radius:6px;background:rgba(0,0,0,.4);color:var(--text);font-family:var(--font-mono);font-size:13px;cursor:pointer;transition:all .2s;letter-spacing:.5px}
  .btn:hover{transform:translateY(-1px)}
  .btn-green{border-color:var(--green);color:var(--green)}.btn-green:hover{background:rgba(0,255,136,.1);box-shadow:0 0 16px rgba(0,255,136,.2)}
  .btn-red{border-color:var(--red);color:var(--red)}.btn-red:hover{background:rgba(255,71,87,.1);box-shadow:0 0 16px rgba(255,71,87,.2)}
  .btn-blue{border-color:var(--accent);color:var(--accent)}.btn-blue:hover{background:rgba(0,229,255,.1);box-shadow:0 0 16px rgba(0,229,255,.2)}
  .btn-yellow{border-color:var(--yellow);color:var(--yellow)}.btn-yellow:hover{background:rgba(255,211,42,.1)}
  .btn:disabled{opacity:.4;cursor:not-allowed;transform:none!important;box-shadow:none!important}
  .stats{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:14px}
  .stat{display:flex;flex-direction:column}
  .stat-label{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:1px}
  .stat-value{font-family:var(--font-mono);font-size:16px;color:var(--accent)}
  .stat-value.green{color:var(--green)}.stat-value.red{color:var(--red)}.stat-value.yellow{color:var(--yellow)}
  .backoff-bar{margin-top:10px;display:none}
  .backoff-label{font-family:var(--font-mono);font-size:11px;color:var(--yellow);margin-bottom:4px}
  .backoff-track{background:var(--border);border-radius:4px;height:6px;overflow:hidden}
  .backoff-fill{height:100%;background:var(--yellow);border-radius:4px;transition:width 1s linear}
  .log-box{background:rgba(0,0,0,.4);border:1px solid var(--border);border-radius:6px;height:260px;overflow-y:auto;padding:10px;font-family:var(--font-mono);font-size:12px;line-height:1.6;scroll-behavior:smooth}
  .log-box::-webkit-scrollbar{width:4px}.log-box::-webkit-scrollbar-track{background:transparent}.log-box::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
  .log-entry{padding:2px 0;border-bottom:1px solid rgba(255,255,255,.03)}
  .log-entry .time{color:var(--dim);margin-right:8px}
  .log-entry.info .msg{color:var(--text)}.log-entry.success .msg{color:var(--green)}.log-entry.warn .msg{color:var(--yellow)}.log-entry.error .msg{color:var(--red)}
  .chat-entry{padding:3px 0;border-bottom:1px solid rgba(255,255,255,.03)}
  .chat-entry .time{color:var(--dim);font-size:11px;margin-right:6px}
  .chat-entry .user{color:var(--accent);font-weight:bold}.chat-entry .user.me{color:var(--green)}.chat-entry .cmsg{color:var(--text)}
  .chat-input-row{display:flex;gap:8px;margin-top:12px}
  .chat-input-row input{flex:1;background:rgba(0,0,0,.4);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--font-mono);font-size:13px;padding:8px 12px;outline:none;transition:border-color .2s}
  .chat-input-row input:focus{border-color:var(--accent)}.chat-input-row input::placeholder{color:var(--dim)}
  .settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:500px){.settings-grid{grid-template-columns:1fr}}
  .field{display:flex;flex-direction:column;gap:4px}
  .field label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);font-family:var(--font-mono)}
  .field input,.field select{background:rgba(0,0,0,.4);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--font-mono);font-size:13px;padding:8px 10px;outline:none;transition:border-color .2s;width:100%}
  .field input:focus,.field select:focus{border-color:var(--accent)}.field select option{background:#0d1117}
  .toggle-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)}
  .toggle-row:last-child{border-bottom:none}
  .toggle-label{font-size:13px}.toggle-sub{font-size:11px;color:var(--dim);margin-top:2px}
  .toggle{position:relative;width:44px;height:24px;background:var(--border);border-radius:12px;cursor:pointer;transition:background .3s;flex-shrink:0}
  .toggle.on{background:var(--green)}.toggle::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;background:white;border-radius:50%;transition:transform .3s}.toggle.on::after{transform:translateX(20px)}
  .save-row{margin-top:14px;display:flex;gap:8px;align-items:center}
  .save-msg{font-family:var(--font-mono);font-size:12px;color:var(--green);opacity:0;transition:opacity .3s}.save-msg.show{opacity:1}
  .section-label{font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin:14px 0 8px}
  .info-box{background:rgba(255,211,42,.05);border:1px solid rgba(255,211,42,.2);border-radius:6px;padding:10px 14px;font-family:var(--font-mono);font-size:12px;color:var(--yellow);margin-bottom:12px;display:none}
  .info-box.show{display:block}
</style>
</head>
<body>
<header>
  <div class="logo">MC<span>AFK</span>.BOT</div>
  <div id="status-badge"><div class="dot" id="dot"></div><span id="status-text">OFFLINE</span></div>
</header>
<div class="container">

  <!-- CONTROL -->
  <div class="panel ctrl-panel">
    <div class="panel-head"><span>⚡ Control Panel</span><span id="reconnect-count">Reconnects: 0</span></div>
    <div class="panel-body">
      <div class="info-box" id="ratelimit-warn">⚠️ Server mendeteksi login terlalu cepat. Bot akan menunggu lebih lama sebelum reconnect...</div>
      <div class="stats">
        <div class="stat"><span class="stat-label">Status</span><span class="stat-value" id="stat-status">OFFLINE</span></div>
        <div class="stat"><span class="stat-label">Server</span><span class="stat-value" id="stat-server">—</span></div>
        <div class="stat"><span class="stat-label">Username</span><span class="stat-value" id="stat-user">—</span></div>
        <div class="stat"><span class="stat-label">Uptime</span><span class="stat-value" id="stat-uptime">—</span></div>
      </div>
      <div class="backoff-bar" id="backoff-bar">
        <div class="backoff-label" id="backoff-label">Reconnect dalam 30s...</div>
        <div class="backoff-track"><div class="backoff-fill" id="backoff-fill" style="width:100%"></div></div>
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-green" id="btn-start" onclick="sendCmd('start')">▶ START BOT</button>
        <button class="btn btn-red" id="btn-stop" onclick="sendCmd('stop')" disabled>⏹ STOP</button>
        <button class="btn btn-yellow" onclick="sendCmd('restart')">↺ RESTART</button>
        <button class="btn btn-blue" onclick="clearAll()">🗑 CLEAR</button>
      </div>
    </div>
  </div>

  <!-- LOG -->
  <div class="panel">
    <div class="panel-head"><span>📋 System Log</span><span id="log-count">0 entries</span></div>
    <div class="panel-body"><div class="log-box" id="log-box"></div></div>
  </div>

  <!-- CHAT -->
  <div class="panel">
    <div class="panel-head"><span>💬 Server Chat</span><span id="chat-count">0 messages</span></div>
    <div class="panel-body">
      <div class="log-box" id="chat-box"></div>
      <div class="chat-input-row">
        <input type="text" id="chat-input" placeholder="Ketik pesan ke server..." maxlength="256" onkeydown="if(event.key==='Enter')sendChat()">
        <button class="btn btn-blue" onclick="sendChat()">SEND</button>
      </div>
    </div>
  </div>

  <!-- SETTINGS -->
  <div class="panel" style="grid-column:1/-1">
    <div class="panel-head"><span>⚙️ Settings</span><span style="color:var(--dim)">Simpan dulu sebelum START</span></div>
    <div class="panel-body">
      <div class="settings-grid">
        <div class="field"><label>Server Host / IP</label><input type="text" id="cfg-host" placeholder="play.example.net"></div>
        <div class="field"><label>Port</label><input type="number" id="cfg-port" value="25565" min="1" max="65535"></div>
        <div class="field"><label>Username</label><input type="text" id="cfg-username" placeholder="NamaBotmu"></div>
        <div class="field"><label>Versi Minecraft</label>
          <select id="cfg-version">
            <option value="1.20.4">1.20.4</option>
            <option value="1.20.1" selected>1.20.1</option>
            <option value="1.19.4">1.19.4</option>
            <option value="1.19.2">1.19.2</option>
            <option value="1.18.2">1.18.2</option>
            <option value="1.16.5">1.16.5</option>
            <option value="1.12.2">1.12.2</option>
            <option value="1.8.9">1.8.9</option>
          </select>
        </div>
        <div class="field"><label>Auth Mode</label>
          <select id="cfg-auth">
            <option value="offline" selected>Offline (Cracked)</option>
            <option value="microsoft">Microsoft (Premium)</option>
          </select>
        </div>
        <div class="field"><label>Password (/login)</label><input type="password" id="cfg-password" placeholder="Kosongkan jika tidak pakai"></div>
        <div class="field"><label>Delay Login (detik)</label><input type="number" id="cfg-logindelay" value="3" min="1" max="30"><span style="font-size:11px;color:var(--dim);margin-top:3px">Lebih lama = lebih aman dari rate-limit</span></div>
        <div class="field"><label>Max Reconnect (0=unlimited)</label><input type="number" id="cfg-maxreconnect" value="10" min="0" max="100"></div>
      </div>
      <div class="section-label">Opsi Bot</div>
      <div class="toggle-row">
        <div><div class="toggle-label">🔐 Auto Login</div><div class="toggle-sub">Otomatis kirim /login [password] saat spawn</div></div>
        <div class="toggle" id="tog-login" onclick="toggleOpt('login')"></div>
      </div>
      <div class="toggle-row">
        <div><div class="toggle-label">♻️ Auto Reconnect + Backoff</div><div class="toggle-sub">Reconnect otomatis, delay makin lama tiap gagal (15s→20s→30s→45s→60s→90s→120s)</div></div>
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
let ws, status='offline', onlineSince=null, uptimeInterval, logCount=0, chatCount=0;
const toggles={login:false,reconnect:true};
let backoffTimer=null, backoffTotal=0, backoffLeft=0;

function connect(){
  const proto=location.protocol==='https:'?'wss':'ws';
  ws=new WebSocket(proto+'://'+location.host);
  ws.onopen=()=>console.log('WS OK');
  ws.onmessage=(e)=>{
    const {type,data}=JSON.parse(e.data);
    if(type==='init'){
      applyConfig(data.config);
      data.logs.forEach(l=>appendLog(l));
      data.chat.forEach(c=>appendChat(c));
      updateStatus(data.status,data.reconnectCount||0);
    } else if(type==='log'){
      appendLog(data);
      // Deteksi rate-limit warning
      if(data.msg&&data.msg.includes('rate-limit')){
        document.getElementById('ratelimit-warn').classList.add('show');
        setTimeout(()=>document.getElementById('ratelimit-warn').classList.remove('show'),10000);
      }
      // Deteksi backoff countdown dari log
      const m=data.msg&&data.msg.match(/reconnect dalam (\d+)s/i);
      if(m) startBackoff(parseInt(m[1]));
    } else if(type==='chat'){
      appendChat(data);
    } else if(type==='status'){
      updateStatus(data.status,data.reconnectCount||0);
      if(data.status==='online') stopBackoff();
    } else if(type==='config_saved'){
      const msg=document.getElementById('save-msg');
      msg.classList.add('show');
      setTimeout(()=>msg.classList.remove('show'),2000);
    } else if(type==='cleared'){
      document.getElementById('log-box').innerHTML='';
      document.getElementById('chat-box').innerHTML='';
      logCount=0;chatCount=0;updateCounts();
    }
  };
  ws.onclose=()=>setTimeout(connect,3000);
}

function startBackoff(seconds){
  stopBackoff();
  backoffTotal=seconds; backoffLeft=seconds;
  document.getElementById('backoff-bar').style.display='block';
  updateBackoffUI();
  backoffTimer=setInterval(()=>{
    backoffLeft--;
    if(backoffLeft<=0){stopBackoff();return;}
    updateBackoffUI();
  },1000);
}

function stopBackoff(){
  if(backoffTimer){clearInterval(backoffTimer);backoffTimer=null;}
  document.getElementById('backoff-bar').style.display='none';
}

function updateBackoffUI(){
  document.getElementById('backoff-label').textContent='Reconnect dalam '+backoffLeft+'s...';
  const pct=(backoffLeft/backoffTotal)*100;
  document.getElementById('backoff-fill').style.width=pct+'%';
}

function updateStatus(s,rc){
  status=s;
  document.getElementById('reconnect-count').textContent='Reconnects: '+(rc||0);
  const dot=document.getElementById('dot');
  const labels={online:'ONLINE',connecting:'CONNECTING...',offline:'OFFLINE'};
  const colors={online:'green',connecting:'yellow',offline:'red'};
  dot.className='dot '+s;
  document.getElementById('status-text').textContent=labels[s]||s.toUpperCase();
  const sv=document.getElementById('stat-status');
  sv.textContent=labels[s]||s.toUpperCase();
  sv.className='stat-value '+(colors[s]||'');
  if(s==='online'){
    onlineSince=Date.now();startUptimeTimer();
    document.getElementById('btn-start').disabled=true;
    document.getElementById('btn-stop').disabled=false;
    const cfg=getConfigFromForm();
    document.getElementById('stat-server').textContent=cfg.host+':'+cfg.port;
    document.getElementById('stat-user').textContent=cfg.username;
  } else {
    onlineSince=null;stopUptimeTimer();
    document.getElementById('btn-start').disabled=false;
    document.getElementById('btn-stop').disabled=true;
    document.getElementById('stat-uptime').textContent='—';
  }
}

function startUptimeTimer(){
  stopUptimeTimer();
  uptimeInterval=setInterval(()=>{
    if(!onlineSince)return;
    const sec=Math.floor((Date.now()-onlineSince)/1000);
    const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;
    document.getElementById('stat-uptime').textContent=(h?h+'h ':'')+( m?m+'m ':'')+s+'s';
  },1000);
}
function stopUptimeTimer(){if(uptimeInterval){clearInterval(uptimeInterval);uptimeInterval=null;}}

function appendLog(entry){
  const box=document.getElementById('log-box');
  const d=document.createElement('div');
  d.className='log-entry '+(entry.level||'info');
  const t=new Date(entry.ts).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  d.innerHTML='<span class="time">'+t+'</span><span class="msg">'+esc(entry.msg)+'</span>';
  box.appendChild(d);box.scrollTop=box.scrollHeight;
  logCount++;document.getElementById('log-count').textContent=logCount+' entries';
}

function appendChat(entry){
  const box=document.getElementById('chat-box');
  const d=document.createElement('div');
  d.className='chat-entry';
  const t=new Date(entry.ts).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'});
  const isMe=entry.username&&entry.username.includes('[KAMU]');
  d.innerHTML='<span class="time">'+t+'</span><span class="user'+(isMe?' me':'')+'">'
    +esc(entry.username)+'</span> <span class="cmsg">'+esc(entry.message)+'</span>';
  box.appendChild(d);box.scrollTop=box.scrollHeight;
  chatCount++;document.getElementById('chat-count').textContent=chatCount+' messages';
}

function sendCmd(type){if(ws&&ws.readyState===1)ws.send(JSON.stringify({type}));}

function sendChat(){
  const input=document.getElementById('chat-input');
  const msg=input.value.trim();if(!msg)return;
  if(ws&&ws.readyState===1){ws.send(JSON.stringify({type:'send_chat',message:msg}));input.value='';}
}

function clearAll(){if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'clear_logs'}));}

function getConfigFromForm(){
  return{
    host:document.getElementById('cfg-host').value.trim(),
    port:parseInt(document.getElementById('cfg-port').value)||25565,
    username:document.getElementById('cfg-username').value.trim(),
    version:document.getElementById('cfg-version').value,
    auth:document.getElementById('cfg-auth').value,
    password:document.getElementById('cfg-password').value,
    loginDelay:(parseInt(document.getElementById('cfg-logindelay').value)||3)*1000,
    maxReconnect:parseInt(document.getElementById('cfg-maxreconnect').value)||0,
    autoLogin:toggles.login,
    autoReconnect:toggles.reconnect
  };
}

function saveConfig(){
  const cfg=getConfigFromForm();
  if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'save_config',config:cfg}));
}

function applyConfig(cfg){
  if(cfg.host)document.getElementById('cfg-host').value=cfg.host;
  if(cfg.port)document.getElementById('cfg-port').value=cfg.port;
  if(cfg.username)document.getElementById('cfg-username').value=cfg.username;
  if(cfg.version)document.getElementById('cfg-version').value=cfg.version;
  if(cfg.auth)document.getElementById('cfg-auth').value=cfg.auth;
  if(cfg.loginDelay)document.getElementById('cfg-logindelay').value=cfg.loginDelay/1000;
  if(cfg.maxReconnect!==undefined)document.getElementById('cfg-maxreconnect').value=cfg.maxReconnect;
  toggles.login=!!cfg.autoLogin;toggles.reconnect=cfg.autoReconnect!==false;
  document.getElementById('tog-login').className='toggle'+(toggles.login?' on':'');
  document.getElementById('tog-reconnect').className='toggle'+(toggles.reconnect?' on':'');
  document.getElementById('stat-server').textContent=cfg.host?cfg.host+':'+cfg.port:'—';
  document.getElementById('stat-user').textContent=cfg.username||'—';
}

function toggleOpt(key){
  toggles[key]=!toggles[key];
  document.getElementById('tog-'+key).className='toggle'+(toggles[key]?' on':'');
}

function updateCounts(){
  document.getElementById('log-count').textContent=logCount+' entries';
  document.getElementById('chat-count').textContent=chatCount+' messages';
}

function esc(s){
  if(!s)return'';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

connect();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML));

server.listen(PORT, '0.0.0.0', () => {
  addLog(`🌐 Dashboard running on port ${PORT}`, 'success');
  addLog('Isi settings lalu klik START BOT', 'info');
});
