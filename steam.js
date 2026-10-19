const express = require('express');
const tmi = require('tmi.js');
const TelegramBot = require('node-telegram-bot-api');
const SteamID = require('steamid');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// ENVIRONMENT VARIABLES
// ==========================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID ? parseInt(process.env.ALLOWED_USER_ID, 10) : null;

// GitHub Gist Persistence Variables
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // Personal Access Token with 'gist' scope
const GIST_ID = process.env.GIST_ID;           // The ID from your Gist URL
const GIST_FILENAME = process.env.GIST_FILENAME || 'targets.json';

// Render automatically provides RENDER_EXTERNAL_URL on free & paid web services
const APP_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;

if (!TELEGRAM_TOKEN) {
  console.error("❌ Error: TELEGRAM_TOKEN environment variable is required.");
  process.exit(1);
}

if (!ALLOWED_USER_ID || isNaN(ALLOWED_USER_ID)) {
  console.error("❌ Error: A valid ALLOWED_USER_ID environment variable is required.");
  process.exit(1);
}

// ==========================================
// GITHUB GIST + LOCAL FALLBACK STORAGE
// ==========================================
const TARGETS_FILE = './targets.json';
let twitchTargets = [];
let steamTargets = [];
let saveTimeout = null;

function parseTargetsData(rawJsonString) {
  const data = JSON.parse(rawJsonString);
  if (Array.isArray(data)) {
    twitchTargets = data;
    steamTargets = [];
  } else if (data && typeof data === 'object') {
    twitchTargets = Array.isArray(data.twitch) ? data.twitch : [];
    steamTargets = Array.isArray(data.steam) ? data.steam : [];
  }
}

async function loadTargets() {
  // 1. Try loading from GitHub Gist first
  if (GITHUB_TOKEN && GIST_ID) {
    try {
      const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'Twitch-Steam-Telegram-Tracker',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });

      if (res.ok) {
        const gist = await res.json();
        const fileObj = gist.files && gist.files[GIST_FILENAME];
        if (fileObj && fileObj.content) {
          parseTargetsData(fileObj.content);
          console.log(`✅ [Gist] Loaded ${twitchTargets.length} Twitch targets and ${steamTargets.length} Steam targets.`);
          fs.writeFileSync(TARGETS_FILE, JSON.stringify({ twitch: twitchTargets, steam: steamTargets }, null, 2));
          return;
        } else {
          console.warn(`⚠️ [Gist] File "${GIST_FILENAME}" not found in Gist. It will be created on next save.`);
        }
      } else {
        console.error(`❌ [Gist] Failed to fetch Gist (HTTP ${res.status}): ${await res.text()}`);
      }
    } catch (e) {
      console.error("❌ [Gist] Error loading from GitHub Gist:", e.message);
    }
  } else {
    console.warn("⚠️ GITHUB_TOKEN or GIST_ID not set. Falling back to ephemeral local targets.json.");
  }

  // 2. Fallback to local file if Gist isn't configured or failed
  if (fs.existsSync(TARGETS_FILE)) {
    try {
      parseTargetsData(fs.readFileSync(TARGETS_FILE, 'utf8'));
      console.log(`📂 [Local] Loaded ${twitchTargets.length} Twitch targets and ${steamTargets.length} Steam targets.`);
    } catch (e) {
      console.error("Failed to load local targets.json:", e.message);
    }
  }
}

function saveTargets() {
  const data = {
    twitch: twitchTargets,
    steam: steamTargets
  };
  const jsonContent = JSON.stringify(data, null, 2);

  // Save locally right away
  try {
    fs.writeFileSync(TARGETS_FILE, jsonContent);
  } catch (e) {
    console.error("Failed to write local targets.json:", e.message);
  }

  // Sync to GitHub Gist (debounced by 2s to prevent API spam during bulk Steam name updates)
  if (GITHUB_TOKEN && GIST_ID) {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'Twitch-Steam-Telegram-Tracker',
            'X-GitHub-Api-Version': '2022-11-28'
          },
          body: JSON.stringify({
            files: {
              [GIST_FILENAME]: {
                content: JSON.stringify({ twitch: twitchTargets, steam: steamTargets }, null, 2)
              }
            }
          })
        });

        if (!res.ok) {
          console.error(`❌ [Gist] Failed to save targets (HTTP ${res.status}): ${await res.text()}`);
        } else {
          console.log(`💾 [Gist] Synced ${twitchTargets.length} Twitch and ${steamTargets.length} Steam targets.`);
        }
      } catch (e) {
        console.error("❌ [Gist] Error syncing to GitHub Gist:", e.message);
      }
    }, 2000);
  }
}

