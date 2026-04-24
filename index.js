const mineflayer = require('mineflayer');
const express = require('express');

// =============================================
//   KONFIGURASI - EDIT BAGIAN INI!
// =============================================
const CONFIG = {
  host: 'alwination',   // contoh: 'play.example.net'
  port: 25565,
  username: 'Mrduck9182',
  version: '1.20.1',          // sesuaikan versi server
  auth: 'offline'             // ganti 'microsoft' kalau server premium
};
// =============================================

// =============================================
//   KEEP-ALIVE WEB SERVER (wajib untuk Replit)
// =============================================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="background:#1a1a2e;color:#00ff88;font-family:monospace;padding:40px;text-align:center">
        <h1>🤖 MC AFK Bot</h1>
        <p>Status: <b>RUNNING</b></p>
        <p>Server: ${CONFIG.host}:${CONFIG.port}</p>
        <p>Username: ${CONFIG.username}</p>
        <p>Uptime: ${Math.floor(process.uptime())}s</p>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`[SERVER] Keep-alive server berjalan di port ${PORT}`);
});

// =============================================
//   BOT LOGIC
// =============================================

let bot;
let afkLoop = null;

function createBot() {
  console.log(`[BOT] Connecting ke ${CONFIG.host}:${CONFIG.port}...`);

  bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version,
    auth: CONFIG.auth
  });

  bot.once('spawn', () => {
    console.log('[BOT] Spawn berhasil! Memulai anti-AFK...');
    startAntiAfk();
  });

  bot.on('kicked', (reason) => {
    console.log('[BOT] Kicked:', JSON.stringify(reason));
    clearAfkLoop();
    scheduleReconnect();
  });

  bot.on('end', (reason) => {
    console.log('[BOT] Disconnect:', reason);
    clearAfkLoop();
    scheduleReconnect();
  });

  bot.on('error', (err) => {
    console.log('[BOT] Error:', err.message);
    clearAfkLoop();
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    console.log(`[CHAT] ${username}: ${message}`);
  });
}

// =============================================
//   UTILITY
// =============================================

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clearAfkLoop() {
  if (afkLoop) {
    clearTimeout(afkLoop);
    afkLoop = null;
  }
  // Stop semua gerakan
  try {
    if (bot) {
      bot.setControlState('forward', false);
      bot.setControlState('back', false);
      bot.setControlState('left', false);
      bot.setControlState('right', false);
      bot.setControlState('jump', false);
      bot.setControlState('sneak', false);
    }
  } catch (_) {}
}

function scheduleReconnect() {
  const delay = randInt(12000, 20000);
  console.log(`[BOT] Reconnect dalam ${delay / 1000}s...`);
  setTimeout(() => createBot(), delay);
}

// =============================================
//   ANTI-AFK HUMAN-LIKE
// =============================================

async function startAntiAfk() {
  while (true) {
    try {
      if (!bot || !bot.entity) {
        await sleep(3000);
        continue;
      }

      const action = randInt(1, 6);
      console.log(`[AFK] Aksi #${action}`);

      switch (action) {
        case 1:
          // Jalan maju lalu mundur
          bot.setControlState('forward', true);
          await sleep(randInt(300, 800));
          bot.setControlState('forward', false);
          await sleep(randInt(100, 300));
          bot.setControlState('back', true);
          await sleep(randInt(300, 700));
          bot.setControlState('back', false);
          break;

        case 2:
          // Geser kiri atau kanan
          const arah = randInt(0, 1) === 0 ? 'left' : 'right';
          bot.setControlState(arah, true);
          await sleep(randInt(200, 500));
          bot.setControlState(arah, false);
          break;

        case 3:
          // Lihat ke arah random
          const yaw = randFloat(-Math.PI, Math.PI);
          const pitch = randFloat(-0.4, 0.4);
          await bot.look(yaw, pitch, false);
          await sleep(randInt(500, 1500));
          break;

        case 4:
          // Jump
          bot.setControlState('jump', true);
          await sleep(randInt(80, 200));
          bot.setControlState('jump', false);
          break;

        case 5:
          // Sneak
          bot.setControlState('sneak', true);
          await sleep(randInt(600, 2000));
          bot.setControlState('sneak', false);
          break;

        case 6:
          // Diam (paling natural)
          console.log('[AFK] Idle sejenak...');
          break;
      }

      // Jeda random 10–30 detik antar aksi
      const jeda = randInt(10000, 30000);
      console.log(`[AFK] Next aksi dalam ${Math.round(jeda / 1000)}s`);
      await sleep(jeda);

    } catch (err) {
      console.log('[AFK] Loop error:', err.message);
      await sleep(5000);
    }
  }
}

// =============================================
//   START
// =============================================
console.log('[BOT] MC AFK Bot starting...');
createBot();
