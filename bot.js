// =================================================================================================
// DÉPENDANCES ET CONFIGURATION INITIALE
// =================================================================================================

const { Telegraf } = require('telegraf');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// --- CONFIG EXTERNE (FOURNI PAR L'UTILISATEUR) ---
const CONFIG = require('./config'); // Doit exposer: { TELEGRAM_TOKEN, CHANNEL_INVITE_LINK, GROUP_LINK, owner: [ids...] }
const TELEGRAM_BOT_TOKEN = CONFIG.TELEGRAM_TOKEN;

// --- CHEMINS DES FICHIERS ---
const DB_DIR = path.join(__dirname, 'db');
const DATABASE_DIR = path.join(__dirname, 'database');
const RENT_SESSION_DIR = path.join(__dirname, 'rent-session');
const IMAGES_DIR = path.join(__dirname, 'images');

[DB_DIR, DATABASE_DIR, RENT_SESSION_DIR, IMAGES_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- IMAGES (UTILISÉES POUR QUELQUES RÉPONSES) ---
const IMG_WELCOME = { source: path.join(IMAGES_DIR, 'welcome.png') };
const IMG_MENU = { source: path.join(IMAGES_DIR, 'menu.png') };
const IMG_SUCCESS = { source: path.join(IMAGES_DIR, 'success.png') };
const IMG_ERROR = { source: path.join(IMAGES_DIR, 'error.png') };
const IMG_PAIR = { source: path.join(IMAGES_DIR, 'pair.png') };

// =================================================================================================
// DB HELPERS
// =================================================================================================

const ensureFile = (filePath, initial) => {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, initial, 'utf-8');
};
const readJson = (filePath) => {
  ensureFile(filePath, '{}');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
};
const saveJson = (filePath, data) =>
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