// ==========================================
// TELEGRAM STATE & BOT INITIALIZATION
// ==========================================
const chatStates = new Map();
let notifiedTwitchUsers = new Set();
let totalNamesReceived = new Map();

const telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const isAllowed = (chatId) => chatId === ALLOWED_USER_ID;

telegramBot.on('polling_error', (error) => console.error(`Telegram Polling Error:`, error.message));

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sendTelegramNotification(text) {
  telegramBot.sendMessage(ALLOWED_USER_ID, text, { parse_mode: 'HTML' }).catch(err => {
    console.error('Failed to send Telegram message:', err.message);
  });
}

// ==========================================
// TELEGRAM COMMAND HANDLERS
// ==========================================

telegramBot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) {
    console.log(`Unauthorized access attempt from Chat ID: ${chatId}`);
    return;
  }
  const welcomeText = `🤖 <b>Twitch &amp; Steam Multi-Tracker Bot</b>\n\n` +
    `<b>Commands:</b>\n` +
    `🟣 <b>Twitch:</b>\n` +
    `/add - Track a Twitch user in a channel\n` +
    `/remove - Stop tracking a Twitch target\n\n` +
    `⚙️ <b>Steam:</b>\n` +
    `/addsteam [id/url] - Track a Steam user by SteamID64, profile link, or custom URL\n` +
    `/removesteam [number] - Stop tracking a Steam target\n\n` +
    `📋 <b>General:</b>\n` +
    `/list - View all tracked Twitch and Steam targets`;

  telegramBot.sendMessage(chatId, welcomeText, { parse_mode: 'HTML' });
});

// Twitch Add
telegramBot.onText(/^\/add(?:\s+(.+))?$/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) return;
  const arg = match && match[1] ? match[1].trim() : null;

  if (arg) {
    const channel = arg.toLowerCase().replace(/^#/, '');
    chatStates.set(chatId, { action: 'ADD_TWITCH_USERNAME', payload: { channel } });
    telegramBot.sendMessage(chatId, `Got it. Channel: #${channel}. Now, what is the username you want to track?`);
  } else {
    chatStates.set(chatId, { action: 'ADD_TWITCH_CHANNEL' });
    telegramBot.sendMessage(chatId, '🟣 Which Twitch channel do you want to monitor? (e.g., xqc)');
  }
});

// Steam Add
telegramBot.onText(/^\/addsteam(?:\s+(.+))?$/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) return;

  const arg = match && match[1] ? match[1].trim() : null;

  if (arg) {
    processAddSteam(chatId, arg);
  } else {
    chatStates.set(chatId, { action: 'ADD_STEAM_INPUT' });
    telegramBot.sendMessage(
      chatId,
      '⚙️ <b>Add Steam Target</b>\n\nPlease send the SteamID64 (e.g. <code>76561198000000000</code>), Steam profile link, or custom URL vanity name.',
      { parse_mode: 'HTML' }
    );
  }
});

// Twitch Remove
telegramBot.onText(/^\/remove(?:\s+(.+))?$/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) return;
  if (twitchTargets.length === 0) {
    telegramBot.sendMessage(chatId, 'You are not tracking any Twitch targets currently.');
    return;
  }

  const arg = match && match[1] ? match[1].trim() : null;
  if (arg && !isNaN(parseInt(arg))) {
    const index = parseInt(arg) - 1;
    if (index >= 0 && index < twitchTargets.length) {
      const removed = twitchTargets.splice(index, 1)[0];
      saveTargets();
      telegramBot.sendMessage(chatId, `🗑️ Stopped tracking <code>${escapeHtml(removed.username)}</code> in #${escapeHtml(removed.channel)}.`, { parse_mode: 'HTML' });
      if (twitchClient && !twitchTargets.some(t => t.channel === removed.channel)) {
        twitchClient.part(removed.channel).catch(err => console.error(`Failed to part #${removed.channel}:`, err));
      }
      return;
    }
  }

  chatStates.set(chatId, { action: 'REMOVE_TWITCH_TARGET' });
  const list = twitchTargets.map((t, i) => `${i + 1}. <code>${escapeHtml(t.username)}</code> in #${escapeHtml(t.channel)}`).join('\n');
  telegramBot.sendMessage(chatId, `Reply with the number of the Twitch target to remove:\n\n${list}`, { parse_mode: 'HTML' });
});

