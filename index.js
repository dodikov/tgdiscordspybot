console.log("🚀 Starting Combined Tracker Bots...");

// 1. Start Twitch & Steam Tracker (also starts the Express server on PORT)
require("./steam.js");

// 2. Start Discord Presence & Voice Tracker
require("./discord.js");