const loadJson = (filePath) => {
  if (!fs.existsSync(filePath)) {
    const stub = filePath.includes('user_numbers') ? {} : [];
    fs.writeFileSync(filePath, JSON.stringify(stub, null, 2), 'utf-8');
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
};

// --- FICHIERS DB ---
const USER_NUMBERS_FILE = path.join(DATABASE_DIR, 'user_numbers.json');
const PREMIUM_FILE = path.join(DATABASE_DIR, 'premium.json');
const OWNER_FILE = path.join(DATABASE_DIR, 'Owner.json');

let db = {
  userNumbers: loadJson(USER_NUMBERS_FILE), // { [chatId]: "2250..." }
  premiumUsers: loadJson(PREMIUM_FILE), // [userId, ...]
  OwnerUsers: loadJson(OWNER_FILE), // Resellers/Owners additionnels (en plus de CONFIG.owner)
};

// =================================================================================================
/* UTILITAIRES COMMUNS */
// =================================================================================================

const sessions = new Map(); // number -> WA sock
const whatsappStatusMap = new Map(); // number -> bool
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_COMMANDS_PER_WINDOW = 5;
const startTime = new Date();

function sanitizePath(input) {
  return path.basename(input.replace(/[^0-9]/g, ''));
}
function isValidPhoneNumber(number) {
  const cleaned = number.replace(/[^0-9+]/g, '');
  const phoneRegex = /^\+\d{8,15}$/;
  return phoneRegex.test(cleaned);
}
function checkRateLimit(senderId, chatId, bot) {
  const now = Date.now();
  let userLimit = rateLimits.get(senderId);
  if (!userLimit || now - userLimit.lastReset > RATE_LIMIT_WINDOW) {
    rateLimits.set(senderId, { count: 1, lastReset: now });
    return true;
  }
  if (userLimit.count >= MAX_COMMANDS_PER_WINDOW) {
    bot.telegram.sendMessage(
      chatId,
      `❌ Rate limit exceeded. Try again in ${Math.ceil(
        (RATE_LIMIT_WINDOW - (now - userLimit.lastReset)) / 1000
      )} seconds.`
    );
    return false;
  }
  userLimit.count++;
  return true;
}
function getOnlineDuration() {
  const onlineDuration = new Date() - startTime;
  const seconds = Math.floor((onlineDuration / 1000) % 60);
  const minutes = Math.floor((onlineDuration / (1000 * 60)) % 60);
  const hours = Math.floor((onlineDuration / (1000 * 60 * 60)) % 24);
  return `${hours.toString().padStart(2, '0')}:${minutes
    .toString()
    .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}
async function deleteFolderRecursive(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).forEach((file) => {
        const curPath = path.join(dir, file);
        if (fs.lstatSync(curPath).isDirectory()) {
          fs.rmSync(curPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(curPath);
        }
      });
      fs.rmdirSync(dir, { recursive: true });
      console.log(`Deleted session folder: ${dir}`);
    }
  } catch (err) {
    console.error(`Error deleting folder ${dir}:`, err.message);
  }
}
const isOwner = (userId) =>
  CONFIG.owner.includes(userId) || db.OwnerUsers.includes(userId);

// =================================================================================================
/* LOGIQUE WHATSAPP (BAILEYS) — INCHANGÉE DANS SON COMPORTEMENT */
// =================================================================================================

async function getSessions(bot, chatId, number) {
  if (!number) {
    if (bot && chatId)
      await bot.telegram.sendMessage(chatId, '❌ Erreur interne: Numéro invalide.');
    return;
  }
  if (!/^\d{8,15}$/.test(number)) {
    if (bot && chatId)
      await bot.telegram.sendMessage(
        chatId,
        `❌ Format de numéro invalide : ${number}.`
      );
    return;
  }

  const sessionDir = path.join(
    RENT_SESSION_DIR,
    `${sanitizePath(number)}@s.whatsapp.net`
  );

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
    });

    sessions.set(number, sock);
    whatsappStatusMap.set(number, true);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        sessions.delete(number);
        whatsappStatusMap.delete(number);

        if (shouldReconnect) {
          setTimeout(() => getSessions(null, null, number), 5000);
        } else {
          // Nettoyage si déconnexion volontaire/loggedOut
          const chatIdToDelete = Object.keys(db.userNumbers).find(
            (key) => db.userNumbers[key] === number
          );
          if (chatIdToDelete) {
            delete db.userNumbers[chatIdToDelete];
            saveJson(USER_NUMBERS_FILE, db.userNumbers);
          }
          if (fs.existsSync(sessionDir))
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      } else if (connection === 'open') {
        if (bot && chatId) {
          db.userNumbers[chatId] = number;
          saveJson(USER_NUMBERS_FILE, db.userNumbers);
          await bot.telegram.sendMessage(
            chatId,
            `✅ Le numéro *${number}* est connecté.`,
            { parse_mode: 'Markdown' }
          );
        }
        // Message d'accueil côté WhatsApp (image locale si dispo)
        try {
          const imgPath = path.join(IMAGES_DIR, 'welcome.png');
          if (fs.existsSync(imgPath)) {
            await sock.sendMessage(sock.user.id, {
              image: fs.readFileSync(imgPath),
              caption:
                "👋 Bonjour ! Je suis maintenant connecté. Tapez `.menu` pour voir les commandes.",
            });
          } else {
            await sock.sendMessage(sock.user.id, {
              text:
                "👋 Bonjour ! Je suis maintenant connecté. Tapez `.menu` pour voir les commandes.",
            });
          }
        } catch (e) {
          console.warn('Welcome message to WA user failed:', e.message);
        }
      } else if (connection === 'connecting') {
        if (!bot || !chatId) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const pairingCode = await sock.requestPairingCode(
            number.replace(/\D/g, '')
          );
          const formattedCode =
            pairingCode?.match(/.{1,4}/g)?.join('-') || pairingCode;
          await bot.telegram.sendMessage(
            chatId,
            `
┌──────┤ Pairing Code ├──────┐
│➻ Numéro: ${number}
│➻ Code: *${formattedCode}*
└────────────────────────┘`,
            { parse_mode: 'Markdown' }
          );
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);
  } catch (error) {
    console.error(`Erreur dans getSessions pour ${number}:`, error.message);
    if (bot && chatId) {
      await bot.telegram.sendMessage(
        chatId,
        `❌ Échec de l'initialisation pour ${number}.`
      );
    }
  }
}

