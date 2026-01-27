const storage = require('./storage');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'users.json');

// Reset data for testing
fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));

console.log('--- Testing Storage Logic ---');

// 1. Test Adding Users
console.log('1. Adding users...');
storage.addUser('chat1', 'user1');
storage.addUser('chat1', 'user2');

let users = storage.readUsers();
if (users.length === 2 && users[0].userId === 'user1') {
    console.log('PASS: Users added correctly.');
} else {
    console.error('FAIL: Users not added correctly.');
}

// 2. Test Expiration
console.log('2. Testing expiration...');
// Manually backdate user1 to be 31 days ago
users = storage.readUsers();
const thirtyOneDaysAgo = new Date();
thirtyOneDaysAgo.setDate(thirtyOneDaysAgo.getDate() - 31);
users[0].joinedAt = thirtyOneDaysAgo.toISOString();
fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));

const expired = storage.checkExpiredUsers();
if (expired.length === 1 && expired[0].userId === 'user1') {
    console.log('PASS: Expired user detected.');
} else {
    console.error('FAIL: Expired user not detected.');
}

// Verify status in file is 'expired'
users = storage.readUsers();
if (users[0].status === 'expired') {
    console.log('PASS: User status marked as expired.');
} else {
    console.error('FAIL: User status not updated to expired.');
}

// 3. Test Removal Marking
console.log('3. Testing removal marking...');
storage.markUserRemoved('chat1', 'user1');

users = storage.readUsers();
if (users[0].status === 'removed' && users[0].removedAt) {
    console.log('PASS: User marked as removed.');
} else {
    console.error('FAIL: User not marked as removed.');
}

console.log('--- Test Complete ---');
