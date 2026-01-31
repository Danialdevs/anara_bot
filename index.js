const https = require('https');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const storage = require('./storage');

// ============ CONFIGURATION ============
const EXPIRY_TIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (1 month)
const CHECK_INTERVAL = 1 * 60 * 1000; // Every 1 minute
const ADMIN_PORT = 3000;
const TARGET_GROUP_IDS = [соня
    '120363424613797548@g.us', // РАССЫЛКИ
    '120363424485707391@g.us', // ЗАКАЗЫ
    '120363407941956163@g.us'  // ЧАТ БОЛТАЛКА
];
const NOTIFY_PHONE = '77079177470@c.us'; // +7 707 917 7470

// Telegram Configuration
const TELEGRAM_BOT_TOKEN = '8422642881:AAEQnGsZ_yb-dtdKNiEJf40d50jjN46B9zk';
const TELEGRAM_CHAT_IDS = ['6968636030', '8487168924'];

// ============ EXPRESS + SOCKET.IO ============
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// State
let clientStatus = 'disconnected';
let currentQR = null;

// Helper to format phone number nicely
function formatPhone(userId) {
    if (!userId) return 'Unknown';

    // Check if it's a LID (internal WhatsApp ID) vs real phone
    if (userId.includes('@lid')) {
        // LID format - not a real phone, just show short version
        const num = userId.split('@')[0];
        return `ID: ${num.slice(-6)}`; // Show last 6 digits
    }

    // Regular phone format: 77011234567@c.us
    const match = userId.match(/^(\d+)@/);
    if (!match) return userId;

    let phone = match[1];

    // Kazakhstan: 7 xxx xxx xx xx (11 digits starting with 7)
    if (phone.startsWith('7') && phone.length === 11) {
        return `+${phone[0]} (${phone.slice(1, 4)}) ${phone.slice(4, 7)}-${phone.slice(7, 9)}-${phone.slice(9, 11)}`;
    }

    // Russia: 7 xxx xxx xx xx (same format)
    if (phone.length === 11) {
        return `+${phone[0]} (${phone.slice(1, 4)}) ${phone.slice(4, 7)}-${phone.slice(7, 9)}-${phone.slice(9, 11)}`;
    }

    // Other countries - just add + prefix
    return '+' + phone;
}

// Send notification to Telegram
function sendTelegramNotification(message, extraOptions = {}) {
    TELEGRAM_CHAT_IDS.forEach(chatId => {
        const payload = {
            chat_id: chatId,
            text: message,
            ...extraOptions
        };

        const data = JSON.stringify(payload);

        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data) // Use Buffer.byteLength for UTF-8 characters
            }
        };

        const req = https.request(options, (res) => {
            if (res.statusCode !== 200) {
                console.error(`❌ Telegram API error (${chatId}): ${res.statusCode}`);
                res.on('data', d => process.stdout.write(d)); // Log error body
            } else {
                console.log(`📩 Telegram notification sent to ${chatId}`);
            }
        });

        req.on('error', (e) => {
            console.error(`❌ Telegram request error (${chatId}): ${e.message}`);
        });

        req.write(data);
        req.end();
    });
}

// Send notification to WhatsApp and Telegram
async function sendNotification(message, telegramOptions = {}) {
    // 1. WhatsApp - только если клиент ready
    if (clientStatus === 'ready') {
        try {
            // Try to get chat object first to ensure it's loaded
            const chat = await client.getChatById(NOTIFY_PHONE);
            await chat.sendMessage(message);
            console.log('📩 WhatsApp notification sent to', NOTIFY_PHONE);
        } catch (err) {
            console.error('❌ First attempt failed, retrying direct send:', err.message);
            try {
                await client.sendMessage(NOTIFY_PHONE, message);
                console.log('📩 WhatsApp notification sent (direct)');
            } catch (e) {
                console.error('❌ Failed to send WhatsApp notification:', e.message);
            }
        }
    } else {
        console.warn('⚠️ WhatsApp client not ready, skipping WhatsApp notification');
    }

    // 2. Telegram
    try {
        sendTelegramNotification(message, telegramOptions);
    } catch (err) {
        console.error('❌ Failed to send Telegram notification:', err.message);
    }
}