// =================================================================================================
/* BOT TELEGRAM (TELEGRAF) — NOUVELLES FONCTIONNALITÉS INTÉGRÉES */
// =================================================================================================

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// /start + inline menu
const sendStartMenu = async (ctx) => {
  const senderName = ctx.from.username ? `@${ctx.from.username}` : `${ctx.from.id}`;
  const isPremium = db.premiumUsers.includes(ctx.from.id);
  const caption = `
┌──────┤ Xeon Bot ├──────┐
│➻ Name: ${senderName}
│➻ Developer: @dgxeon13
│➻ Status: ${isPremium ? 'Premium' : 'No Access'}
│➻ Online: ${getOnlineDuration()}
└──────────────────────┘
┌──────┤ Press Button Menu ├──────┐
└────────────────────────┘`;

  await ctx.replyWithPhoto(
    'https://i.ibb.co/4ng6VsgM/Picsart-25-06-01-01-02-32-207.jpg',
    {
      caption,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '〢Menu', callback_data: 'menu' },
            { text: '〢Misc Menu', callback_data: 'miscmenu' },
          ],
          [{ text: '〢Channel', url: CONFIG.CHANNEL_INVITE_LINK }],
          [{ text: '〢Group', url: CONFIG.GROUP_LINK }],
        ],
      },
    }
  );
};

bot.start(async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  await sendStartMenu(ctx);
});
bot.command('menu', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  await sendStartMenu(ctx);
});
bot.on('callback_query', async (ctx) => {
  if (ctx.chat?.type !== 'private') return;
  const data = ctx.callbackQuery?.data;
  if (data === 'menu') {
    await ctx.answerCbQuery('Menu opened ✅');
    await ctx.replyWithPhoto(IMG_MENU, {
      caption:
        '*🤖 Menu*\n\n/reqpair +num\n/delpair +num\n/addprem id\n/delprem id\n/listprem\n/addresell id\n/delresell id\n/listresell\n/listuser',
      parse_mode: 'Markdown',
    });
  } else if (data === 'miscmenu') {
    await ctx.answerCbQuery('Misc menu ✅');
    await ctx.replyWithPhoto(IMG_MENU, {
      caption: '*📦 Misc Menu*\n\n- Coming soon -',
      parse_mode: 'Markdown',
    });
  }
});

// /reqpair — Premium requis + Rate Limit
bot.command('reqpair', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const chatId = ctx.chat.id;
  const senderId = ctx.from.id;

  if (!checkRateLimit(senderId, chatId, bot)) return;
  if (!db.premiumUsers.includes(senderId)) {
    return ctx.reply(
      `🚫 You are not authorized to use this command.\n\n📩 Please contact the developer to buy: @DGXeon13\n\n💰 Price/Harga:\n✅ Access permanent: 15$\n✅ Resell permanent: 25$\n✅ Script no enc 100%: 100$`
    );
  }

  const parts = ctx.message.text.split(' ');
  const raw = parts[1];
  if (!raw)
    return ctx.reply(
      '❌ Provide a phone number.\nExample: /reqpair +919876543210'
    );
  if (!isValidPhoneNumber(raw))
    return ctx.reply(
      '❌ Invalid phone number. Use international format (e.g., +919876543210).'
    );

  const numberTarget = raw.replace(/[^0-9+]/g, '').replace(/^\+/, '');
  if (numberTarget.includes('@g.us'))
    return ctx.reply('❌ Group chats are not supported.');

  try {
    await ctx.replyWithPhoto(IMG_PAIR, {
      caption: `⏳ Lancement de l'appairage pour ${numberTarget}...`,
    });
  } catch {}
  try {
    await getSessions(bot, chatId, numberTarget);
  } catch (e) {
    console.error(`Error in /reqpair for ${senderId}: ${e.message}`);
    await ctx.reply('❌ Failed to process /reqpair: Server error.');
  }
});

