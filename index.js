// Khởi động bot: nếu có server.js cập nhật từ bảng điều khiển (lưu trong Redis) thì chạy bản đó.
// Nếu bản cập nhật lỗi 3 lần liên tiếp thì tự xóa và quay về server.js trong repo.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');

(async () => {
    let target = './server.js';
    const r = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
    r.on('error', () => {});
    try {
        await r.connect();
        const code = await r.get('server_override');
        const boots = parseInt((await r.get('override_boot')) || '0');
        if (code && boots < 3) {
            await r.set('override_boot', String(boots + 1));
            fs.writeFileSync(path.join(__dirname, 'server_override.js'), code);
            target = './server_override.js';
            console.log('[launcher] Chạy bản server.js đã cập nhật từ bảng điều khiển');
        } else if (code) {
            console.error('[launcher] Bản cập nhật lỗi 3 lần, quay về server.js gốc');
            await r.del('server_override', 'override_boot');
        }
    } catch (e) {
        console.error('[launcher]', e.message);
    }
    r.disconnect();
    require(target);
})();
