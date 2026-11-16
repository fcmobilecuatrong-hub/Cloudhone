require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');

const overrideFile = path.join(__dirname, 'server_override.js');

function load(target) {
    try {
        require(target);
        return true;
    } catch (e) {
        console.error('[launcher] Không nạp được', target);
        console.error(e);
        return false;
    }
}

(async () => {
    let target = './server.js';
    const url = process.env.REDIS_URL;
    let r = null;
    if (!url) {
        console.error('[launcher] Thiếu REDIS_URL');
    } else {
        r = new Redis(url, {
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            connectTimeout: 8000,
            retryStrategy: () => null,
        });
        r.on('error', () => {});
        try {
            await r.connect();
            const code = await r.get('server_override');
            const boots = parseInt((await r.get('override_boot')) || '0', 10);
            if (code && boots < 3) {
                await r.set('override_boot', String(boots + 1));
                fs.writeFileSync(overrideFile, code);
                target = './server_override.js';
                console.log('[launcher] Chạy bản cập nhật, lần', boots + 1);
            } else if (code) {
                console.error('[launcher] Bản cập nhật lỗi 3 lần, về server.js gốc');
                await r.del('server_override', 'override_boot');
                try { fs.unlinkSync(overrideFile); } catch {}
            }
        } catch (e) {
            console.error('[launcher] Redis:', e.message);
        }
    }

    const ok = load(target);
    if (!ok && target !== './server.js') {
        console.error('[launcher] Bản cập nhật hỏng, chạy server.js gốc');
        try { if (r) await r.del('server_override', 'override_boot'); } catch {}
        try { fs.unlinkSync(overrideFile); } catch {}
        if (!load('./server.js')) process.exit(1);
    } else if (!ok) {
        process.exit(1);
    }
    try { if (r) r.disconnect(); } catch {}
})().catch((e) => {
    console.error('[launcher] crash', e);
    process.exit(1);
});