// /delpair — Premium requis + Rate Limit
bot.command('delpair', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const chatId = ctx.chat.id;
  const senderId = ctx.from.id;

  if (!checkRateLimit(senderId, chatId, bot)) return;
  if (!db.premiumUsers.includes(senderId)) {
    return ctx.reply(
      `🚫 You are not authorized to use this command.\n\n📩 Please contact the developer to buy: @DGXeon13\n\n💰 Price/Harga:\n✅ Access permanent: 15$\n✅ Resell permanent: 25$\n✅ Script no enc 100%: 100$`
    );
  }

  const parts = ctx.message.text.split(' ');
  const raw = parts[1];
  if (!raw)
    return ctx.reply(
      '❌ Provide a phone number.\nExample: /delpair +919876543210'
    );
  if (!isValidPhoneNumber(raw))
    return ctx.reply(
      '❌ Invalid phone number. Use international format (e.g., +919876543210).'
    );

  const numberTarget = raw.replace(/[^0-9+]/g, '').replace(/^\+/, '');

  try {
    const sessionDir = path.join(
      RENT_SESSION_DIR,
      `${sanitizePath(numberTarget)}@s.whatsapp.net`
    );
    const chatIdForNumber = Object.keys(db.userNumbers).find(
      (key) => db.userNumbers[key] === numberTarget
    );

    if (!chatIdForNumber || !sessions.has(numberTarget)) {
      return ctx.reply(`❌ No active session found for ${numberTarget}.`);
    }

    const sock = sessions.get(numberTarget);
    if (sock) {
      await sock.logout();
    }

    await deleteFolderRecursive(sessionDir);
    delete db.userNumbers[chatIdForNumber];
    saveJson(USER_NUMBERS_FILE, db.userNumbers);
    sessions.delete(numberTarget);
    whatsappStatusMap.delete(numberTarget);

    await ctx.reply(
      `✅ WhatsApp session for ${numberTarget} has been deleted and disconnected.`
    );
  } catch (error) {
    console.error(`Error in /delpair for ${numberTarget}: ${error.message}`);
    await ctx.reply(
      `❌ Failed to delete session for ${numberTarget}: ${error.message}`
    );
  }
});

// =================================================================================================
// GESTION PREMIUM — /addprem /delprem /listprem
// =================================================================================================

bot.command('addprem', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const chatId = ctx.chat.id;
  const senderId = ctx.from.id;

  if (!isOwner(senderId)) {
    return ctx.reply('❌ Only owners can use this command.');
  }

  const parts = ctx.message.text.split(' ');
  const idRaw = parts[1];
  if (!idRaw)
    return ctx.reply('❌ Provide a user ID.\nExample: /addprem 123456789');
  const userId = parseInt(idRaw.replace(/[^0-9]/g, ''), 10);
  if (isNaN(userId)) return ctx.reply('❌ Invalid user ID.');

  if (!db.premiumUsers.includes(userId)) {
    db.premiumUsers.push(userId);
    saveJson(PREMIUM_FILE, db.premiumUsers);
    console.log(`${senderId} added ${userId} to premium`);
    await ctx.reply(`✅ User ${userId} added to premium.`);
  } else {
    await ctx.reply(`❌ User ${userId} is already premium.`);
  }
});

bot.command('delprem', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const chatId = ctx.chat.id;
  const senderId = ctx.from.id;

  if (!isOwner(senderId)) {
    return ctx.reply('❌ Only owners can use this command.');
  }

  const parts = ctx.message.text.split(' ');
  const idRaw = parts[1];
  if (!idRaw)
    return ctx.reply('❌ Provide a user ID.\nExample: /delprem 123456789');
  const userId = parseInt(idRaw.replace(/[^0-9]/g, ''), 10);
  if (isNaN(userId)) return ctx.reply('❌ Invalid user ID.');

  if (db.premiumUsers.includes(userId)) {
    db.premiumUsers = db.premiumUsers.filter((id) => id !== userId);
    saveJson(PREMIUM_FILE, db.premiumUsers);
    console.log(`${senderId} removed ${userId} from premium`);
    await ctx.reply(`✅ User ${userId} removed from premium.`);
  } else {
    await ctx.reply(`❌ User ${userId} is not premium.`);
  }
});