// Steam Remove
telegramBot.onText(/^\/removesteam(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) return;

  if (steamTargets.length === 0) {
    telegramBot.sendMessage(chatId, 'You are not tracking any Steam targets currently.');
    return;
  }

  const arg = match && match[1] ? match[1].trim() : null;

  if (arg && !isNaN(parseInt(arg))) {
    processRemoveSteam(chatId, parseInt(arg) - 1);
  } else {
    const uncached = steamTargets.filter(t => !steamStateCache.has(t.steamID64));
    if (uncached.length > 0) {
      await Promise.all(uncached.map(t => fetchSingleSteamUser(t.steamID64)));
    }

    chatStates.set(chatId, { action: 'REMOVE_STEAM_TARGET' });
    const list = steamTargets
      .map((t, i) => `${i + 1}. <b>${escapeHtml(t.label || 'Steam User')}</b> (<code>${t.steamID64}</code>) - ${getSteamStatusString(t.steamID64)}`)
      .join('\n');
    telegramBot.sendMessage(
      chatId,
      `Reply with the number of the Steam target to remove:\n\n${list}`,
      { parse_mode: 'HTML' }
    );
  }
});

// List All
telegramBot.onText(/^\/list$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) return;

  if (twitchTargets.length === 0 && steamTargets.length === 0) {
    telegramBot.sendMessage(chatId, 'You are not tracking any Twitch or Steam targets currently.');
    return;
  }

  const uncached = steamTargets.filter(t => !steamStateCache.has(t.steamID64));
  if (uncached.length > 0) {
    await Promise.all(uncached.map(t => fetchSingleSteamUser(t.steamID64)));
  }

  let text = '📋 <b>Tracked Targets Overview</b>\n\n';

  if (twitchTargets.length > 0) {
    text += `🟣 <b>Twitch Targets (${twitchTargets.length}):</b>\n`;
    twitchTargets.forEach((t, i) => {
      text += `${i + 1}. <code>${escapeHtml(t.username)}</code> in #${escapeHtml(t.channel)}\n`;
    });
    text += '\n';
  } else {
    text += '🟣 <i>No Twitch targets tracked.</i>\n\n';
  }

  if (steamTargets.length > 0) {
    text += `⚙️ <b>Steam Targets (${steamTargets.length}):</b>\n`;
    steamTargets.forEach((t, i) => {
      text += `${i + 1}. <b>${escapeHtml(t.label || 'Steam User')}</b> (<code>${t.steamID64}</code>)\n   Status: ${getSteamStatusString(t.steamID64)}\n`;
    });
  } else {
    text += '⚙️ <i>No Steam targets tracked.</i>\n';
  }

  telegramBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

