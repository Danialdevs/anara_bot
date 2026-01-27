const express = require('express');
const path = require('path');
const storage = require('./storage');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to extract phone number from userId
function extractPhone(userId) {
    // userId format: "77001234567@c.us" or "208361782014140@lid"
    if (!userId) return 'Unknown';
    const match = userId.match(/^(\d+)@/);
    return match ? match[1] : userId;
}

// GET all users
app.get('/api/users', (req, res) => {
    const users = storage.readUsers();
    const enriched = users.map((user, index) => ({
        id: index,
        ...user,
        phoneNumber: extractPhone(user.userId)
    }));
    res.json(enriched);
});

// PUT update user expiry
app.put('/api/users/:id', (req, res) => {
    const { id } = req.params;
    const { expiresAt } = req.body; // "never" or ISO date string or null

    const users = storage.readUsers();
    const idx = parseInt(id, 10);

    if (idx < 0 || idx >= users.length) {
        return res.status(404).json({ error: 'User not found' });
    }

    users[idx].expiresAt = expiresAt;
    storage.writeUsers(users);

    res.json({ success: true, user: users[idx] });
});

// DELETE remove user (mark as manually removed)
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

app.listen(PORT, () => {
    console.log(`Admin panel running at http://localhost:${PORT}`);
});