bot.command('listprem', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const chatId = ctx.chat.id;
  const senderId = ctx.from.id;

  if (!CONFIG.owner.includes(senderId) && !db.OwnerUsers.includes(senderId)) {
    return ctx.reply('❌ Only owners and resellers can use this command.');
  }

  if (db.premiumUsers.length === 0) {
    return ctx.reply('❌ No premium users found.');
  }

  try {
    const TELEGRAM_LIMIT = 4096;
    const messageParts = [];
    let currentPart = '┌──────┤ Premium Users List (Part 1) ├──────┐\n';
    let partNumber = 1;

    for (const userId of db.premiumUsers) {
      try {
        const chatInfo = await bot.telegram.getChat(userId);
        const username = chatInfo.username ? `@${chatInfo.username}` : 'No Username';
        const entry = `│➻ ID: ${userId}\n│➻ Username: ${username}\n│\n`;

        if (currentPart.length + entry.length + 100 < TELEGRAM_LIMIT) {
          currentPart += entry;
        } else {
          currentPart += '└────────────────────────┘';
          messageParts.push(currentPart);

          partNumber++;
          currentPart = `┌──────┤ Premium Users List (Part ${partNumber}) ├──────┐\n`;
          currentPart += entry;
        }
      } catch (error) {
        console.warn(`Error fetching chat for premium user ${userId}: ${error.message}`);
        const entry = `│➻ ID: ${userId}\n│➻ Username: Error fetching\n│\n`;
        if (currentPart.length + entry.length + 100 < TELEGRAM_LIMIT) {
          currentPart += entry;
        } else {
          currentPart += '└────────────────────────┘';
          messageParts.push(currentPart);
          partNumber++;
          currentPart = `┌──────┤ Premium Users List (Part ${partNumber}) ├──────┐\n`;
          currentPart += entry;
        }
      }
    }

    if (currentPart.length > '┌──────┤ Premium Users List (Part 1) ├──────┐\n'.length) {
      currentPart += '└────────────────────────┘';
      messageParts.push(currentPart);
    }

    for (const part of messageParts) {
      await bot.telegram.sendMessage(chatId, part);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    console.error(`Error in /listprem for ${senderId}: ${error.message}`);
    await ctx.reply(`❌ Failed to generate premium user list: ${error.message}`);
  }
});

// =================================================================================================
// GESTION RESELLERS — /addresell /delresell /listresell
// =================================================================================================

bot.command('addresell', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const senderId = ctx.from.id;

  if (!CONFIG.owner.includes(senderId)) {
    return ctx.reply('❌ Only Developer can use this command.');
  }

  const parts = ctx.message.text.split(' ');
  const idRaw = parts[1];
  if (!idRaw)
    return ctx.reply('❌ Provide a user ID.\nExample: /addresell 123456789');
  const userId = parseInt(idRaw.replace(/[^0-9]/g, ''), 10);
  if (isNaN(userId)) return ctx.reply('❌ Invalid user ID.');

  if (!db.OwnerUsers.includes(userId)) {
    db.OwnerUsers.push(userId);
    saveJson(OWNER_FILE, db.OwnerUsers);
    console.log(`${senderId} added ${userId} to resellers`);
    await ctx.reply(`✅ User ${userId} added as reseller.`);
  } else {
    await ctx.reply(`❌ User ${userId} is already a reseller.`);
  }
});

bot.command('delresell', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const senderId = ctx.from.id;

  if (!CONFIG.owner.includes(senderId)) {
    return ctx.reply('❌ Only developer can use this command.');
  }

  const parts = ctx.message.text.split(' ');
  const idRaw = parts[1];
  if (!idRaw)
    return ctx.reply('❌ Provide a user ID.\nExample: /delresell 123456789');
  const userId = parseInt(idRaw.replace(/[^0-9]/g, ''), 10);
  if (isNaN(userId)) return ctx.reply('❌ Invalid user ID.');

  if (db.OwnerUsers.includes(userId)) {
    db.OwnerUsers = db.OwnerUsers.filter((id) => id !== userId);
    saveJson(OWNER_FILE, db.OwnerUsers);
    console.log(`${senderId} removed ${userId} from resellers`);
    await ctx.reply(`✅ User ${userId} removed from resellers.`);
  } else {
    await ctx.reply(`❌ User ${userId} is not a reseller.`);
  }
});

bot.command('listresell', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const chatId = ctx.chat.id;
  const senderId = ctx.from.id;

  if (!CONFIG.owner.includes(senderId)) {
    return ctx.reply('❌ Only Developer can use this command.');
  }

  if (db.OwnerUsers.length === 0) {
    return ctx.reply('❌ No resellers found.');
  }

  try {
    const TELEGRAM_LIMIT = 4096;
    const messageParts = [];
    let currentPart = '┌──────┤ Resellers List (Part 1) ├──────┐\n';
    let partNumber = 1;

    for (const userId of db.OwnerUsers) {
      try {
        const chatInfo = await bot.telegram.getChat(userId);
        const username = chatInfo.username ? `@${chatInfo.username}` : 'No Username';
        const entry = `│➻ ID: ${userId}\n│➻ Username: ${username}\n│\n`;

        if (currentPart.length + entry.length + 100 < TELEGRAM_LIMIT) {
          currentPart += entry;
        } else {
          currentPart += '└────────────────────────┘';
          messageParts.push(currentPart);

          partNumber++;
          currentPart = `┌──────┤ Resellers List (Part ${partNumber}) ├──────┐\n`;
          currentPart += entry;
        }
      } catch (error) {
        console.warn(`Error fetching chat for reseller ${userId}: ${error.message}`);
        const entry = `│➻ ID: ${userId}\n│➻ Username: Error fetching\n│\n`;
        if (currentPart.length + entry.length + 100 < TELEGRAM_LIMIT) {
          currentPart += entry;
        } else {
          currentPart += '└────────────────────────┘';
          messageParts.push(currentPart);
          partNumber++;
          currentPart = `┌──────┤ Resellers List (Part ${partNumber}) ├──────┐\n`;
          currentPart += entry;
        }
      }
    }

    if (currentPart.length > '┌──────┤ Resellers List (Part 1) ├──────┐\n'.length) {
      currentPart += '└────────────────────────┘';
      messageParts.push(currentPart);
    }

    for (const part of messageParts) {
      await bot.telegram.sendMessage(chatId, part);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    console.error(`Error in /listresell for ${senderId}: ${error.message}`);
    await ctx.reply(`❌ Failed to generate reseller list: ${error.message}`);
  }
});