// Generic Text Message State Handler
telegramBot.on('message', (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) return;
  
  const state = chatStates.get(chatId);
  if (!state) return;

  if (state.action === 'ADD_TWITCH_CHANNEL') {
    const channel = msg.text.trim().toLowerCase().replace(/^#/, '');
    chatStates.set(chatId, { action: 'ADD_TWITCH_USERNAME', payload: { channel } });
    telegramBot.sendMessage(chatId, `Got it. Channel: #${channel}. Now, what is the username you want to track?`);
  } else if (state.action === 'ADD_TWITCH_USERNAME') {
    const username = msg.text.trim().toLowerCase();
    const channel = state.payload.channel;
    
    if (twitchTargets.some(t => t.channel === channel && t.username === username)) {
      telegramBot.sendMessage(chatId, `You are already tracking ${username} in #${channel}.`);
    } else {
      twitchTargets.push({ channel, username });
      saveTargets();
      telegramBot.sendMessage(chatId, `✅ Now tracking <code>${escapeHtml(username)}</code> in #${escapeHtml(channel)}.`, { parse_mode: 'HTML' });
      
      if (twitchClient) {
        const currentChannels = twitchClient.getChannels().map(c => c.replace(/^#/, ''));
        if (!currentChannels.includes(channel)) {
          twitchClient.join(channel).catch(err => console.error(`Failed to join #${channel}:`, err));
        }
      }
    }
    chatStates.delete(chatId);
  } else if (state.action === 'REMOVE_TWITCH_TARGET') {
    const index = parseInt(msg.text.trim()) - 1;
    if (isNaN(index) || index < 0 || index >= twitchTargets.length) {
      telegramBot.sendMessage(chatId, '❌ Invalid number. Twitch target removal cancelled.');
    } else {
      const removed = twitchTargets.splice(index, 1)[0];
      saveTargets();
      telegramBot.sendMessage(chatId, `🗑️ Stopped tracking <code>${escapeHtml(removed.username)}</code> in #${escapeHtml(removed.channel)}.`, { parse_mode: 'HTML' });
      
      if (twitchClient && !twitchTargets.some(t => t.channel === removed.channel)) {
        twitchClient.part(removed.channel).catch(err => console.error(`Failed to part #${removed.channel}:`, err));
      }
    }
    chatStates.delete(chatId);
  } else if (state.action === 'ADD_STEAM_INPUT') {
    chatStates.delete(chatId);
    processAddSteam(chatId, msg.text.trim());
  } else if (state.action === 'REMOVE_STEAM_TARGET') {
    chatStates.delete(chatId);
    const index = parseInt(msg.text.trim()) - 1;
    processRemoveSteam(chatId, index);
  }
});

function processAddSteam(chatId, input) {
  telegramBot.sendMessage(chatId, `🔍 Resolving Steam target: <code>${escapeHtml(input)}</code>...`, { parse_mode: 'HTML' });

  resolveSteamInput(input, async (err, steamID64) => {
    if (err) {
      telegramBot.sendMessage(chatId, `❌ <b>Failed to resolve Steam user:</b>\n${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
      return;
    }

    if (steamTargets.some(t => t.steamID64 === steamID64)) {
      const existing = steamTargets.find(t => t.steamID64 === steamID64);
      telegramBot.sendMessage(chatId, `⚠️ Already tracking Steam user <b>${escapeHtml(existing.label || steamID64)}</b> (<code>${steamID64}</code>).`, { parse_mode: 'HTML' });
      return;
    }

    const newTarget = {
      steamID64: steamID64,
      label: steamID64,
      addedAt: new Date().toISOString()
    };

    steamTargets.push(newTarget);
    saveTargets();

    const parsed = await fetchSingleSteamUser(steamID64);
    const initialLabel = parsed?.personaName || steamID64;
    newTarget.label = initialLabel;
    saveTargets();

    const statusStr = getSteamStatusString(steamID64);

    telegramBot.sendMessage(
      chatId,
      `✅ <b>Now tracking Steam target!</b>\nUser: <b>${escapeHtml(initialLabel)}</b>\nSteamID64: <code>${steamID64}</code>\nStatus: ${statusStr}`,
      { parse_mode: 'HTML' }
    );
  });
}

function processRemoveSteam(chatId, index) {
  if (isNaN(index) || index < 0 || index >= steamTargets.length) {
    telegramBot.sendMessage(chatId, '❌ Invalid number. Steam target removal cancelled.');
    return;
  }

  const removed = steamTargets.splice(index, 1)[0];
  saveTargets();
  steamStateCache.delete(removed.steamID64);

  telegramBot.sendMessage(
    chatId,
    `🗑️ Stopped tracking Steam user <b>${escapeHtml(removed.label || removed.steamID64)}</b> (<code>${removed.steamID64}</code>).`,
    { parse_mode: 'HTML' }
  );
}

// ==========================================
// STEAM STATUS MONITOR ENGINE
// ==========================================

const steamStateCache = new Map();

function getSteamStatusString(steamID64) {
  const cached = steamStateCache.get(steamID64);
  if (!cached) return '🔍 <i>Fetching status...</i>';
  if (!cached.isOnline) return '🔴 <b>Offline</b>';
  if (cached.isPlaying) {
    return `🟢 <b>Online</b> [Playing 🎮 <b>${escapeHtml(cached.gameName)}</b>]`;
  }
  return `🟢 <b>Online</b>`;
}

const lastNotificationTime = new Map();
const offlineStreakMap = new Map();
const notPlayingStreakMap = new Map();

function updateSteamStateCache(steamID64, rawState) {
  const targetObj = steamTargets.find(t => t.steamID64 === steamID64);
  const personaName = rawState.personaName || targetObj?.label || steamID64;

  if (targetObj && rawState.personaName && targetObj.label !== rawState.personaName) {
    targetObj.label = rawState.personaName;
    saveTargets();
  }

  const old = steamStateCache.get(steamID64);

  let effectiveIsOnline = rawState.isOnline;
  let effectiveIsPlaying = rawState.isPlaying;
  let effectiveGameName = rawState.gameName;

  if (old && old.isOnline) {
    if (!rawState.isOnline) {
      const streak = (offlineStreakMap.get(steamID64) || 0) + 1;
      offlineStreakMap.set(steamID64, streak);
      if (streak < 2) {
        effectiveIsOnline = true;
        effectiveIsPlaying = old.isPlaying;
        effectiveGameName = old.gameName;
      } else {
        effectiveIsOnline = false;
        effectiveIsPlaying = false;
        effectiveGameName = null;
      }
    } else {
      offlineStreakMap.set(steamID64, 0);
    }
  } else if (rawState.isOnline) {
    offlineStreakMap.set(steamID64, 0);
  }

  if (old && old.isOnline && effectiveIsOnline && old.isPlaying) {
    if (!rawState.isPlaying) {
      const streak = (notPlayingStreakMap.get(steamID64) || 0) + 1;
      notPlayingStreakMap.set(steamID64, streak);
      if (streak < 2) {
        effectiveIsPlaying = true;
        effectiveGameName = old.gameName;
      } else {
        effectiveIsPlaying = false;
        effectiveGameName = null;
      }
    } else {
      notPlayingStreakMap.set(steamID64, 0);
    }
  } else if (rawState.isPlaying) {
    notPlayingStreakMap.set(steamID64, 0);
  }

  const newState = {
    personaName,
    isOnline: effectiveIsOnline,
    isPlaying: effectiveIsPlaying,
    gameName: effectiveGameName,
    rawState: rawState.rawState
  };

  if (old) {
    if (!old.isOnline && newState.isOnline) {
      lastNotificationTime.set(steamID64, Date.now());
      const gameInfo = newState.isPlaying ? ` and started playing 🎮 <b>${escapeHtml(newState.gameName)}</b>` : '';
      const msg = `🟢 <b>STEAM USER ONLINE</b>\n` +
        `User: <b>${escapeHtml(personaName)}</b> is now Online${gameInfo}!\n` +
        `<code>SteamID: ${steamID64}</code>`;
      sendTelegramNotification(msg);
    } else if (old.isOnline && !newState.isOnline) {
      lastNotificationTime.set(steamID64, Date.now());
      const msg = `🔴 <b>STEAM USER OFFLINE</b>\n` +
        `User: <b>${escapeHtml(personaName)}</b> is now Offline.\n` +
        `<code>SteamID: ${steamID64}</code>`;
      sendTelegramNotification(msg);
    }

    if (old.isOnline && newState.isOnline) {
      if (!old.isPlaying && newState.isPlaying) {
        lastNotificationTime.set(steamID64, Date.now());
        const msg = `🎮 <b>STEAM USER STARTED PLAYING</b>\n` +
          `User: <b>${escapeHtml(personaName)}</b> started playing <b>${escapeHtml(newState.gameName)}</b>!\n` +
          `<code>SteamID: ${steamID64}</code>`;
        sendTelegramNotification(msg);
      } else if (old.isPlaying && !newState.isPlaying) {
        lastNotificationTime.set(steamID64, Date.now());
        const msg = `🛑 <b>STEAM USER STOPPED PLAYING</b>\n` +
          `User: <b>${escapeHtml(personaName)}</b> stopped playing <i>${escapeHtml(old.gameName)}</i>.\n` +
          `<code>SteamID: ${steamID64}</code>`;
        sendTelegramNotification(msg);
      } else if (old.isPlaying && newState.isPlaying && old.gameName !== newState.gameName) {
        lastNotificationTime.set(steamID64, Date.now());
        const msg = `🔄 <b>STEAM USER SWITCHED GAME</b>\n` +
          `User: <b>${escapeHtml(personaName)}</b> is now playing <b>${escapeHtml(newState.gameName)}</b> (was <i>${escapeHtml(old.gameName)}</i>).\n` +
          `<code>SteamID: ${steamID64}</code>`;
        sendTelegramNotification(msg);
      }
    }
  }

  steamStateCache.set(steamID64, {
    personaState: newState.rawState || (newState.isOnline ? 'Online' : 'Offline'),
    gameName: newState.gameName || null,
    personaName: personaName,
    isOnline: newState.isOnline,
    isPlaying: newState.isPlaying,
    lastUpdated: Date.now()
  });
}

function unescapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'");
}

function parseSteamHtml(htmlText, steamID64) {
  let personaName = null;
  const nameMatch = htmlText.match(/<span class="actual_persona_name">([\s\S]*?)<\/span>/i) ||
                    htmlText.match(/<span class="persona_name">([\s\S]*?)<\/span>/i) ||
                    htmlText.match(/<title>Steam Community :: ([^<]+)<\/title>/i);
  if (nameMatch) {
    personaName = unescapeHtml(nameMatch[1].replace(/<[^>]+>/g, '').trim());
  }

  let isOnline = false;
  let isPlaying = false;
  let gameName = null;
  let rawState = 'offline';

  const personaBlock = htmlText.match(/<div class="profile_in_game persona\s+([^"]+)"/i);
  if (personaBlock) {
    const cls = personaBlock[1].toLowerCase();
    rawState = cls;
    if (cls.includes('in-game')) {
      isOnline = true;
      isPlaying = true;
    } else if (cls.includes('online') || cls.includes('away') || cls.includes('snooze') || cls.includes('busy')) {
      isOnline = true;
    }
  }

  const headerMatch = htmlText.match(/<div class="profile_in_game_header">([\s\S]*?)<\/div>/i);
  if (headerMatch) {
    const headerText = headerMatch[1].trim().toLowerCase();
    if (headerText.includes('in-game')) {
      isOnline = true;
      isPlaying = true;
    } else if (headerText.includes('online')) {
      isOnline = true;
    }
  }

  const gameMatch = htmlText.match(/<div class="profile_in_game_name">([\s\S]*?)<\/div>/i);
  if (gameMatch) {
    gameName = unescapeHtml(gameMatch[1].replace(/<[^>]+>/g, '').trim());
    if (gameName && gameName.length > 0) {
      isPlaying = true;
      isOnline = true;
    }
  }

  if (!gameName) {
    const jsGameMatch = htmlText.match(/"game_name"\s*:\s*"([^"]+)"/i);
    if (jsGameMatch) {
      gameName = unescapeHtml(jsGameMatch[1].trim());
      if (gameName) {
        isPlaying = true;
        isOnline = true;
      }
    }
  }

  return {
    steamID64,
    personaName: personaName || steamID64,
    isOnline,
    isPlaying: Boolean(isPlaying && gameName),
    gameName: isPlaying ? gameName : null,
    rawState
  };
}

function parseSteamMiniprofile(htmlText, steamID64) {
  let isOnline = false;
  let isPlaying = false;
  let gameName = null;
  let personaName = steamID64;

  const nameMatch = htmlText.match(/<span class="persona\s+([^"]+)">([\s\S]*?)<\/span>/i);
  if (nameMatch) {
    const cls = nameMatch[1].toLowerCase();
    personaName = unescapeHtml(nameMatch[2].replace(/<[^>]+>/g, '').trim());
    if (cls.includes('in-game')) {
      isOnline = true;
      isPlaying = true;
    } else if (cls.includes('online') || cls.includes('away') || cls.includes('snooze') || cls.includes('busy')) {
      isOnline = true;
    }
  }

  const gameMatch = htmlText.match(/<span class="miniprofile_game_name">([\s\S]*?)<\/span>/i) ||
                    htmlText.match(/<div class="miniprofile_game_name">([\s\S]*?)<\/div>/i) ||
                    htmlText.match(/<span class="game_name">([\s\S]*?)<\/span>/i) ||
                    htmlText.match(/<div class="game_name">([\s\S]*?)<\/div>/i);
  if (gameMatch) {
    gameName = unescapeHtml(gameMatch[1].replace(/<[^>]+>/g, '').trim());
    if (gameName) {
      isPlaying = true;
      isOnline = true;
    }
  }

  return {
    steamID64,
    personaName,
    isOnline,
    isPlaying: Boolean(isPlaying && gameName),
    gameName: isPlaying ? gameName : null,
    rawState: isPlaying ? 'in-game' : (isOnline ? 'online' : 'offline')
  };
}

function parseSteamXml(xmlText, steamID64) {
  const getTag = (tag, context = xmlText) => {
    const reg = new RegExp(`<${tag}(?:>|\\s[^>]*>)([\\s\\S]*?)</${tag}>`, 'i');
    const m = context.match(reg);
    if (!m) return null;
    let val = m[1].trim();
    if (val.startsWith('<![CDATA[')) {
      val = val.slice(9, -3).trim();
    }
    return val;
  };

  const personaName = getTag('steamID') || getTag('steamID64') || steamID64;
  const onlineStateRaw = (getTag('onlineState') || 'offline').toLowerCase();
  
  let gameName = null;

  const stateMsg = getTag('stateMessage');
  if (stateMsg && (stateMsg.toLowerCase().includes('in-game') || stateMsg.includes('<br'))) {
    const parts = stateMsg.split(/<br\s*\/?>/i);
    if (parts.length > 1) {
      gameName = parts[1].replace(/<[^>]+>/g, '').trim();
    }
  }

  if (!gameName) {
    const inGameBlock = xmlText.match(/<inGameInfo>([\s\S]*?)<\/inGameInfo>/i);
    if (inGameBlock) {
      gameName = getTag('gameName', inGameBlock[1]);
    }
  }

  if (!gameName) {
    gameName = getTag('inGameExtraInfo') || getTag('gameExtraInfo');
  }

  const isPlaying = Boolean(gameName && gameName.length > 0);
  const isOnline = isPlaying || (onlineStateRaw !== 'offline' && onlineStateRaw !== '');

  return {
    steamID64,
    personaName,
    isOnline,
    isPlaying,
    gameName: isPlaying ? gameName : null,
    rawState: onlineStateRaw
  };
}

async function fetchSingleSteamUser(steamID64) {
  try {
    const url = `https://steamcommunity.com/profiles/${steamID64}/?_=${Date.now()}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      }
    });
    if (res.ok) {
      const htmlText = await res.text();
      const parsed = parseSteamHtml(htmlText, steamID64);
      if (parsed) {
        updateSteamStateCache(steamID64, parsed);
        return parsed;
      }
    }
  } catch (err) {
    console.error(`Error fetching Steam HTML for ${steamID64}:`, err.message);
  }

  try {
    const accountId = (BigInt(steamID64) - 76561197960265728n).toString();
    const miniUrl = `https://steamcommunity.com/miniprofile/${accountId}?_=${Date.now()}`;
    const miniRes = await fetch(miniUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      }
    });
    if (miniRes.ok) {
      const miniHtml = await miniRes.text();
      const parsed = parseSteamMiniprofile(miniHtml, steamID64);
      if (parsed) {
        updateSteamStateCache(steamID64, parsed);
        return parsed;
      }
    }
  } catch (err) {
    console.error(`Error fetching Steam Miniprofile for ${steamID64}:`, err.message);
  }

  try {
    const xmlUrl = `https://steamcommunity.com/profiles/${steamID64}/?xml=1&_=${Date.now()}`;
    const xmlRes = await fetch(xmlUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      }
    });
    if (xmlRes.ok) {
      const xmlText = await xmlRes.text();
      const parsed = parseSteamXml(xmlText, steamID64);
      if (parsed) {
        updateSteamStateCache(steamID64, parsed);
        return parsed;
      }
    }
  } catch (err) {
    console.error(`Error fetching Steam XML for ${steamID64}:`, err.message);
  }

  return null;
}

