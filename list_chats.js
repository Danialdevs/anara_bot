const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: '/snap/bin/chromium',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('ready', async () => {
    console.log('\n=== ВСЕ ЧАТЫ ===\n');

    const chats = await client.getChats();

    // Groups
    console.log('📁 ГРУППЫ:');
    console.log('-'.repeat(60));
    chats.filter(c => c.isGroup).forEach(c => {
        console.log(`${c.name} | ${c.id._serialized}`);
    });

    // Contacts
    console.log('\n👤 КОНТАКТЫ:');
    console.log('-'.repeat(60));
    chats.filter(c => !c.isGroup).forEach(c => {
        const phone = c.id._serialized.split('@')[0];
        console.log(`${c.name || 'Без имени'} | +${phone} | ${c.id._serialized}`);
    });

    console.log('\n=== ГОТОВО ===');
    process.exit(0);
});

client.on('qr', () => {
    console.log('Сначала подключись через основной бот (index.js)');
    process.exit(1);
});

client.initialize();
