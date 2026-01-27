const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'users.json');

// Ensure data file exists
if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
}

function readUsers() {
    try {
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error("Error reading users file:", err);
        return [];
    }
}

function writeUsers(users) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
        return true;
    } catch (err) {
        console.error("Error writing users file:", err);
        return false;
    }
}

function addUser(chatId, userId) {
    const users = readUsers();

    // Check if user already exists in this chat
    const existingIndex = users.findIndex(u =>
        u.chatId === chatId && u.userId === userId
    );

    if (existingIndex !== -1) {
        // User exists - reactivate them
        users[existingIndex].status = 'active';
        users[existingIndex].joinedAt = new Date().toISOString();
        delete users[existingIndex].removedAt;
        delete users[existingIndex].failedAt;
        delete users[existingIndex].failReason;
        writeUsers(users);
        console.log(`Reactivated user ${userId} in chat ${chatId}`);
    } else {
        // New user
        const newUser = {
            chatId,
            userId,
            joinedAt: new Date().toISOString(),
            status: 'active'
        };
        users.push(newUser);
        writeUsers(users);
        console.log(`Added user ${userId} from chat ${chatId}`);
    }
}

function checkExpiredUsers(defaultExpiryMs) {
    const users = readUsers();
    const now = new Date();
    // Default to 30 days if not provided
    const defaultDuration = defaultExpiryMs || (30 * 24 * 60 * 60 * 1000);

    const expiredUsers = [];
    let updated = false;

    // Expiry presets in milliseconds
    const expiryPresets = {
        '1month': 30 * 24 * 60 * 60 * 1000,
        '2months': 60 * 24 * 60 * 60 * 1000,
        '3months': 90 * 24 * 60 * 60 * 1000,
        'never': null // Never expires
    };

    users.forEach(user => {
        if (user.status === 'active') {
            // Check custom expiry
            if (user.expiresAt === 'never') {
                // Never expires, skip
                return;
            }

            let duration = defaultDuration;
            if (user.expiresAt && expiryPresets[user.expiresAt]) {
                duration = expiryPresets[user.expiresAt];
            }

            const joinedDate = new Date(user.joinedAt);
            if (now - joinedDate > duration) {
                user.status = 'expired';
                expiredUsers.push(user);
                updated = true;
            }
        }
    });

    if (updated) {
        writeUsers(users);
    }

    return expiredUsers;
}

function markUserRemoved(chatId, userId) {
    const users = readUsers();
    let updated = false;

    // Find the specific 'expired' entry and mark as 'removed'
    // Or just find the active/expired one matching.
    for (let user of users) {
        if (user.chatId === chatId && user.userId === userId && user.status === 'expired') {
            user.status = 'removed';
            user.removedAt = new Date().toISOString();
            updated = true;
        }
    }

    if (updated) {
        writeUsers(users);
    }
}

function markUserFailed(chatId, userId, reason) {
    const users = readUsers();
    let updated = false;

    for (let user of users) {
        if (user.chatId === chatId && user.userId === userId && user.status === 'expired') {
            user.status = 'failed';
            user.failedAt = new Date().toISOString();
            user.failReason = reason;
            updated = true;
        }
    }

    if (updated) {
        writeUsers(users);
    }
}

module.exports = {
    addUser,
    checkExpiredUsers,
    markUserRemoved,
    markUserFailed,
    readUsers,
    writeUsers
};