async function pollAllSteamTargets() {
  if (steamTargets.length === 0) return;

  const STEAM_API_KEY = process.env.STEAM_API_KEY;

  if (STEAM_API_KEY && STEAM_API_KEY.trim()) {
    try {
      const ids = steamTargets.map(t => t.steamID64).join(',');
      const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY.trim()}&steamids=${ids}`;
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        const players = json?.response?.players || [];
        for (const player of players) {
          const sid = player.steamid;
          const isOnline = (player.personastate ?? 0) > 0;
          const gameName = player.gameextrainfo || null;
          const isPlaying = isOnline && Boolean(gameName);
          updateSteamStateCache(sid, {
            personaName: player.personaname,
            isOnline,
            isPlaying,
            gameName,
            rawState: player.personastate
          });
        }
        return;
      }
    } catch (e) {
      console.error('Steam Web API poll error, falling back to scrapers:', e.message);
    }
  }

  for (const target of steamTargets) {
    await fetchSingleSteamUser(target.steamID64);
  }
}

async function resolveSteamInput(input, callback) {
  if (!input || typeof input !== 'string') {
    return callback(new Error('Invalid input string.'));
  }
  let clean = input.trim().replace(/\/+$/, '');

  if (clean.includes('steamcommunity.com')) {
    const profileMatch = clean.match(/\/profiles\/(\d{17})/i);
    if (profileMatch) {
      clean = profileMatch[1];
    } else {
      const idMatch = clean.match(/\/id\/([^\/]+)/i);
      if (idMatch) {
        clean = idMatch[1];
      }
    }
  }

  if (/^\d{17}$/.test(clean)) {
    try {
      const sid = new SteamID(clean);
      if (sid.isValid() && sid.type === SteamID.Type.INDIVIDUAL) {
        return callback(null, sid.getSteamID64());
      }
    } catch (e) {}
  }

  try {
    const url = clean.startsWith('http') ? `${clean}/?xml=1` : `https://steamcommunity.com/id/${clean}/?xml=1`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (res.ok) {
      const xmlText = await res.text();
      const match = xmlText.match(/<steamID64>(\d{17})<\/steamID64>/i);
      if (match && match[1]) {
        return callback(null, match[1]);
      }
    }
  } catch (err) {
    console.error('XML vanity resolve error:', err.message);
  }

  try {
    const url = clean.startsWith('http') ? clean : `https://steamcommunity.com/id/${clean}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (res.ok) {
      const htmlText = await res.text();
      const match = htmlText.match(/"steamid"\s*:\s*"(\d{17})"/i);
      if (match && match[1]) {
        return callback(null, match[1]);
      }
    }
  } catch (err) {
    console.error('HTML vanity resolve error:', err.message);
  }

  return callback(new Error(`Could not resolve Steam user "${input}". Please provide a valid 17-digit SteamID64 or custom profile URL.`));
}

// ==========================================
// TWITCH IRC CLIENT (`tmi.js`)
// ==========================================
let twitchClient = null;

function initTwitchClient() {
  const uniqueTwitchChannels = [...new Set(twitchTargets.map(t => t.channel))];
  twitchClient = new tmi.Client({
    connection: { secure: true, reconnect: true },
    channels: uniqueTwitchChannels
  });

  twitchClient.connect().then(() => {
    console.log(`✅ Connected to Twitch IRC (${uniqueTwitchChannels.length} channels).`);
  }).catch(console.error);

  twitchClient.on('names', (channel, users) => {
    const chan = channel.replace(/^#/, '');
    totalNamesReceived.set(chan, (totalNamesReceived.get(chan) || 0) + users.length);
    
    const targetsInChannel = twitchTargets.filter(t => t.channel === chan);
    for (const target of targetsInChannel) {
      const key = `${chan}:${target.username}`;
      if (!notifiedTwitchUsers.has(key) && users.includes(target.username)) {
        notifiedTwitchUsers.add(key);
        const msg = `👀 <b>TWITCH TARGET FOUND</b>: <code>${escapeHtml(target.username)}</code> is already sitting in #${escapeHtml(chan)}!`;
        console.log(msg);
        sendTelegramNotification(msg);
      }
    }
  });

  twitchClient.on('join', (channel, username, self) => {
    const chan = channel.replace(/^#/, '');
    if (self) return;
    
    const isTarget = twitchTargets.some(t => t.channel === chan && t.username === username.toLowerCase());
    if (isTarget) {
      const key = `${chan}:${username.toLowerCase()}`;
      notifiedTwitchUsers.add(key);
      const msg = `🟢 <b>TWITCH TARGET JOINED</b>: <code>${escapeHtml(username)}</code> entered #${escapeHtml(chan)}`;
      console.log(msg);
      sendTelegramNotification(msg);
    }
  });

  twitchClient.on('part', (channel, username, self) => {
    if (self) return;
    const chan = channel.replace(/^#/, '');
    const isTarget = twitchTargets.some(t => t.channel === chan && t.username === username.toLowerCase());
    if (isTarget) {
      const key = `${chan}:${username.toLowerCase()}`;
      notifiedTwitchUsers.delete(key);
      const msg = `🔴 <b>TWITCH TARGET LEFT</b>: <code>${escapeHtml(username)}</code> left #${escapeHtml(chan)}`;
      console.log(msg);
      sendTelegramNotification(msg);
    }
  });

  twitchClient.on('message', (channel, tags, message, self) => {
    if (self) return;
    const chan = channel.replace(/^#/, '');
    const username = tags.username?.toLowerCase();
    if (!username) return;

    const isTarget = twitchTargets.some(t => t.channel === chan && t.username === username);
    if (isTarget) {
      const msg = `💬 <b>TWITCH TARGET SPOKE</b>: <code>${escapeHtml(username)}</code> in #${escapeHtml(chan)}: "${escapeHtml(message)}"`;
      console.log(msg);
      sendTelegramNotification(msg);
    }
  });
}

// ==========================================
// EXPRESS HEALTH SERVER (INTERNAL + EXTERNAL PINGER READY)
// ==========================================

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.status(200).send('Twitch & Steam Telegram Tracker Bot is running!');
});

// Dedicated endpoint for external pingers (cron-job.org, UptimeRobot, etc.) & internal self-ping
app.all(['/ping', '/health'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Web server listening on port ${PORT}`);

  // Internal Self-Pinger (runs alongside your external pinger unless DISABLE_SELF_PING=true)
  if (APP_URL && process.env.DISABLE_SELF_PING !== 'true') {
    const pingUrl = `${APP_URL.replace(/\/+$/, '')}/ping`;
    console.log(`⏰ Internal self-pinger active for: ${pingUrl}`);
    setInterval(async () => {
      try {
        const res = await fetch(pingUrl);
        console.log(`💓 Internal self-ping status: ${res.status}`);
      } catch (err) {
        console.error(`⚠️ Internal self-ping failed:`, err.message);
      }
    }, 10 * 60 * 1000);
  }
});

// ==========================================
// ASYNC BOOTSTRAP
// ==========================================
(async () => {
  await loadTargets();
  initTwitchClient();
  setInterval(pollAllSteamTargets, 5000);
  setTimeout(pollAllSteamTargets, 1500);
})();