// =================================================================================================
// LISTE DES UTILISATEURS CONNECTÉS — /listuser
// =================================================================================================

bot.command('listuser', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const chatId = ctx.chat.id;
  const senderId = ctx.from.id;

  if (!isOwner(senderId)) {
    return ctx.reply('❌ Only owners can use this command.');
  }

  if (Object.keys(db.userNumbers).length === 0) {
    return ctx.reply('❌ No users have connected WhatsApp numbers.');
  }

  try {
    const TELEGRAM_LIMIT = 4096;
    const messageParts = [];
    let currentPart = '┌──────┤ Connected Users (Part 1) ├──────┐\n';
    let partNumber = 1;

    for (const [userIdStr, number] of Object.entries(db.userNumbers)) {
      const userId = parseInt(userIdStr, 10);
      try {
        const chatInfo = await bot.telegram.getChat(userId);
        const username = chatInfo.username ? `@${chatInfo.username}` : 'No Username';
        const entry = `│➻ ID: ${userId}\n│➻ Username: ${username}\n│➻ Number: ${number}\n│\n`;

        if (currentPart.length + entry.length + 100 < TELEGRAM_LIMIT) {
          currentPart += entry;
        } else {
          currentPart += '└────────────────────────┘';
          messageParts.push(currentPart);

          partNumber++;
          currentPart = `┌──────┤ Connected Users (Part ${partNumber}) ├──────┐\n`;
          currentPart += entry;
        }
      } catch (error) {
        console.warn(`Error fetching chat for user ${userId}: ${error.message}`);
        const entry = `│➻ ID: ${userId}\n│➻ Username: Error fetching\n│➻ Number: ${number}\n│\n`;

        if (currentPart.length + entry.length + 100 < TELEGRAM_LIMIT) {
          currentPart += entry;
        } else {
          currentPart += '└────────────────────────┘';
          messageParts.push(currentPart);

          partNumber++;
          currentPart = `┌──────┤ Connected Users (Part ${partNumber}) ├──────┐\n`;
          currentPart += entry;
        }
      }
    }

    if (currentPart.length > '┌──────┤ Connected Users (Part 1) ├──────┐\n'.length) {
      currentPart += '└────────────────────────┘';
      messageParts.push(currentPart);
    }

    for (const part of messageParts) {
      await bot.telegram.sendMessage(chatId, part);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    console.error(`Error in /listuser for ${senderId}: ${error.message}`);
    await ctx.reply(`❌ Failed to generate user list: ${error.message}`);
  }
});

// =================================================================================================
// DÉMARRAGE — RECONNEXION DES SESSIONS WA + LANCEMENT TELEGRAM
// =================================================================================================

async function startApp() {
  console.log('[App] Démarrage du bot...');
  const numbersToReconnect = Object.values(db.userNumbers);
  if (numbersToReconnect.length > 0) {
    console.log(`[App] Reconnexion de ${numbersToReconnect.length} session(s) WhatsApp...`);
    numbersToReconnect.forEach((number) => {
      console.log(`[WhatsApp] Tentative de reconnexion pour ${number}`);
      getSessions(null, null, number);
    });
  }
  await bot.launch();
  console.log('[Telegram] Le bot Telegram est en ligne.');
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
startApp().catch((err) => console.error("Erreur au démarrage de l'application:", err));
