module.exports = {
  apps: [{
    name: 'whatsapp-bot',
    script: 'index.js',
    cwd: '/var/www/anara_bot',  // Абсолютный путь к директории проекта
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      CHROME_PATH: '/usr/bin/google-chrome'  // Можно переопределить через переменную окружения
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s'
  }]
};
