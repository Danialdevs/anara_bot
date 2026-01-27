const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const storage = require('./storage');

// ============ CONFIGURATION ============
const EXPIRY_TIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (1 month)
const CHECK_INTERVAL = 3 * 60 * 60 * 1000; // Every 3 hours
const ADMIN_PORT = 3000;
const TARGET_GROUP_IDS = [];
const NOTIFY_PHONE = '77054019576@c.us'; // +7 705 401 9576

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

// Send notification to admin phone
async function sendNotification(message) {
    try {
        await client.sendMessage(NOTIFY_PHONE, message);
        console.log('📩 Notification sent');
    } catch (err) {
        console.error('Failed to send notification:', err.message);
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
const client = new Client({
    authStrategy: new LocalAuth()
});

client.on('qr', async (qr) => {
    qrcode.generate(qr, { small: true });

    // Generate QR as data URL for web
    currentQR = await QRCode.toDataURL(qr);
    clientStatus = 'qr';
    io.emit('status', { status: clientStatus, qr: currentQR });

    console.log('📱 Scan QR code (also available in admin panel)');
});

client.on('authenticated', () => {
    clientStatus = 'authenticated';
    currentQR = null;
    io.emit('status', { status: clientStatus });
    console.log('✅ Authenticated');
});

client.on('ready', async () => {
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
        sendNotification(`✅ Новый участник добавлен\n📱 ${formatPhone(realUserId)}\n📋 Группа: ${chatId.split('@')[0]}`);
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
        }
    }
});

// Check for expired users at 3:00 AM daily
async function checkExpiredAndRemove() {
    console.log('🕐 Running daily expiry check...');
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

// Check every 3 hours
setInterval(checkExpiredAndRemove, CHECK_INTERVAL);

client.initialize();