// API: Get users with search
app.get('/api/users', (req, res) => {
    const { search } = req.query;
    let users = storage.readUsers();

    const enriched = users.map((user, index) => ({
        id: index,
        ...user,
        phoneNumber: formatPhone(user.userId),
        rawPhone: user.userId?.match(/^(\d+)@/)?.[1] || ''
    }));

    // Filter by search
    if (search) {
        const q = search.toLowerCase();
        return res.json(enriched.filter(u =>
            u.rawPhone.includes(q) ||
            u.phoneNumber.toLowerCase().includes(q)
        ));
    }

    res.json(enriched);
});

// API: Update expiry
app.put('/api/users/:id', (req, res) => {
    const { id } = req.params;
    const { expiresAt } = req.body;
    const users = storage.readUsers();
    const idx = parseInt(id, 10);

    if (idx < 0 || idx >= users.length) {
        return res.status(404).json({ error: 'User not found' });
    }

    users[idx].expiresAt = expiresAt;
    storage.writeUsers(users);
    res.json({ success: true, user: users[idx] });
});

// API: Delete user
app.delete('/api/users/:id', (req, res) => {
    const { id } = req.params;
    const users = storage.readUsers();
    const idx = parseInt(id, 10);

    if (idx < 0 || idx >= users.length) {
        return res.status(404).json({ error: 'User not found' });
    }

    users[idx].status = 'manually_removed';
    users[idx].removedAt = new Date().toISOString();
    storage.writeUsers(users);
    res.json({ success: true });
});

// API: Get status
app.get('/api/status', (req, res) => {
    res.json({ status: clientStatus, qr: currentQR });
});

// API: Sync all participants from target groups
app.post('/api/sync-participants', async (req, res) => {
    if (clientStatus !== 'ready') {
        return res.status(400).json({ error: 'WhatsApp not connected' });
    }

    try {
        const results = {
            total: 0,
            added: 0,
            skipped: 0,
            groups: []
        };

        for (const groupId of TARGET_GROUP_IDS) {
            try {
                const chat = await client.getChatById(groupId);
                if (!chat.isGroup) continue;

                const groupResult = {
                    id: groupId,
                    name: chat.name,
                    participants: 0,
                    added: 0
                };

                const participants = chat.participants || [];

                for (const participant of participants) {
                    let realUserId = participant.id._serialized;

                    // Try to get real phone number
                    try {
                        const contact = await client.getContactById(realUserId);
                        if (contact && contact.number) {
                            realUserId = contact.number + '@c.us';
                        }
                    } catch (e) { }

                    // Check if already tracked
                    const users = storage.readUsers();
                    const alreadyTracked = users.some(u =>
                        u.userId === realUserId && u.chatId === groupId && u.status !== 'manually_removed'
                    );

                    if (!alreadyTracked) {
                        storage.addUser(groupId, realUserId);
                        groupResult.added++;
                        results.added++;
                    } else {
                        results.skipped++;
                    }

                    groupResult.participants++;
                    results.total++;
                }

                results.groups.push(groupResult);
                console.log(`✅ Synced group ${chat.name}: ${groupResult.added} new, ${groupResult.participants} total`);

            } catch (err) {
                console.error(`❌ Failed to sync group ${groupId}:`, err.message);
                results.groups.push({
                    id: groupId,
                    error: err.message
                });
            }
        }

        io.emit('sync_complete', results);
        res.json(results);

    } catch (err) {
        console.error('❌ Sync failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Socket.IO connection
io.on('connection', (socket) => {
    console.log('Admin connected');
    socket.emit('status', { status: clientStatus, qr: currentQR });
});

// Start server
server.listen(ADMIN_PORT, () => {
    console.log(`\n🌐 Admin panel: http://localhost:${ADMIN_PORT}\n`);
});

// ============ WHATSAPP CLIENT ============
// Используем абсолютный путь для сохранения сессии независимо от рабочей директории
const authDataPath = path.join(__dirname, '.wwebjs');

// Определяем путь к Chrome/Chromium
// Приоритет: CHROME_PATH env var > google-chrome > chromium
function getChromePath() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
        return process.env.CHROME_PATH;
    }

    const chromePaths = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium'
    ];

    for (const chromePath of chromePaths) {
        if (fs.existsSync(chromePath)) {
            return chromePath;
        }
    }

    // Fallback на chromium если ничего не найдено
    return '/snap/bin/chromium';
}

const chromeExecutablePath = getChromePath();
console.log(`🔧 Using Chrome/Chromium: ${chromeExecutablePath}`);

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'anara_bot',  // Фиксированное имя клиента
        dataPath: authDataPath  // Абсолютный путь к директории с сессией
    }),
    authTimeoutMs: 120000, // 2 минуты на авторизацию
    qrMaxRetries: 5,
    puppeteer: {
        executablePath: chromeExecutablePath,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-software-rasterizer'
        ],
        timeout: 120000 // 2 минуты таймаут для Puppeteer
    }
});

