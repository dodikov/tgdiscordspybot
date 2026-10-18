const { Client } = require("discord.js-selfbot-v13");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

let trackingConfig = {
  users: [],
  servers: [],
  channels: [],
  statusUsers: []
};

const TRACKING_FILE = path.join(process.cwd(), "tracking_config.json");

function loadTrackingConfig() {
  if (fs.existsSync(TRACKING_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8'));
      trackingConfig.users = data.users || [];
      trackingConfig.servers = data.servers || [];
      trackingConfig.channels = data.channels || [];
      trackingConfig.statusUsers = data.statusUsers || [];
    } catch (e) {
      console.error("Failed to parse tracking_config.json", e);
    }
  } else {
    // Target can also be populated from env variable for first run
    const fromEnv = process.env.TARGET_DISCORD_USER_ID;
    if (fromEnv) {
      trackingConfig.users = fromEnv.split(',').map(id => id.trim()).filter(Boolean);
      saveTrackingConfig();
    }
  }
}

function saveTrackingConfig() {
  try {
    fs.writeFileSync(TRACKING_FILE, JSON.stringify(trackingConfig, null, 2));
  } catch (e) {
    console.error("Failed to save tracking_config.json", e);
  }
}

function startBots() {
  const discordToken = process.env.DISCORD_USER_TOKEN;
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;

  loadTrackingConfig();

  if (!discordToken || !telegramToken || !telegramChatId) {
    console.log("Missing configuration! Set DISCORD_USER_TOKEN, TELEGRAM_BOT_TOKEN, and TELEGRAM_CHAT_ID.");
    return;
  }

  try {
    const telegramBot = new TelegramBot(telegramToken, { polling: true });

    telegramBot.on("message", async (msg) => {
      if (msg.chat && msg.chat.id) {
        if (msg.text?.startsWith('/start') || msg.text?.startsWith('/id')) {
           telegramBot.sendMessage(msg.chat.id, `Your Telegram Chat ID is: ${msg.chat.id}\nCopy this into the TELEGRAM_CHAT_ID environment variable.`).catch(console.error);
        }
        
        const text = msg.text || '';
        const args = text.split(' ');
        const command = args[0];
        const newId = args[1];

        if (['/add', '/remove', '/addserver', '/removeserver', '/addchannel', '/removechannel', '/status', '/removestatus'].includes(command)) {
          if (!newId || !/^\d+$/.test(newId)) {
            telegramBot.sendMessage(msg.chat.id, `Please provide a valid Discord ID.\nUsage: <code>${command} 1234567890</code>`, { parse_mode: 'HTML' }).catch(console.error);
            return;
          }
          
          let listArr = trackingConfig.users;
          let label = "user";
          if (command.includes('server')) { listArr = trackingConfig.servers; label = "server"; }
          else if (command.includes('channel')) { listArr = trackingConfig.channels; label = "channel"; }
          else if (command.includes('status')) { listArr = trackingConfig.statusUsers || []; label = "status tracking user"; }

          const isAdd = ['/add', '/addserver', '/addchannel', '/status'].includes(command);
          
          if (isAdd) {
            if (listArr.includes(newId)) {
              telegramBot.sendMessage(msg.chat.id, `ID <code>${newId}</code> is already in the ${label} list.`, { parse_mode: 'HTML' }).catch(console.error);
              return;
            }
            listArr.push(newId);
          } else {
            if (!listArr.includes(newId)) {
              telegramBot.sendMessage(msg.chat.id, `ID <code>${newId}</code> is not in the ${label} list.`, { parse_mode: 'HTML' }).catch(console.error);
              return;
            }
            listArr.splice(listArr.indexOf(newId), 1);
          }
          
          if (command.includes('status')) trackingConfig.statusUsers = listArr;

          saveTrackingConfig();
          telegramBot.sendMessage(msg.chat.id, `✅ ${isAdd ? 'Added' : 'Removed'} ${label} <code>${newId}</code> ${isAdd ? 'to' : 'from'} tracking list.`, { parse_mode: 'HTML' }).catch(console.error);
        }

        if (command === '/list') {
          if (!discordClient || !discordClient.isReady()) {
            telegramBot.sendMessage(msg.chat.id, `Discord bot is not ready yet.`).catch(console.error);
            return;
          }
          
          telegramBot.sendMessage(msg.chat.id, `🔄 <i>Fetching current status, please wait...</i>`, { parse_mode: "HTML" }).catch(console.error);

          const allTrackerUsers = Array.from(new Set([...trackingConfig.users, ...(trackingConfig.statusUsers || [])]));

          if (allTrackerUsers.length > 0) {
            const guildsToScan = trackingConfig.servers.length > 0 
              ? trackingConfig.servers 
              : Array.from(discordClient.guilds.cache.keys());

            for (const guildId of guildsToScan) {
              const guild = discordClient.guilds.cache.get(guildId);
              if (guild) {
                try {
                  for (const uid of allTrackerUsers) {
                    guild.presences.cache.delete(uid);
                  }
                  await guild.members.fetch({ user: allTrackerUsers, withPresences: true });
                } catch (err) {}
              }
            }
          }

          let response = `📋 <b>Tracked Users:</b>\n`;
          if (allTrackerUsers.length === 0) response += `<i>None</i>\n`;
          for (const id of allTrackerUsers) {
            let userTags = [];
            if (trackingConfig.users.includes(id)) userTags.push("Voice");
            if (trackingConfig.statusUsers?.includes(id)) userTags.push("Status");
            const tagsStr = userTags.length ? ` [${userTags.join(', ')}]` : '';

            let currentStatus = 'offline';
            for (const guild of discordClient.guilds.cache.values()) {
              const pres = guild.presences.cache.get(id);
              if (pres && pres.status && pres.status !== 'offline') {
                currentStatus = pres.status;
                break;
              }
            }
            const statusEmoji = currentStatus === 'online' ? '🟢' : currentStatus === 'idle' ? '🌙' : currentStatus === 'dnd' ? '🔴' : '⚪';

            try {
              const user = await discordClient.users.fetch(id);
              const safeUsername = user.username.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              response += `• ${statusEmoji} <b>${safeUsername}</b> (<code>${id}</code>)${tagsStr}\n`;
            } catch (err) {
              response += `• ${statusEmoji} <b>Unknown User</b> (<code>${id}</code>)${tagsStr}\n`;
            }
          }

          response += `\n🏢 <b>Tracked Servers (Guilds):</b>\n`;
          if (trackingConfig.servers.length === 0) response += `<i>All (No filter)</i>\n`;
          for (const id of trackingConfig.servers) {
            try {
              const guild = await discordClient.guilds.fetch(id);
              const safeGuild = guild.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              response += `• <b>${safeGuild}</b> (<code>${id}</code>)\n`;
            } catch (err) {
              response += `• <b>Unknown Server</b> (<code>${id}</code>)\n`;
            }
          }

          response += `\n🎤 <b>Tracked Channels:</b>\n`;
          if (trackingConfig.channels.length === 0) response += `<i>All (No filter)</i>\n`;
          for (const id of trackingConfig.channels) {
            try {
              const channel = await discordClient.channels.fetch(id);
              const name = channel.name || 'Unknown';
              response += `• <b>${name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</b> (<code>${id}</code>)\n`;
            } catch (err) {
              response += `• <b>Unknown Channel</b> (<code>${id}</code>)\n`;
            }
          }
          
          telegramBot.sendMessage(msg.chat.id, response, { parse_mode: "HTML" }).catch(console.error);
        }
      }
    });

    console.log("Telegram bot active.");

    const discordClient = new Client({
      checkUpdate: false,
      syncStatus: true
    });

    const knownPresences = {};

    function checkPresencesManually() {
      if (!discordClient || !telegramBot) return;

      const allUsersToCheck = Array.from(new Set([...trackingConfig.users, ...(trackingConfig.statusUsers || [])]));

      for (const userId of allUsersToCheck) {
        let currentStatus = 'offline';
        
        for (const guild of discordClient.guilds.cache.values()) {
          const pres = guild.presences.cache.get(userId);
          if (pres && pres.status && pres.status !== 'offline') {
            currentStatus = pres.status;
            break;
          }
        }
        
        const oldStatus = knownPresences[userId] || 'offline';
        if (oldStatus !== currentStatus) {
          knownPresences[userId] = currentStatus;
          
          if (trackingConfig.statusUsers && trackingConfig.statusUsers.includes(userId)) {
            let statusEmoji = '⚪';
            if (currentStatus === 'online') statusEmoji = '🟢';
            if (currentStatus === 'idle') statusEmoji = '🌙';
            if (currentStatus === 'dnd') statusEmoji = '🔴';
            
            const userObj = discordClient.users.cache.get(userId);
            const username = userObj?.username || 'Target User';
            const safeUsername = username.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const message = `${statusEmoji} <b>${safeUsername}</b>'s status changed: \nFrom: <code>${oldStatus}</code> \nTo: <code>${currentStatus}</code>`;
            
            telegramBot.sendMessage(telegramChatId, message, { parse_mode: "HTML" }).catch(console.error);
          }
        }
      }
    }

    discordClient.on('ready', () => {
      console.log(`Discord bot logged in as ${discordClient?.user?.tag}`);

      setInterval(async () => {
        const allUsersToCheck = Array.from(new Set([...trackingConfig.users, ...(trackingConfig.statusUsers || [])]));
        if (!discordClient || !discordClient.isReady() || allUsersToCheck.length === 0) return;
        
        const guildsToScan = trackingConfig.servers.length > 0 
          ? trackingConfig.servers 
          : Array.from(discordClient.guilds.cache.keys());

        for (const guildId of guildsToScan) {
          const guild = discordClient.guilds.cache.get(guildId);
          if (guild) {
            try {
              for (const uid of allUsersToCheck) {
                guild.presences.cache.delete(uid);
              }
              await guild.members.fetch({ user: allUsersToCheck, withPresences: true });
            } catch (err) { }
          }
        }
        
        checkPresencesManually();
      }, 20000);
    });

    discordClient.on('presenceUpdate', (oldPresence, newPresence) => {
      const allUsersToCheck = Array.from(new Set([...trackingConfig.users, ...(trackingConfig.statusUsers || [])]));
      if (allUsersToCheck.includes(newPresence.userId)) {
        checkPresencesManually();
      }
    });

    discordClient.on('voiceStateUpdate', (oldState, newState) => {
      if (!trackingConfig.users.includes(newState.id)) return;
      
      if (trackingConfig.servers.length > 0) {
        if (!trackingConfig.servers.includes(newState.guild.id)) return;
      }
      
      const isOldConnected = !!oldState.channelId;
      const isNewConnected = !!newState.channelId;
      
      const isOldTracked = isOldConnected && (trackingConfig.channels.length === 0 || trackingConfig.channels.includes(oldState.channelId));
      const isNewTracked = isNewConnected && (trackingConfig.channels.length === 0 || trackingConfig.channels.includes(newState.channelId));

      if (!isOldTracked && !isNewTracked) return;

      const fetchUsername = newState.member?.user.username || newState.client.users.cache.get(newState.id)?.username || 'Target User';
      const guildName = newState.guild.name;

      const safeUsername = fetchUsername.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const safeGuildName = guildName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      if (!isOldTracked && isNewTracked) {
        const channelName = newState.channel?.name || 'Unknown Channel';
        const safeChannelName = channelName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const message = `🎤 <b>${safeUsername}</b> joined voice channel <code>${safeChannelName}</code> in server <code>${safeGuildName}</code>`;
        telegramBot.sendMessage(telegramChatId, message, { parse_mode: "HTML" }).catch(console.error);
      } 
      else if (isOldTracked && !isNewTracked) {
        const oldChannelName = oldState.channel?.name || 'Unknown Channel';
        const safeOldChannelName = oldChannelName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const message = `👋 <b>${safeUsername}</b> left voice channel <code>${safeOldChannelName}</code> in server <code>${safeGuildName}</code>`;
        telegramBot.sendMessage(telegramChatId, message, { parse_mode: "HTML" }).catch(console.error);
      }
      else if (isOldTracked && isNewTracked && oldState.channelId !== newState.channelId) {
        const oldChannelName = oldState.channel?.name || 'Unknown Channel';
        const newChannelName = newState.channel?.name || 'Unknown Channel';
        const safeOldChannelName = oldChannelName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeNewChannelName = newChannelName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const message = `🔄 <b>${safeUsername}</b> moved from <code>${safeOldChannelName}</code> to <code>${safeNewChannelName}</code> in server <code>${safeGuildName}</code>`;
        telegramBot.sendMessage(telegramChatId, message, { parse_mode: "HTML" }).catch(console.error);
      }
    });

    discordClient.login(discordToken).catch(err => {
      console.error("Failed to login to Discord.", err.message);
    });

  } catch (error) {
    console.error("Error setting up bots:", error);
  }
}

startBots();