client.on('qr', async (qr) => {
    qrcode.generate(qr, { small: true });

    // Generate QR as data URL for web
    currentQR = await QRCode.toDataURL(qr);
    clientStatus = 'qr';
    io.emit('status', { status: clientStatus, qr: currentQR });

    console.log('📱 Scan QR code (also available in admin panel)');
});

// Таймаут для ready - если не получаем ready за 3 минуты после authenticated, перезапускаем
let readyTimeout = null;

client.on('authenticated', () => {
    clientStatus = 'authenticated';
    currentQR = null;
    io.emit('status', { status: clientStatus });
    console.log('✅ Authenticated');

    // Устанавливаем таймаут на 3 минуты
    if (readyTimeout) clearTimeout(readyTimeout);
    readyTimeout = setTimeout(() => {
        console.error('❌ Timeout: ready event not received in 3 minutes, restarting...');
        process.exit(1); // PM2 перезапустит процесс
    }, 180000);
});

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Loading: ${percent}% - ${message}`);
});

client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failure:', msg);
    clientStatus = 'auth_failure';
    io.emit('status', { status: clientStatus });
});

client.on('ready', async () => {
    // Очищаем таймаут
    if (readyTimeout) {
        clearTimeout(readyTimeout);
        readyTimeout = null;
    }

    clientStatus = 'ready';
    currentQR = null;
    io.emit('status', { status: clientStatus });
    console.log('✅ WhatsApp ready!');

    console.log('\n--- GROUPS ---');
    const chats = await client.getChats();
    const groups = chats.filter(chat => chat.isGroup);
    groups.forEach(g => console.log(`${g.name} | ${g.id._serialized}`));
    console.log('--------------\n');
});

client.on('disconnected', (reason) => {
    clientStatus = 'disconnected';
    io.emit('status', { status: clientStatus });
    console.log('❌ Disconnected:', reason);

    // Автопереподключение через 5 секунд
    console.log('🔄 Attempting to reconnect in 5 seconds...');
    setTimeout(() => {
        console.log('🔄 Restarting process for reconnection...');
        process.exit(1); // PM2 перезапустит процесс
    }, 5000);
});

client.on('group_join', async (notification) => {
    const chatId = notification.chatId;
    if (TARGET_GROUP_IDS.length > 0 && !TARGET_GROUP_IDS.includes(chatId)) return;

    console.log('👤 User joined:', chatId);
    for (const oderId of notification.recipientIds) {
        let realUserId = oderId;

        // Try to get real phone number from contact
        try {
            const contact = await client.getContactById(oderId);
            if (contact && contact.number) {
                realUserId = contact.number + '@c.us';
                console.log(`  Resolved phone: ${contact.number}`);
            }
        } catch (e) {
            // Couldn't get contact, use original ID
        }

        console.log(`  Tracking: ${realUserId}`);
        storage.addUser(chatId, realUserId);
        io.emit('user_added', { chatId, userId: realUserId });

        // Send notification
        await sendNotification(`✅ Новый участник добавлен\n📱 ${formatPhone(realUserId)}\n📋 Группа: ${chatId.split('@')[0]}`);
    }
});

client.on('group_update', async (notification) => {
    if (notification.type === 'add' || notification.type === 'invite') {
        const chatId = notification.chatId;
        if (TARGET_GROUP_IDS.length > 0 && !TARGET_GROUP_IDS.includes(chatId)) return;

        console.log('👤 User added:', chatId);
        for (const oderId of notification.recipientIds) {
            let realUserId = oderId;

            try {
                const contact = await client.getContactById(oderId);
                if (contact && contact.number) {
                    realUserId = contact.number + '@c.us';
                    console.log(`  Resolved phone: ${contact.number}`);
                }
            } catch (e) { }

            console.log(`  Tracking: ${realUserId}`);
            storage.addUser(chatId, realUserId);
            io.emit('user_added', { chatId, userId: realUserId });

            // Send notification
            await sendNotification(`✅ Новый участник добавлен\n📱 ${formatPhone(realUserId)}\n📋 Группа: ${chatId.split('@')[0]}`);
        }
    }
});

// Дополнительная обработка через message_create для более надежного обнаружения новых участников
client.on('message_create', async (msg) => {
    // Обрабатываем только системные сообщения групп (gp2)
    if (msg.type !== 'gp2') return;

    const chatId = msg.from;
    if (TARGET_GROUP_IDS.length > 0 && !TARGET_GROUP_IDS.includes(chatId)) return;

    // Проверяем подтип сообщения - может быть add/invite
    const body = msg.body || '';

    // WhatsApp системные сообщения о добавлении обычно содержат ключевые слова
    // или можно проверить через msg.mentionedIds / msg.recipientIds
    if (msg.recipientIds && msg.recipientIds.length > 0) {
        // Похоже на событие добавления участника
        for (const recipientId of msg.recipientIds) {
            // Проверяем, не обработали ли мы уже этого пользователя
            const users = storage.readUsers();
            const alreadyTracked = users.some(u =>
                u.userId === recipientId && u.chatId === chatId && u.status !== 'manually_removed'
            );

            if (!alreadyTracked) {
                let realUserId = recipientId;

                try {
                    const contact = await client.getContactById(recipientId);
                    if (contact && contact.number) {
                        realUserId = contact.number + '@c.us';
                        console.log(`  [message_create] Resolved phone: ${contact.number}`);
                    }
                } catch (e) { }

                console.log(`  [message_create] Tracking: ${realUserId}`);
                storage.addUser(chatId, realUserId);
                io.emit('user_added', { chatId, userId: realUserId });

                // Send notification
                await sendNotification(`✅ Новый участник добавлен (через message)\n📱 ${formatPhone(realUserId)}\n📋 Группа: ${chatId.split('@')[0]}`);
            }
        }
    }
});

// Check for expired users every 1 minute
async function checkExpiredAndRemove() {
    console.log('🕐 Running expiry check...');
    const expiredUsers = storage.checkExpiredUsers(EXPIRY_TIME_MS);
    if (expiredUsers.length > 0) {
        console.log(`⏰ Found ${expiredUsers.length} expired`);
        for (const user of expiredUsers) {
            try {
                const chat = await client.getChatById(user.chatId);
                if (chat.isGroup) {
                    await chat.removeParticipants([user.userId]);
                    console.log(`  ❌ Removed: ${user.userId}`);
                    storage.markUserRemoved(user.chatId, user.userId);
                    io.emit('user_removed', { chatId: user.chatId, userId: user.userId });

                    // Prepare WhatsApp message link
                    const waText = "Здравствуйте ❤️\nЭто рассылка об оплате участия в сообществе КОМЬЮНИТИ АВТОРОВ\n\nСтоимость продления -10 000 тенге.\n\n⚠️Обязательно \n▫️ Продублируйте чек мне, чтобы я отметила вас в списке";
                    const cleanPhone = user.userId.replace('@c.us', '');
                    const waLink = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(waText)}`;

                    // Send notification about removal with button
                    await sendNotification(
                        `❌ Участник удалён (истёк срок)\n📱 ${formatPhone(user.userId)}\n📋 Группа: ${user.chatId.split('@')[0]}`,
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: "Написать в WhatsApp", url: waLink }
                                    ]
                                ]
                            }
                        }
                    );
                }
            } catch (err) {
                console.error(`  ⚠️ Failed:`, err.message);
                storage.markUserFailed(user.chatId, user.userId, err.message || 'Unknown');
            }
        }
    } else {
        console.log('✅ No expired users');
    }
}

// Check every 1 minute
setInterval(checkExpiredAndRemove, CHECK_INTERVAL);

client.initialize();
