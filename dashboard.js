// Dashboard hợp nhất: đăng nhập Discord, ví xu / reg / buycloud (chung Redis với bot),
// và khu admin: deploy Render + Railway, sửa code GitHub, sửa biến môi trường, quản lý bot.
//
// Gắn vào server.js (thay dòng require cũ):
//   require('./dashboard')(app, panelAuth, { redis, getBots, startBot, stopBot, saveBot, tokenOf, botView, running });
//
// Env: RENDER_API_KEY, RAILWAY_API_TOKEN, GITHUB_TOKEN (Contents: Read and write), GITHUB_REPO,
//      DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET (+ Redirect: <domain>/auth/discord/callback)

const crypto = require('crypto');
const vm = require('vm');

module.exports = function mountDashboard(app, panelAuth, ctx = {}) {
    // Nếu server.js còn dòng require cũ (không truyền ctx) thì tự nối Redis, bot vẫn chạy bình thường
    let redis = ctx.redis;
    if (!redis) {
        console.warn('[dashboard] Chưa truyền ctx, tự kết nối Redis (tab Bot sẽ tắt). Hãy dùng dòng require mới trong server.js.');
        const Redis = require('ioredis');
        redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
        redis.on('error', err => console.error('[dashboard Redis]', err.message));
    }
    const env = k => String(process.env[k] || '').trim();
    const fail = (m, s = 400) => Object.assign(new Error(m), { status: s });
    const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => {
        if (res.headersSent) return;
        const s = e.status || 500;
        if (s >= 500) console.error('[dash]', e);
        res.status(s).json({ error: e.message });
    });

    // ---------- Tiện ích thời gian / xu (giống bot) ----------
    const vnNow = () => new Date(Date.now() + 7 * 3600 * 1000);
    const todayVN = () => vnNow().toISOString().split('T')[0];
    const secsToMidnight = () => {
        const v = vnNow();
        return Math.max(1, Math.floor((Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate() + 1) - v.getTime()) / 1000));
    };
    const dateKey = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const weekKey = () => {
        const v = vnNow();
        v.setUTCDate(v.getUTCDate() - ((v.getUTCDay() + 6) % 7));
        return 'leaderboard_weekly:' + dateKey(v);
    };
    const coinsOf = async id => Number(await redis.get('coins_' + id)) || 0;
    async function adminIds() {
        const e = env('ADMIN_DISCORD_ID').split(',').map(s => s.trim()).filter(Boolean);
        return [...new Set([...e, ...(await redis.smembers('admins'))])];
    }

    const CLAIM_LUA = `
local claimed = redis.call('SET', KEYS[1], '1', 'EX', ARGV[2], 'NX')
if not claimed then return 0 end
redis.call('INCRBY', KEYS[2], ARGV[1])
redis.call('ZINCRBY', KEYS[3], ARGV[1], ARGV[3])
redis.call('ZINCRBY', KEYS[4], ARGV[1], ARGV[3])
return 1`;
    const TRANSFER_LUA = `
local balance = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
local net = tonumber(ARGV[2])
if not balance or not amount or not net or amount <= 0 or net <= 0 then return redis.error_reply('Dữ liệu chuyển xu không hợp lệ') end
if balance < amount then return { 0, balance } end
redis.call('DECRBY', KEYS[1], amount)
redis.call('INCRBY', KEYS[2], net)
redis.call('ZINCRBY', KEYS[3], net, ARGV[3])
redis.call('ZINCRBY', KEYS[4], net, ARGV[3])
return { 1, balance - amount }`;
    const GIFT_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local amount = tonumber(raw)
if not amount or amount <= 0 or amount ~= math.floor(amount) then return redis.error_reply('Gift Code có số xu không hợp lệ') end
redis.call('DEL', KEYS[1])
redis.call('INCRBY', 'coins_' .. ARGV[1], amount)
redis.call('ZINCRBY', 'leaderboard', amount, ARGV[1])
redis.call('ZINCRBY', ARGV[2], amount, ARGV[1])
return tostring(amount)`;

    async function http(url, opts = {}) {
        const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        if (!res.ok) {
            const msg = (data && typeof data === 'object' && (data.message || data.error)) || `HTTP ${res.status}`;
            throw new Error(String(msg));
        }
        return data;
    }

    // ---------- Phiên đăng nhập Discord ----------
    const baseUrl = req => {
        const raw = env('RENDER_EXTERNAL_URL') || env('RENDER_DOMAIN');
        if (raw) { try { return new URL(raw.includes('://') ? raw : 'https://' + raw).origin; } catch {} }
        return 'https://' + (req.headers['x-forwarded-host'] || req.headers.host);
    };
    const parseCookies = req => {
        const out = {};
        for (const part of String(req.headers.cookie || '').split(';')) {
            const i = part.indexOf('=');
            if (i < 1) continue;
            try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
        }
        return out;
    };
    const setCookie = (res, name, value, maxAge) =>
        res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);

    app.get('/auth/discord', (req, res) => {
        const id = env('DISCORD_CLIENT_ID'), secret = env('DISCORD_CLIENT_SECRET');
        if (!id || !secret) return res.status(503).send('Chưa cấu hình DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET.');
        const state = crypto.randomBytes(16).toString('hex');
        setCookie(res, 'dstate', state, 600);
        const u = new URL('https://discord.com/oauth2/authorize');
        u.searchParams.set('client_id', id);
        u.searchParams.set('redirect_uri', baseUrl(req) + '/auth/discord/callback');
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('scope', 'identify');
        u.searchParams.set('state', state);
        res.redirect(u.toString());
    });

    app.get('/auth/discord/callback', async (req, res) => {
        const bad = m => res.status(400).send(`<body style="background:#0e0f1c;color:#ffc4cf;font-family:sans-serif;padding:40px"><h2>Đăng nhập thất bại</h2><p>${m}</p><a style="color:#6b78ff" href="/dashboard">Thử lại</a></body>`);
        try {
            const { code, state } = req.query;
            if (!code || !state || state !== parseCookies(req).dstate) return bad('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
            const token = await http('https://discord.com/api/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: env('DISCORD_CLIENT_ID'), client_secret: env('DISCORD_CLIENT_SECRET'),
                    grant_type: 'authorization_code', code: String(code),
                    redirect_uri: baseUrl(req) + '/auth/discord/callback'
                }).toString()
            });
            const me = await http('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + token.access_token } });
            const sid = crypto.randomBytes(24).toString('hex');
            await redis.set('websess_' + sid, JSON.stringify({
                id: me.id, name: me.global_name || me.username,
                avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : ''
            }), 'EX', 7 * 86400);
            setCookie(res, 'dsess', sid, 7 * 86400);
            setCookie(res, 'dstate', '', 0);
            res.redirect('/dashboard');
        } catch (e) {
            console.error('[oauth]', e.message);
            bad('Không đăng nhập được: ' + String(e.message).replace(/[<>]/g, ''));
        }
    });

    // Middleware cho mọi /api: nạp user từ cookie, chống CSRF bằng header tùy chỉnh
    app.use('/api', wrap(async (req, res, next) => {
        if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'dashboard') throw fail('Yêu cầu không hợp lệ', 403);
        const tok = parseCookies(req).dsess;
        if (tok && /^[a-f0-9]{48}$/.test(tok)) {
            const raw = await redis.get('websess_' + tok);
            if (raw) {
                const s = JSON.parse(raw);
                let u;
                if (s.webId) { // tài khoản web tạo bằng token: chỉ có quyền sau khi /ketnoi
                    const a = await redis.get('webacct_' + s.webId);
                    if (a) { const d = JSON.parse(a); u = { id: d.discordId, name: d.name || 'Thành viên', avatar: d.avatar || '', linked: true, webId: s.webId }; }
                    else u = { id: null, name: 'Khách', avatar: '', linked: false, webId: s.webId };
                } else u = { ...s, linked: true }; // đăng nhập OAuth Discord
                u.admin = !!u.id && (await adminIds()).includes(u.id);
                req.user = u;
            }
        }
        next();
    }));
    const userOnly = (req, res, next) => !req.user ? res.status(401).json({ error: 'Chưa đăng nhập' })
        : req.user.linked ? next() : res.status(403).json({ error: 'Hãy liên kết Discord trước: vào Cài đặt, lấy token rồi gõ /ketnoi trong Discord.' });
    const anyUser = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Chưa đăng nhập' });
    const adminOnly = (req, res, next) => {
        if (req.headers['x-panel-key']) return panelAuth(req, res, next);
        if (req.user && req.user.admin) return next();
        res.status(req.user ? 403 : 401).json({ error: req.user ? 'Chỉ dành cho admin' : 'Chưa đăng nhập' });
    };

    app.post('/api/logout', wrap(async (req, res) => {
        const tok = parseCookies(req).dsess;
        if (tok && /^[a-f0-9]{48}$/.test(tok)) await redis.del('websess_' + tok);
        setCookie(res, 'dsess', '', 0);
        res.json({ ok: true });
    }));

    // ---------- Tài khoản web + token liên kết (/ketnoi) ----------
    const TOK_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', TOK_TTL = 7 * 86400;
    const tokNorm = t => String(t).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const newToken = () => {
        let t = '';
        for (let i = 0; i < 12; i++) t += TOK_ALPHA[crypto.randomInt(TOK_ALPHA.length)];
        return `NGA-${t.slice(0, 4)}-${t.slice(4, 8)}-${t.slice(8)}`;
    };
    async function issueToken(webId, force) {
        if (!force) {
            const cur = await redis.get('webtok_' + webId);
            if (cur && await redis.exists('ketnoi_tok_' + tokNorm(cur))) return { token: cur, expiresIn: await redis.ttl('ketnoi_tok_' + tokNorm(cur)) };
        }
        const old = await redis.get('webtok_' + webId);
        if (old) await redis.del('ketnoi_tok_' + tokNorm(old));
        const token = newToken();
        await redis.set('ketnoi_tok_' + tokNorm(token), webId, 'EX', TOK_TTL);
        await redis.set('webtok_' + webId, token, 'EX', TOK_TTL);
        return { token, expiresIn: TOK_TTL };
    }
    const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    app.post('/api/guest', wrap(async (req, res) => {
        if (req.user) return res.json({ ok: true });
        const ipKey = 'webguest_ip_' + clientIp(req).replace(/[^0-9a-fA-F:.]/g, '');
        const n = await redis.incr(ipKey);
        if (n === 1) await redis.expire(ipKey, 3600);
        if (n > 20) throw fail('Bạn tạo quá nhiều tài khoản, thử lại sau 1 giờ.', 429);
        const webId = crypto.randomBytes(8).toString('hex'), sid = crypto.randomBytes(24).toString('hex');
        await redis.set('websess_' + sid, JSON.stringify({ webId }), 'EX', 30 * 86400);
        setCookie(res, 'dsess', sid, 30 * 86400);
        res.json({ ok: true });
    }));

    app.get('/api/link', anyUser, wrap(async (req, res) => {
        const u = req.user;
        if (u.linked) return res.json({ linked: true, via: u.webId ? 'token' : 'oauth', discord: { name: u.name, avatar: u.avatar } });
        const t = await issueToken(u.webId, false);
        res.json({ linked: false, token: t.token, expiresIn: t.expiresIn });
    }));
    app.post('/api/link/regen', anyUser, wrap(async (req, res) => {
        if (!req.user.webId || req.user.linked) throw fail('Tài khoản này đã liên kết rồi.');
        await cooldown(req.user.webId, 'regen', 3);
        const t = await issueToken(req.user.webId, true);
        res.json({ ok: true, token: t.token, expiresIn: t.expiresIn });
    }));
    app.post('/api/link/unlink', anyUser, wrap(async (req, res) => {
        const u = req.user;
        if (!u.webId || !u.linked) throw fail('Không có liên kết nào để hủy.');
        await redis.del('webacct_' + u.webId);
        await redis.srem('discord_webs_' + u.id, u.webId);
        res.json({ ok: true });
    }));

    const buyCost = () => parseInt(env('BUYCLOUD_COST') || '0', 10) || 0;
    const PROVIDERS = [
        { key: 'vmos', name: 'VMOS Cloud', cloud: 'VM', ready: true },
        { key: 'vsphone', name: 'VSPhone', cloud: 'VS', ready: true },
        { key: 'ugphone', name: 'UGPhone', cloud: '', ready: false }
    ];

    app.get('/api/me', (req, res, next) => req.user ? next() : adminOnly(req, res, next), wrap(async (req, res) => {
        const u = req.user || null;
        res.json({
            user: u ? { id: u.linked ? u.id : null, name: u.name, avatar: u.avatar } : null,
            linked: !!(u && u.linked),
            admin: !!(u ? u.admin : true),
            coins: u && u.linked ? await coinsOf(u.id) : 0,
            dailyDone: u && u.linked ? !!(await redis.exists(`daily_${u.id}_${todayVN()}`)) : false,
            cfg: { regCost: 10, buyCost: buyCost(), providers: PROVIDERS }
        });
    }));

    // ---------- Ví xu ----------
    app.post('/api/daily', userOnly, wrap(async (req, res) => {
        const ok = Number(await redis.eval(CLAIM_LUA, 4, `daily_${req.user.id}_${todayVN()}`, `coins_${req.user.id}`, 'leaderboard', weekKey(), 20, secsToMidnight(), req.user.id)) === 1;
        if (!ok) throw fail('Hôm nay bạn đã điểm danh rồi.');
        res.json({ ok: true, coins: await coinsOf(req.user.id), message: 'Điểm danh thành công +20 xu!' });
    }));

    app.post('/api/code', userOnly, wrap(async (req, res) => {
        const code = String((req.body && req.body.code) || '').trim();
        if (code.length < 8 || code.length > 32) throw fail('Mã không hợp lệ.');
        const amount = await redis.eval(GIFT_LUA, 1, `gift_${code}`, req.user.id, weekKey());
        if (!amount) throw fail('Code sai hoặc đã dùng.');
        res.json({ ok: true, coins: await coinsOf(req.user.id), message: `Nhận ${amount} xu.` });
    }));

    app.post('/api/transfer', userOnly, wrap(async (req, res) => {
        const target = String((req.body && req.body.target) || '').trim();
        const amount = Math.floor(Number(req.body && req.body.amount));
        if (!/^\d{15,22}$/.test(target)) throw fail('ID Discord người nhận không hợp lệ.');
        if (target === req.user.id) throw fail('Không thể chuyển cho chính mình.');
        if (!Number.isSafeInteger(amount) || amount < 10 || amount > 1000000) throw fail('Số xu phải từ 10 đến 1.000.000.');
        const fee = Math.max(1, Math.floor(amount * 0.05)), net = amount - fee;
        const r = await redis.eval(TRANSFER_LUA, 4, `coins_${req.user.id}`, `coins_${target}`, 'leaderboard', weekKey(), amount, net, target);
        if (Number(r[0]) !== 1) throw fail(`Không đủ xu (hiện có ${r[1]} xu).`);
        res.json({ ok: true, coins: await coinsOf(req.user.id), message: `Đã chuyển ${net} xu (phí ${fee} xu).` });
    }));

    const nameCache = new Map();
    async function nameOf(id) {
        if (nameCache.has(id)) return nameCache.get(id);
        let n = id;
        try {
            const c = ctx.running && ctx.running.get('main');
            if (c) n = (await c.users.fetch(id)).username;
        } catch {}
        nameCache.set(id, n);
        return n;
    }
    app.get('/api/top', userOnly, wrap(async (req, res) => {
        const week = req.query.scope === 'week';
        const rows = await redis.zrevrange(week ? weekKey() : 'leaderboard', 0, week ? 5 : 9, 'WITHSCORES');
        const list = [];
        for (let i = 0; i < rows.length; i += 2) list.push({ rank: i / 2 + 1, id: rows[i], name: await nameOf(rows[i]), score: Number(rows[i + 1]) });
        res.json({ list });
    }));

    // ---------- Cloud: reg + buy ----------
    async function cooldown(uid, action, secs = 3) {
        if (!(await redis.set(`webcool_${uid}_${action}`, '1', 'EX', secs, 'NX'))) throw fail('Thao tác quá nhanh, thử lại sau vài giây.', 429);
    }
    async function fetchAccount(provider) {
        if (provider === 'vsphone') {
            const base = (env('VSPHONE_API_URL') || 'https://vsphone-production.up.railway.app').replace(/\/+$/, '');
            const r = await fetch(`${base}/register`, { headers: { 'x-api-key': env('VSPHONE_API_KEY') }, signal: AbortSignal.timeout(30000) });
            const d = await r.json();
            if (!r.ok || !d.ok || !d.account) throw new Error(d.error || `VSPhone API lỗi (HTTP ${r.status}).`);
            const [mail, pass] = d.account.split('|');
            return { mail, pass, code: null };
        }
        if (!env('APIKEY')) throw new Error('Chưa cấu hình APIKEY để lấy tài khoản VMOS.');
        const r = await fetch('https://wxygtmfttyidwnhjdwdw.supabase.co/functions/v1/get-key', {
            method: 'POST', headers: { 'Content-Type': 'application/json', apikey: env('APIKEY') },
            body: JSON.stringify({ clientId: crypto.randomUUID() }), signal: AbortSignal.timeout(15000)
        });
        const d = await r.json();
        if (!r.ok || !d.content) throw new Error(d.message || `Lỗi lấy dữ liệu VMOS (HTTP ${r.status}).`);
        const [mail, pass, code] = d.content.split('|');
        return { mail, pass, code: code || null };
    }

    app.post('/api/reg', userOnly, wrap(async (req, res) => {
        const key = String((req.body && req.body.provider) || '');
        const prov = PROVIDERS.find(p => p.key === key);
        if (!prov) throw fail('Lựa chọn không hợp lệ.');
        if (!prov.ready) throw fail(`${prov.name} sắp có, bạn chọn loại khác nhé.`);
        const uid = req.user.id;
        await cooldown(uid, 'reg', 5);
        const remaining = await redis.decrby(`coins_${uid}`, 10);
        if (remaining < 0) { await redis.incrby(`coins_${uid}`, 10); throw fail('Không đủ 10 xu.'); }
        try {
            const a = await fetchAccount(key);
            if (!a.mail || !a.pass) throw new Error('API trả về tài khoản không đúng định dạng.');
            res.json({ ok: true, provider: key, cloud: prov.cloud, mail: a.mail, pass: a.pass, code: a.code, coins: remaining });
        } catch (e) {
            await redis.incrby(`coins_${uid}`, 10).catch(() => {});
            throw fail(e.message);
        }
    }));

    app.post('/api/buy', userOnly, wrap(async (req, res) => {
        const cloudId = String((req.body && req.body.cloud) || '');
        if (cloudId !== 'VM' && cloudId !== 'VS') throw fail('Loại cloud không hợp lệ.');
        const raw = String((req.body && req.body.info) || '').trim();
        const i = raw.indexOf('|');
        const account = i > 0 ? raw.slice(0, i).trim() : '';
        const password = i > 0 ? raw.slice(i + 1).trim() : '';
        if (!account || !password || raw.length > 300) throw fail('Sai định dạng. Nhập theo mẫu: email|matkhau');
        if (!env('HANAMI_TOKEN')) throw fail('Bot chưa cấu hình token mua cloud (HANAMI_TOKEN).');
        const uid = req.user.id;
        await cooldown(uid, 'buy', 5);
        const cost = buyCost();
        if (cost > 0) {
            if ((await redis.decrby(`coins_${uid}`, cost)) < 0) { await redis.incrby(`coins_${uid}`, cost); throw fail(`Không đủ ${cost} xu.`); }
        }
        let result;
        try {
            const r = await fetch('https://hanaminikata.com/dev/buy_device_cloud', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' },
                body: JSON.stringify({ token: env('HANAMI_TOKEN'), cloud_id: cloudId, input_data: `${account}|${password}` }),
                signal: AbortSignal.timeout(60000)
            });
            const text = await r.text();
            console.log('[web buycloud]', uid, account, r.status, text.slice(0, 200));
            try { result = JSON.parse(text); } catch { result = { code: -1, message: `Máy chủ mua cloud trả về lỗi (HTTP ${r.status}).` }; }
        } catch (e) {
            result = { code: -1, message: 'Không kết nối được tới máy chủ mua cloud (' + (e.name === 'TimeoutError' ? 'quá 60 giây' : e.message) + ').' };
        }
        const ok = !!result && result.code === 0;
        const message = String((result && result.message) || 'Có lỗi xảy ra.');
        if (!ok && cost > 0) await redis.incrby(`coins_${uid}`, cost);
        await redis.rpush('buycloud_orders', JSON.stringify({ userId: uid, cloudId, account, ok, message, at: Date.now(), via: 'web' }));
        await redis.ltrim('buycloud_orders', -1000, -1);
        try { // báo admin qua Discord (nếu bot chính đang chạy)
            const c = ctx.running && ctx.running.get('main');
            if (c) for (const id of await adminIds()) {
                try { await (await c.users.fetch(id)).send(`🛒 [Web] Buycloud ${cloudId}: <@${uid}> | \`${account}\` | ${ok ? 'thành công' : 'lỗi'}: ${message}`); } catch {}
            }
        } catch {}
        if (!ok) throw fail(message);
        res.json({ ok: true, message, coins: await coinsOf(uid) });
    }));

    app.get('/api/orders', userOnly, wrap(async (req, res) => {
        const rows = (await redis.lrange('buycloud_orders', -1000, -1)).map(s => { try { return JSON.parse(s); } catch { return null; } })
            .filter(o => o && o.userId === req.user.id).slice(-15).reverse();
        res.json({ list: rows });
    }));

    // ---------- Admin: Render ----------
    function render(path, opts = {}) {
        const key = env('RENDER_API_KEY');
        if (!key) throw new Error('Chưa đặt RENDER_API_KEY');
        return http('https://api.render.com/v1' + path, {
            ...opts, headers: { Authorization: 'Bearer ' + key, Accept: 'application/json', 'Content-Type': 'application/json' }
        });
    }
    async function renderOverview() {
        const list = await render('/services?limit=50');
        return Promise.all(list.map(async item => {
            const s = item.service || item;
            let deploy = null;
            try { const d = await render(`/services/${s.id}/deploys?limit=1`); if (d[0]) deploy = d[0].deploy || d[0]; } catch {}
            const url = s.serviceDetails && s.serviceDetails.url;
            return {
                id: s.id, name: s.name, type: s.type, ownerId: s.ownerId || '', region: s.region || '',
                status: s.suspended === 'suspended' ? 'suspended' : (deploy ? deploy.status : 'unknown'),
                url: url ? (url.startsWith('http') ? url : 'https://' + url) : '',
                branch: s.branch || '',
                commit: deploy && deploy.commit ? String(deploy.commit.message || '').split('\n')[0] : '',
                at: deploy ? (deploy.finishedAt || deploy.createdAt) : s.updatedAt,
                dash: s.dashboardUrl || `https://dashboard.render.com/web/${s.id}`
            };
        }));
    }

    // ---------- Admin: Railway ----------
    async function gql(query, variables) {
        const token = env('RAILWAY_API_TOKEN');
        if (!token) throw new Error('Chưa đặt RAILWAY_API_TOKEN');
        const data = await http('https://backboard.railway.com/graphql/v2', {
            method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables })
        });
        if (data.errors && data.errors.length) throw new Error(data.errors[0].message || 'Railway GraphQL lỗi');
        return data.data;
    }
    async function railwayOverview() {
        const FIELDS = `id name
            environments { edges { node { id name } } }
            services { edges { node { id name } } }`;
        const attempts = [
            [`query { projects { edges { node { ${FIELDS} } } } }`, d => d.projects],
            [`query { me { projects { edges { node { ${FIELDS} } } } } }`, d => d.me && d.me.projects],
            [`query { me { workspaces { projects { edges { node { ${FIELDS} } } } } } }`,
                d => ({ edges: ((d.me && d.me.workspaces) || []).flatMap(w => (w.projects && w.projects.edges) || []) })],
            [`query { projectToken { project { ${FIELDS} } } }`,
                d => d.projectToken && d.projectToken.project ? { edges: [{ node: d.projectToken.project }] } : null]
        ];
        const found = new Map(), errors = [];
        for (const [q, pick] of attempts) {
            try {
                const conn = pick(await gql(q));
                for (const e of (conn && conn.edges) || []) if (e && e.node) found.set(e.node.id, e.node);
            } catch (e) { errors.push(e.message); }
        }
        const projects = [...found.values()];
        if (!projects.length && errors.length) throw new Error('Không lấy được project Railway: ' + errors[0]);
        const out = [];
        await Promise.all(projects.map(async p => {
            const envs = p.environments.edges.map(e => e.node);
            const environment = envs.find(e => e.name === 'production') || envs[0];
            if (!environment) return;
            await Promise.all(p.services.edges.map(async se => {
                const svc = se.node;
                let dep = null;
                try {
                    const r = await gql(`query($p:String!,$s:String!,$e:String!){
                        deployments(first:1, input:{projectId:$p, serviceId:$s, environmentId:$e}){
                            edges{node{id status createdAt staticUrl}}}}`, { p: p.id, s: svc.id, e: environment.id });
                    dep = r.deployments.edges[0] && r.deployments.edges[0].node;
                } catch {}
                out.push({
                    id: svc.id, name: svc.name, project: p.name, projectId: p.id,
                    environmentId: environment.id, environment: environment.name,
                    status: dep ? dep.status : 'unknown',
                    url: dep && dep.staticUrl ? 'https://' + dep.staticUrl : '',
                    at: dep ? dep.createdAt : null,
                    dash: `https://railway.com/project/${p.id}/service/${svc.id}`
                });
            }));
        }));
        return out.sort((a, b) => (a.project + a.name).localeCompare(b.project + b.name));
    }

    // ---------- Admin: GitHub ----------
    function gh(path, opts = {}) {
        const token = env('GITHUB_TOKEN'), repo = env('GITHUB_REPO');
        if (!token) throw new Error('Chưa đặt GITHUB_TOKEN');
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPO phải dạng owner/repo');
        return http(`https://api.github.com/repos/${repo}${path}`, {
            ...opts, headers: {
                Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'nigaria-dashboard', 'Content-Type': 'application/json'
            }
        });
    }
    async function githubOverview() {
        const [info, commits, runs, pulls] = await Promise.all([
            gh(''), gh('/commits?per_page=8'),
            gh('/actions/runs?per_page=6').catch(() => ({ workflow_runs: [] })),
            gh('/pulls?state=open&per_page=6')
        ]);
        return {
            repo: info.full_name, url: info.html_url, branch: info.default_branch,
            stars: info.stargazers_count, issues: info.open_issues_count, private: info.private, pushedAt: info.pushed_at,
            commits: commits.map(c => ({ sha: c.sha.slice(0, 7), url: c.html_url, msg: String(c.commit.message).split('\n')[0], author: (c.author && c.author.login) || c.commit.author.name, at: c.commit.author.date })),
            runs: (runs.workflow_runs || []).map(r => ({ id: r.id, name: r.name, branch: r.head_branch, url: r.html_url, status: r.status === 'completed' ? r.conclusion : r.status, at: r.created_at })),
            pulls: pulls.map(p => ({ n: p.number, title: p.title, url: p.html_url, user: p.user.login, at: p.created_at }))
        };
    }
    const settle = fn => Promise.resolve().then(fn).then(data => ({ ok: true, data }), e => ({ ok: false, error: e.message }));

    // ---------- Redis database cho dashboard: lịch sử, cấu hình, audit ----------
    const DBP = 'dash:v2:';
    async function dbPush(key, value, max = 300) {
        await redis.lpush(DBP + key, JSON.stringify(value));
        await redis.ltrim(DBP + key, 0, max - 1);
    }
    async function audit(action, detail = {}) {
        const safe = { action: String(action).slice(0, 80), detail, at: Date.now() };
        await dbPush('audit', safe, 500).catch(e => console.warn('[dashboard audit]', e.message));
    }
    async function readJsonList(key, count = 100) {
        return (await redis.lrange(DBP + key, 0, Math.max(0, count - 1))).map(x => {
            try { return JSON.parse(x); } catch { return null; }
        }).filter(Boolean);
    }
    async function saveInfraSnapshot(snapshot) {
        const item = { at: Date.now(), snapshot };
        await redis.set(DBP + 'last_snapshot', JSON.stringify(item));
        await dbPush('snapshots', item, 100);
    }
    async function getRedisStats() {
        const info = await redis.info('memory').catch(() => '');
        const pick = k => { const m = info.match(new RegExp('^' + k + ':(.*)$', 'm')); return m ? m[1] : null; };
        return {
            connected: redis.status === 'ready', status: redis.status || 'unknown',
            keys: await redis.dbsize().catch(() => null),
            usedMemory: pick('used_memory_human'), peakMemory: pick('used_memory_peak_human'),
            maxMemory: pick('maxmemory_human')
        };
    }

    app.get('/api/admin/overview', adminOnly, wrap(async (req, res) => {
        const [r, rw, g] = await Promise.all([settle(renderOverview), settle(railwayOverview), settle(githubOverview)]);
        res.json({ render: r, railway: rw, github: g, at: Date.now() });
    }));
    app.get('/api/admin/infra/history', adminOnly, wrap(async (req, res) => {
        const provider = String(req.query.provider || '');
        if (provider === 'render') {
            if (!/^srv-[a-z0-9]+$/i.test(String(req.query.serviceId || ''))) throw fail('Service ID Render không hợp lệ');
            const rows = await render(`/services/${req.query.serviceId}/deploys?limit=20`);
            res.json({ provider, list: (rows || []).map(x => x.deploy || x).map(d => ({
                id: d.id, status: d.status, at: d.createdAt, finishedAt: d.finishedAt,
                commit: d.commit && (d.commit.message || d.commit.id), commitId: d.commit && d.commit.id, trigger: d.trigger, dashboardUrl: d.dashboardUrl
            })) });
            return;
        }
        if (provider === 'railway') {
            const ids = rwIds({ p: req.query.projectId, e: req.query.environmentId, s: req.query.serviceId });
            const d = await gql(`query($input: DeploymentListInput!, $first: Int) { deployments(input:$input, first:$first) { edges { node { id status createdAt url staticUrl meta canRedeploy canRollback } } } }`, {
                input: { projectId: ids.projectId, serviceId: ids.serviceId, environmentId: ids.environmentId }, first: 20
            });
            res.json({ provider, list: (d.deployments.edges || []).map(x => x.node) });
            return;
        }
        throw fail('Provider không hợp lệ');
    }));
    app.get('/api/admin/infra/logs', adminOnly, wrap(async (req, res) => {
        const provider = String(req.query.provider || '');
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
        if (provider === 'render') {
            const id = String(req.query.serviceId || '');
            if (!/^srv-[a-z0-9]+$/i.test(id)) throw fail('Service ID Render không hợp lệ');
            const services = await render('/services?limit=100');
            const match = (services || []).map(x => x.service || x).find(x => x.id === id);
            if (!match || !match.ownerId) throw fail('Không lấy được ownerId của service Render');
            const q = new URLSearchParams({ ownerId: match.ownerId, resource: id, limit: String(limit), direction: 'backward' });
            const start = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            q.set('startTime', start); q.set('endTime', new Date().toISOString());
            const logs = await render('/logs?' + q.toString());
            res.json({ provider, logs: logs.logs || logs.items || logs });
            return;
        }
        if (provider === 'railway') {
            const id = String(req.query.deploymentId || '');
            if (!UUID.test(id)) throw fail('Deployment ID Railway không hợp lệ');
            // Railway exposes deployment logs via its GraphQL public API.
            const d = await gql(`query($id:String!, $limit:Int) { deploymentLogs(deploymentId:$id, limit:$limit) { timestamp message severity } }`, { id, limit });
            res.json({ provider, logs: d.deploymentLogs || [] });
            return;
        }
        throw fail('Provider không hợp lệ');
    }));
    app.post('/api/admin/railway/rollback', adminOnly, wrap(async (req, res) => {
        const id = String((req.body || {}).deploymentId || '');
        if (!UUID.test(id)) throw fail('Deployment ID không hợp lệ');
        const d = await gql(`mutation($id:String!) { deploymentRollback(id:$id) }`, { id });
        if (d.deploymentRollback !== true) throw fail('Railway không xác nhận rollback');
        await audit('railway.rollback', { deploymentId: id });
        res.json({ ok: true, message: 'Đã gửi yêu cầu rollback Railway' });
    }));
    app.post('/api/admin/render/:id/restart', adminOnly, wrap(async (req, res) => {
        if (!/^srv-[a-z0-9]+$/i.test(req.params.id)) throw fail('ID không hợp lệ');
        await render(`/services/${req.params.id}/deploys`, { method: 'POST', body: JSON.stringify({ deployMode: 'deploy_only' }) });
        await audit('render.restart', { serviceId: req.params.id });
        res.json({ ok: true });
    }));
    app.post('/api/admin/render/:id/rollback', adminOnly, wrap(async (req, res) => {
        if (!/^srv-[a-z0-9]+$/i.test(req.params.id)) throw fail('ID không hợp lệ');
        const commitId = String((req.body || {}).commitId || '');
        if (!/^[0-9a-f]{7,40}$/i.test(commitId)) throw fail('Commit ID không hợp lệ');
        await render(`/services/${req.params.id}/deploys`, { method: 'POST', body: JSON.stringify({ commitId }) });
        await audit('render.rollback', { serviceId: req.params.id, commitId });
        res.json({ ok: true, message: 'Đã gửi deploy lại commit đã chọn' });
    }));
    app.get('/api/admin/db/summary', adminOnly, wrap(async (req, res) => {
        const stats = await getRedisStats();
        const last = await redis.get(DBP + 'last_snapshot');
        let snapshot = null; try { snapshot = last ? JSON.parse(last) : null; } catch {}
        res.json({ stats, lastSnapshot: snapshot, auditCount: await redis.llen(DBP + 'audit'), snapshotCount: await redis.llen(DBP + 'snapshots') });
    }));
    app.get('/api/admin/db/audit', adminOnly, wrap(async (req, res) => {
        res.json({ list: await readJsonList('audit', Math.min(200, Math.max(1, Number(req.query.limit) || 60))) });
    }));
    app.get('/api/admin/db/snapshots', adminOnly, wrap(async (req, res) => {
        res.json({ list: await readJsonList('snapshots', Math.min(100, Math.max(1, Number(req.query.limit) || 30))) });
    }));
    app.get('/api/admin/db/settings', adminOnly, wrap(async (req, res) => {
        const raw = await redis.hgetall(DBP + 'settings');
        const settings = {}; for (const [k, v] of Object.entries(raw || {})) { try { settings[k] = JSON.parse(v); } catch { settings[k] = v; } }
        res.json({ settings });
    }));
    app.put('/api/admin/db/settings', adminOnly, wrap(async (req, res) => {
        const allowed = new Set(['compactMode', 'refreshSeconds', 'defaultTab', 'notifyOnDeploy']);
        const values = (req.body || {}).settings;
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw fail('Thiếu settings');
        const pairs = [];
        for (const [k, v] of Object.entries(values)) {
            if (!allowed.has(k)) throw fail('Không cho phép lưu mục ' + k);
            if (k === 'refreshSeconds' && (!Number.isInteger(v) || v < 0 || v > 300)) throw fail('refreshSeconds phải từ 0 đến 300');
            if (k === 'defaultTab' && !['deploy', 'code', 'env', 'bots', 'gen', 'db', 'notify'].includes(v)) throw fail('Tab mặc định không hợp lệ');
            pairs.push(k, JSON.stringify(v));
        }
        if (pairs.length) await redis.hset(DBP + 'settings', ...pairs);
        await audit('dashboard.settings.update', { keys: Object.keys(values) });
        res.json({ ok: true });
    }));
    app.post('/api/admin/db/snapshot', adminOnly, wrap(async (req, res) => {
        const [r, rw, g] = await Promise.all([settle(renderOverview), settle(railwayOverview), settle(githubOverview)]);
        const snap = { render: r, railway: rw, github: g };
        await saveInfraSnapshot(snap);
        await audit('infra.snapshot', { renderOk: r.ok, railwayOk: rw.ok, githubOk: g.ok });
        res.json({ ok: true, at: Date.now() });
    }));
    app.get('/api/admin/notify/channels', adminOnly, wrap(async (req, res) => {
        const client = ctx.running && ctx.running.get('main');
        if (!client) throw fail('Bot Discord chính chưa chạy', 503);
        const channels = [];
        for (const [, guild] of client.guilds.cache) {
            const list = await guild.channels.fetch().catch(() => null);
            if (!list) continue;
            for (const [, ch] of list) if (ch && ch.isTextBased && ch.isTextBased() && ch.guild) {
                const me = guild.members.me;
                const perms = me && ch.permissionsFor(me);
                if (perms && perms.has('ViewChannel') && perms.has('SendMessages')) channels.push({ id: ch.id, name: '#' + ch.name, guild: guild.name });
            }
        }
        const saved = await redis.hgetall(DBP + 'notify_destinations');
        res.json({ channels, destinations: Object.entries(saved || {}).map(([id, raw]) => { try { return { id, ...JSON.parse(raw) }; } catch { return null; } }).filter(Boolean) });
    }));
    app.post('/api/admin/notify/destinations', adminOnly, wrap(async (req, res) => {
        const name = String((req.body || {}).name || '').trim().slice(0, 50);
        const channelId = String((req.body || {}).channelId || '').trim();
        if (!name || !/^\d{15,22}$/.test(channelId)) throw fail('Tên hoặc Channel ID không hợp lệ');
        const id = crypto.createHash('sha1').update(channelId).digest('hex').slice(0, 12);
        await redis.hset(DBP + 'notify_destinations', id, JSON.stringify({ name, channelId }));
        await audit('notify.destination.add', { name, channelId });
        res.json({ ok: true, id });
    }));
    app.delete('/api/admin/notify/destinations/:id', adminOnly, wrap(async (req, res) => {
        await redis.hdel(DBP + 'notify_destinations', String(req.params.id));
        await audit('notify.destination.delete', { id: req.params.id });
        res.json({ ok: true });
    }));
    app.get('/api/admin/notify/history', adminOnly, wrap(async (req, res) => {
        res.json({ list: await readJsonList('notifications', 50) });
    }));
    app.post('/api/admin/notify/send', adminOnly, wrap(async (req, res) => {
        const channelId = String((req.body || {}).channelId || '');
        const message = String((req.body || {}).message || '').trim();
        if (!/^\d{15,22}$/.test(channelId) || !message || message.length > 2000) throw fail('Kênh hoặc nội dung không hợp lệ');
        const client = ctx.running && ctx.running.get('main');
        if (!client) throw fail('Bot Discord chính chưa chạy', 503);
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (!ch || !ch.isTextBased || !ch.isTextBased() || typeof ch.send !== 'function') throw fail('Không tìm thấy kênh văn bản hoặc bot không truy cập được');
        await ch.send({ content: message, allowedMentions: { parse: [] } });
        await dbPush('notifications', { channelId, message, at: Date.now() }, 100);
        await audit('discord.notify.send', { channelId, chars: message.length });
        res.json({ ok: true });
    }));
    app.post('/api/admin/render/:id/deploy', adminOnly, wrap(async (req, res) => {
        if (!/^srv-[a-z0-9]+$/i.test(req.params.id)) throw fail('ID không hợp lệ');
        await render(`/services/${req.params.id}/deploys`, { method: 'POST', body: '{}' });
        await audit('render.deploy', { serviceId: req.params.id });
        res.json({ ok: true });
    }));
    const UUID = /^[0-9a-f-]{36}$/i;
    app.post('/api/admin/railway/redeploy', adminOnly, wrap(async (req, res) => {
        const { serviceId, environmentId } = req.body || {};
        if (!UUID.test(String(serviceId)) || !UUID.test(String(environmentId))) throw fail('ID không hợp lệ');
        await gql(`mutation($s:String!,$e:String!){ serviceInstanceRedeploy(serviceId:$s, environmentId:$e) }`, { s: serviceId, e: environmentId });
        await audit('railway.redeploy', { serviceId, environmentId });
        res.json({ ok: true });
    }));
    app.post('/api/admin/github/rerun/:runId', adminOnly, wrap(async (req, res) => {
        if (!/^\d+$/.test(req.params.runId)) throw fail('ID không hợp lệ');
        await gh(`/actions/runs/${req.params.runId}/rerun`, { method: 'POST' });
        await audit('github.actions.rerun', { runId: req.params.runId });
        res.json({ ok: true });
    }));

    // ---------- Admin: sửa code trên GitHub (commit => Render tự deploy) ----------
    const okPath = p => typeof p === 'string' && /^[\w.\-\/]{1,120}$/.test(p) && !p.includes('..') && !/(^|\/)\.env/i.test(p) && !p.startsWith('/');
    app.get('/api/admin/gh/tree', adminOnly, wrap(async (req, res) => {
        const info = await gh('');
        const t = await gh(`/git/trees/${encodeURIComponent(info.default_branch)}?recursive=1`);
        res.json({ files: (t.tree || []).filter(f => f.type === 'blob' && f.size < 900000 && okPath(f.path)).map(f => ({ path: f.path, size: f.size })) });
    }));
    app.get('/api/admin/gh/file', adminOnly, wrap(async (req, res) => {
        const p = String(req.query.path || '');
        if (!okPath(p)) throw fail('Đường dẫn không hợp lệ');
        const f = await gh('/contents/' + p.split('/').map(encodeURIComponent).join('/'));
        if (!f || f.encoding !== 'base64') throw fail('Không đọc được file này (quá lớn hoặc không phải file).');
        res.json({ path: p, sha: f.sha, content: Buffer.from(f.content, 'base64').toString('utf8') });
    }));
    app.put('/api/admin/gh/file', adminOnly, wrap(async (req, res) => {
        const { path: p, content, sha, message } = req.body || {};
        if (!okPath(p)) throw fail('Đường dẫn không hợp lệ');
        if (typeof content !== 'string' || !content.length || content.length > 1500000) throw fail('Nội dung file không hợp lệ');
        if (sha && !/^[0-9a-f]{40}$/.test(String(sha))) throw fail('Mã phiên bản file không hợp lệ, hãy tải lại file');
        if (/\.js$/.test(p)) { try { new vm.Script(content, { filename: p }); } catch (e) { throw fail('Lỗi cú pháp, chưa commit: ' + e.message); } }
        const r = await gh('/contents/' + p.split('/').map(encodeURIComponent).join('/'), {
            method: 'PUT',
            body: JSON.stringify({ message: String(message || ((sha ? 'Cập nhật ' : 'Tạo ') + p + ' từ dashboard')).slice(0, 200), content: Buffer.from(content, 'utf8').toString('base64'), ...(sha ? { sha } : {}) })
        });
        await audit('github.file.commit', { path: p, commit: r.commit.sha.slice(0, 7) });
        res.json({ ok: true, sha: r.content.sha, commit: r.commit.sha.slice(0, 7) });
    }));
    app.delete('/api/admin/gh/file', adminOnly, wrap(async (req, res) => {
        const p = String((req.body || {}).path || '');
        const sha = String((req.body || {}).sha || '');
        if (!okPath(p) || !/^[0-9a-f]{40}$/.test(sha)) throw fail('Đường dẫn hoặc mã phiên bản file không hợp lệ');
        const r = await gh('/contents/' + p.split('/').map(encodeURIComponent).join('/'), {
            method: 'DELETE', body: JSON.stringify({ message: String((req.body || {}).message || ('Xóa ' + p + ' từ dashboard')).slice(0, 200), sha })
        });
        await audit('github.file.delete', { path: p });
        res.json({ ok: true, commit: r.commit && r.commit.sha ? r.commit.sha.slice(0, 7) : '' });
    }));

    // ---------- Admin: biến môi trường ----------
    const envKey = k => typeof k === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(k);
    app.get('/api/admin/env/render/:id', adminOnly, wrap(async (req, res) => {
        if (!/^srv-[a-z0-9]+$/i.test(req.params.id)) throw fail('ID không hợp lệ');
        const list = await render(`/services/${req.params.id}/env-vars?limit=100`);
        res.json({ vars: list.map(x => x.envVar || x).map(v => ({ key: v.key, value: v.value == null ? '' : v.value })) });
    }));
    app.put('/api/admin/env/render/:id', adminOnly, wrap(async (req, res) => {
        const { key, value } = req.body || {};
        if (!/^srv-[a-z0-9]+$/i.test(req.params.id) || !envKey(key)) throw fail('Dữ liệu không hợp lệ');
        await render(`/services/${req.params.id}/env-vars/${key}`, { method: 'PUT', body: JSON.stringify({ value: String(value == null ? '' : value) }) });
        await audit('render.env.update', { serviceId: req.params.id, key });
        res.json({ ok: true });
    }));
    app.delete('/api/admin/env/render/:id', adminOnly, wrap(async (req, res) => {
        const key = req.body && req.body.key;
        if (!/^srv-[a-z0-9]+$/i.test(req.params.id) || !envKey(key)) throw fail('Dữ liệu không hợp lệ');
        await render(`/services/${req.params.id}/env-vars/${key}`, { method: 'DELETE' });
        await audit('render.env.delete', { serviceId: req.params.id, key });
        res.json({ ok: true });
    }));
    const rwIds = o => {
        const { p, e, s } = o || {};
        if (![p, e, s].every(x => UUID.test(String(x)))) throw fail('ID không hợp lệ');
        return { projectId: p, environmentId: e, serviceId: s };
    };
    app.get('/api/admin/env/railway', adminOnly, wrap(async (req, res) => {
        const ids = rwIds(req.query);
        const d = await gql(`query($p:String!,$e:String!,$s:String){ variables(projectId:$p, environmentId:$e, serviceId:$s) }`, { p: ids.projectId, e: ids.environmentId, s: ids.serviceId });
        res.json({ vars: Object.entries(d.variables || {}).map(([key, value]) => ({ key, value: String(value) })) });
    }));
    app.put('/api/admin/env/railway', adminOnly, wrap(async (req, res) => {
        const ids = rwIds(req.body);
        if (!envKey(req.body.key)) throw fail('Tên biến không hợp lệ');
        await gql(`mutation($i: VariableUpsertInput!){ variableUpsert(input:$i) }`,
            { i: { ...ids, name: req.body.key, value: String(req.body.value == null ? '' : req.body.value), skipDeploys: true } });
        await audit('railway.env.update', { serviceId: ids.serviceId, key: req.body.key });
        res.json({ ok: true });
    }));
    app.delete('/api/admin/env/railway', adminOnly, wrap(async (req, res) => {
        const ids = rwIds(req.body);
        if (!envKey(req.body.key)) throw fail('Tên biến không hợp lệ');
        await gql(`mutation($i: VariableDeleteInput!){ variableDelete(input:$i) }`, { i: { ...ids, name: req.body.key } });
        await audit('railway.env.delete', { serviceId: ids.serviceId, key: req.body.key });
        res.json({ ok: true });
    }));

    // ---------- Admin: quản lý bot + gift code ----------
    const needBots = () => { if (!ctx.getBots) throw fail('Chưa truyền hàm quản lý bot vào dashboard (xem dòng require mới trong server.js).', 501); };
    app.get('/api/admin/bots', adminOnly, wrap(async (req, res) => {
        needBots();
        res.json({ bots: (await ctx.getBots()).map(ctx.botView) });
    }));
    app.post('/api/admin/bots', adminOnly, wrap(async (req, res) => {
        needBots();
        const token = String((req.body && req.body.token) || '').trim();
        if (!token) throw fail('Thiếu token');
        if ((await ctx.getBots()).some(b => ctx.tokenOf(b) === token)) throw fail('Token này đã có rồi');
        const id = crypto.randomBytes(4).toString('hex');
        let started = false;
        try {
            const c = await ctx.startBot(id, token);
            started = true;
            await ctx.saveBot({ id, name: c.user.tag, token, enabled: true });
            res.json({ ok: true });
        } catch (e) {
            if (started) await ctx.stopBot(id).catch(() => {});
            throw fail('Token sai hoặc không đăng nhập được: ' + e.message);
        }
    }));
    app.post('/api/admin/bots/:id/toggle', adminOnly, wrap(async (req, res) => {
        needBots();
        const b = (await ctx.getBots()).find(x => x.id === req.params.id);
        if (!b) throw fail('Không thấy bot', 404);
        if (b.enabled) { await ctx.stopBot(b.id); b.enabled = false; }
        else {
            if (!ctx.tokenOf(b)) throw fail('Bot này chưa có token');
            await ctx.startBot(b.id, ctx.tokenOf(b)); b.enabled = true;
        }
        await ctx.saveBot(b);
        res.json({ ok: true });
    }));
    app.delete('/api/admin/bots/:id', adminOnly, wrap(async (req, res) => {
        needBots();
        if (req.params.id === 'main') throw fail('Không xóa được bot chính');
        await ctx.stopBot(req.params.id);
        await redis.hdel('panel_bots', req.params.id);
        res.json({ ok: true });
    }));
    app.post('/api/admin/gen', adminOnly, wrap(async (req, res) => {
        const count = Math.floor(Number(req.body && req.body.count)), coins = Math.floor(Number(req.body && req.body.coins));
        if (!(count >= 1 && count <= 100) || !(coins >= 1 && coins <= 1000000)) throw fail('Số lượng 1–100, xu 1–1.000.000');
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', codes = [];
        for (let i = 0; i < count; i++) {
            let code = '';
            for (let a = 0; a < 10 && !code; a++) {
                let c = '';
                for (let k = 0; k < 12; k++) c += chars[crypto.randomInt(chars.length)];
                if (await redis.set(`gift_${c}`, String(coins), 'EX', 30 * 86400, 'NX')) code = c;
            }
            if (!code) throw fail('Không tạo được mã duy nhất, thử lại.');
            codes.push(code);
        }
        res.json({ codes });
    }));

    // Ảnh nền kính nhúng sẵn trong file này, không cần upload thêm
    app.get('/dash-bg.jpg', (req, res) => {
        res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' });
        res.send(BG_IMG);
    });
    app.get('/dashboard', (req, res) => res.type('html').send(DASH_HTML));
};

const BG_IMG = Buffer.from('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', 'base64');

// Bản đồ khúc xạ cho hiệu ứng Liquid Glass: giữa = phẳng (xám 128), rìa = bẻ ánh sáng vào trong
const LG_MAP = 'data:image/svg+xml,' + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200' preserveAspectRatio='none'>" +
    "<defs>" +
    "<linearGradient id='l' x1='0' x2='1' y1='0' y2='0'><stop offset='0' stop-color='rgb(0,128,128)'/><stop offset='0.35' stop-color='rgb(60,128,128)'/><stop offset='0.65' stop-color='rgb(105,128,128)'/><stop offset='1' stop-color='rgb(128,128,128)'/></linearGradient><linearGradient id='r' x1='0' x2='1' y1='0' y2='0'><stop offset='0' stop-color='rgb(128,128,128)'/><stop offset='0.35' stop-color='rgb(150,128,128)'/><stop offset='0.65' stop-color='rgb(195,128,128)'/><stop offset='1' stop-color='rgb(255,128,128)'/></linearGradient><linearGradient id='t' x1='0' x2='0' y1='0' y2='1'><stop offset='0' stop-color='rgb(128,0,128)'/><stop offset='0.35' stop-color='rgb(128,60,128)'/><stop offset='0.65' stop-color='rgb(128,105,128)'/><stop offset='1' stop-color='rgb(128,128,128)'/></linearGradient><linearGradient id='b' x1='0' x2='0' y1='0' y2='1'><stop offset='0' stop-color='rgb(128,128,128)'/><stop offset='0.35' stop-color='rgb(128,150,128)'/><stop offset='0.65' stop-color='rgb(128,195,128)'/><stop offset='1' stop-color='rgb(128,255,128)'/></linearGradient>" +
    "</defs>" +
    "<rect width='200' height='200' fill='rgb(128,128,128)'/>" +
    "<rect width='20' height='200' fill='url(#l)'/><rect x='180' width='20' height='200' fill='url(#r)'/>" +
    "<rect width='200' height='20' fill='url(#t)'/><rect y='180' width='200' height='20' fill='url(#b)'/>" +
    "</svg>");

const DASH_HTML = String.raw`<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0e0f1c">
<title>Nigaria Control Center</title>
<style>
:root{
  --g1:rgba(99,102,241,.18);--g2:rgba(139,92,246,.14);--g3:rgba(59,130,246,.10);
  --glass:rgba(255,255,255,.045);--glass-h:rgba(255,255,255,.07);
  --edge:rgba(255,255,255,.09);--edge-s:rgba(255,255,255,.05);
  --tx:#f0f0ff;--mut:rgba(200,200,255,.45);--ok:#4ade80;--ac:#818cf8;--bad:#f87171;--warn:#fbbf24;
  --blur:blur(24px) saturate(1.8);--blur-lg:blur(40px) saturate(2);
}
*{box-sizing:border-box;margin:0;padding:0}
html{height:100%}
body{
  background:#04050f;
  color:var(--tx);
  font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
  min-height:100vh;
  overflow-x:hidden;
}
/* BACKGROUND ORBS */
body::before{content:'';position:fixed;inset:0;z-index:0;pointer-events:none;
  background:
    radial-gradient(ellipse 60% 50% at 15% 10%, rgba(99,102,241,.22) 0%, transparent 70%),
    radial-gradient(ellipse 50% 60% at 85% 80%, rgba(139,92,246,.18) 0%, transparent 70%),
    radial-gradient(ellipse 40% 40% at 50% 50%, rgba(30,20,80,.5) 0%, transparent 80%),
    radial-gradient(ellipse 70% 70% at 70% 20%, rgba(59,130,246,.10) 0%, transparent 70%);
}
body::after{content:'';position:fixed;inset:0;z-index:0;pointer-events:none;
  background:
    radial-gradient(ellipse 300px 300px at 20% 90%, rgba(79,70,229,.14) 0%, transparent 70%),
    radial-gradient(ellipse 250px 250px at 90% 10%, rgba(167,139,250,.12) 0%, transparent 70%);
  animation:orb 18s ease-in-out infinite alternate;
}
@keyframes orb{0%{opacity:.7;transform:scale(1)}100%{opacity:1;transform:scale(1.15)}}

/* HEADER */
.hdr{position:fixed;top:0;left:0;right:0;height:56px;background:rgba(4,5,15,.55);border-bottom:1px solid var(--edge-s);display:flex;align-items:center;gap:12px;padding:0 16px;z-index:200;backdrop-filter:var(--blur-lg);-webkit-backdrop-filter:var(--blur-lg);padding-top:env(safe-area-inset-top,0)}
.ham{background:rgba(255,255,255,.06);border:1px solid var(--edge-s);color:var(--tx);font-size:20px;cursor:pointer;padding:5px 8px;line-height:1;border-radius:10px;transition:background .2s,border-color .2s}
.ham:hover{background:rgba(255,255,255,.12);border-color:var(--edge)}
.hdr-logo{font-weight:900;font-size:16px;letter-spacing:3px;flex:1;background:linear-gradient(90deg,#c7d2fe,#a5b4fc,#818cf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hdr-logo span{opacity:.6}
.hdr-right{display:flex;align-items:center;gap:10px}
#av{width:32px;height:32px;border-radius:50%;border:1px solid var(--edge);flex:none;object-fit:cover}
.coin{color:var(--warn);font-weight:700;font-size:13px;text-shadow:0 0 12px rgba(251,191,36,.4)}

/* OVERLAY */
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:299;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
.overlay.show{display:block}

/* SIDEBAR */
.sidebar{position:fixed;top:0;left:0;bottom:0;width:260px;background:rgba(6,6,20,.7);border-right:1px solid var(--edge-s);z-index:300;transform:translateX(-100%);transition:transform .3s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column;padding-top:env(safe-area-inset-top,0);backdrop-filter:var(--blur-lg);-webkit-backdrop-filter:var(--blur-lg)}
.sidebar.open{transform:translateX(0)}
.side-head{padding:20px 16px 16px;border-bottom:1px solid var(--edge-s);display:flex;align-items:center;gap:12px}
.side-head img{width:46px;height:46px;border-radius:50%;border:2px solid var(--edge);flex:none;object-fit:cover}
.side-name{font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e0e7ff}
.side-coin{color:var(--warn);font-size:12px;font-weight:600;margin-top:2px}
.side-body{flex:1;overflow-y:auto;padding:8px 0;scrollbar-width:none}
.side-body::-webkit-scrollbar{display:none}
.nav-label{font-size:10px;font-weight:700;letter-spacing:.15em;color:rgba(165,180,252,.4);padding:14px 18px 5px;text-transform:uppercase}
.nav-item{display:flex;align-items:center;gap:12px;width:100%;background:none;border:none;color:rgba(200,210,255,.5);font:inherit;font-size:14px;font-weight:500;padding:11px 18px;cursor:pointer;text-align:left;transition:all .18s;border-radius:0}
.nav-item:hover{background:rgba(129,140,248,.1);color:rgba(200,210,255,.9)}
.nav-item.on{background:linear-gradient(90deg,rgba(99,102,241,.2),rgba(139,92,246,.1));color:#c7d2fe;font-weight:700;border-right:2px solid rgba(165,180,252,.6)}
.nav-ico{font-size:18px;width:26px;text-align:center;flex:none}
.nav-sep{height:1px;background:var(--edge-s);margin:8px 14px}
.side-foot{padding:12px;border-top:1px solid var(--edge-s);padding-bottom:calc(12px + env(safe-area-inset-bottom,0))}
.side-logout{width:100%;background:rgba(248,113,113,.06);border:1px solid rgba(248,113,113,.15);color:rgba(248,113,113,.7);font:inherit;font-size:13px;padding:10px;border-radius:12px;cursor:pointer;transition:all .18s}
.side-logout:hover{background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.4);color:var(--bad)}

/* MAIN */
.main{padding:72px 14px 36px;max-width:680px;margin:0 auto;position:relative;z-index:1}

/* GLASS CARDS */
.card{background:var(--glass);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);border:1px solid var(--edge-s);border-radius:20px;padding:18px;margin-bottom:14px;box-shadow:0 4px 24px rgba(0,0,0,.2),inset 0 1px 0 rgba(255,255,255,.08)}
.card h3{margin:0 0 14px;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:rgba(165,180,252,.55)}

.big{font-size:38px;font-weight:800;line-height:1.1;background:linear-gradient(135deg,#fbbf24,#f59e0b);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.row>input,.row>select{flex:1;min-width:120px}

input,select,textarea{
  width:100%;padding:12px;border-radius:14px;
  border:1px solid var(--edge-s);
  background:rgba(255,255,255,.04);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  color:var(--tx);font:inherit;font-size:14px;
  transition:border-color .2s,box-shadow .2s;
}
input:focus,select:focus,textarea:focus{outline:none;border-color:rgba(129,140,248,.5);box-shadow:0 0 0 3px rgba(99,102,241,.12)}
input::placeholder,textarea::placeholder{color:rgba(200,200,255,.25)}
select option{background:#0d0e1f}
textarea{font:12.5px/1.45 ui-monospace,Menlo,Consolas,monospace;min-height:55vh;resize:vertical;white-space:pre;tab-size:4}

.m{color:var(--mut);font-size:12.5px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.m a,.t a{color:#a5b4fc;text-decoration:none}
.t{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e0e7ff}
.top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}

.chip{font-size:11px;font-weight:700;padding:3px 9px;border-radius:99px;border:1px solid;white-space:nowrap;backdrop-filter:blur(8px)}
.ok.chip,.cok{color:var(--ok);border-color:rgba(74,222,128,.35);background:rgba(74,222,128,.08)}
.bad.chip{color:var(--bad);border-color:rgba(248,113,113,.35);background:rgba(248,113,113,.08)}
.warn.chip{color:var(--warn);border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.08)}
.off.chip{color:var(--mut);border-color:rgba(200,200,255,.12);background:rgba(200,200,255,.04)}

.acts{display:flex;gap:6px;margin-top:12px;flex-wrap:wrap}
.err{background:rgba(248,113,113,.08);color:#fca5a5;border-radius:14px;padding:12px 14px;font-size:13px;border:1px solid rgba(248,113,113,.2);backdrop-filter:blur(8px)}
.li{padding:12px 0;border-top:1px solid var(--edge-s)}.li:first-child{border-top:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;align-items:start}
.kv{font:13px ui-monospace,Menlo,monospace;background:rgba(0,0,0,.2);border:1px solid var(--edge-s);border-radius:12px;padding:10px;word-break:break-all;margin:6px 0;backdrop-filter:blur(8px)}
.hint{color:var(--mut);font-size:13px;margin:6px 0 10px}

/* BUTTONS */
.btn{border:0;border-radius:12px;padding:11px 18px;background:linear-gradient(135deg,rgba(99,102,241,.85),rgba(139,92,246,.85));color:#fff;font:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:all .2s;backdrop-filter:blur(10px);box-shadow:0 2px 12px rgba(99,102,241,.25),inset 0 1px 0 rgba(255,255,255,.12)}
.btn:not(:disabled):hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(99,102,241,.4),inset 0 1px 0 rgba(255,255,255,.15)}
.btn:not(:disabled):active{transform:translateY(0)}
.btn.ok{background:linear-gradient(135deg,rgba(22,101,52,.9),rgba(21,128,61,.9));box-shadow:0 2px 12px rgba(74,222,128,.2)}
.btn.ok:not(:disabled):hover{box-shadow:0 6px 20px rgba(74,222,128,.35)}
.btn.bad{background:linear-gradient(135deg,rgba(153,27,27,.9),rgba(185,28,28,.9));box-shadow:0 2px 12px rgba(248,113,113,.2)}
.btn.bad:not(:disabled):hover{box-shadow:0 6px 20px rgba(248,113,113,.35)}
.btn.sm{padding:7px 12px;font-size:12px;border-radius:10px}
.btn:disabled{opacity:.35;cursor:not-allowed;transform:none}

.ghost{background:rgba(255,255,255,.05);border:1px solid var(--edge-s);color:var(--mut);border-radius:10px;padding:8px 12px;font:inherit;font-size:13px;cursor:pointer;text-decoration:none;display:inline-block;backdrop-filter:blur(8px);transition:all .18s}
.ghost:hover{background:rgba(255,255,255,.09);border-color:var(--edge);color:var(--tx)}

/* LOGIN */
#login{display:none;max-width:380px;margin:16vh auto 0;text-align:center;padding:0 20px}
#login .glass-box{background:var(--glass);backdrop-filter:var(--blur-lg);-webkit-backdrop-filter:var(--blur-lg);border:1px solid var(--edge-s);border-radius:28px;padding:36px 28px;box-shadow:0 8px 40px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.1)}
#login h1{font-size:30px;font-weight:900;letter-spacing:3px;margin-bottom:6px;background:linear-gradient(90deg,#c7d2fe,#a5b4fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
#login h1 span{opacity:.5}
#login .hint{margin-bottom:22px}
#login .btn{width:100%;padding:14px;margin-bottom:10px;font-size:15px}
#app{display:none;position:relative;z-index:1}

/* TOAST */
.toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,30px);background:rgba(10,10,30,.8);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);border:1px solid var(--edge);padding:12px 20px;border-radius:16px;font-size:14px;opacity:0;pointer-events:none;transition:.28s;max-width:90vw;z-index:9999;box-shadow:0 8px 32px rgba(0,0,0,.3)}
.toast.show{opacity:1;transform:translate(-50%,0)}
.toast.bad{background:rgba(60,10,20,.85);color:#fca5a5;border-color:rgba(248,113,113,.3)}
.evar{display:grid;grid-template-columns:1fr;gap:6px;padding:10px 0;border-top:1px solid var(--edge-s)}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
<style id="aqua">
/* ===== AQUA GLASS: kính trong veo như nước, ảnh nền xuyên qua kính ===== */
:root{
  --glass:rgba(255,255,255,.11);--glass-h:rgba(255,255,255,.18);
  --edge:rgba(255,255,255,.42);--edge-s:rgba(255,255,255,.24);
  --tx:#fff;--mut:rgba(255,255,255,.74);--ac:#cfe0ff;
  --ok:#7dffc0;--bad:#ff9aa8;--warn:#ffe27a;
  --blur:blur(14px) saturate(1.7) brightness(1.08);--blur-lg:blur(22px) saturate(1.8) brightness(1.1);
  --sheen:linear-gradient(135deg,rgba(255,255,255,.34),rgba(255,255,255,.06) 38%,rgba(255,255,255,.02) 62%,rgba(255,255,255,.16));
}
html{background:#0b1226}
body{background:transparent;color:var(--tx);text-shadow:0 1px 8px rgba(8,16,48,.38)}
body::before{
  background:
    linear-gradient(180deg,rgba(6,12,34,.30),rgba(6,12,34,.52)),
    url(data:image/jpeg;base64,${BG_IMG.toString('base64')}) center top/cover no-repeat,
    linear-gradient(140deg,#1b2a5c,#4d6fb8 45%,#0b1226);
  transform:none;animation:none;z-index:-2;
}
body::after{
  z-index:-1;
  background:
    radial-gradient(ellipse 420px 320px at 12% 18%,rgba(190,225,255,.22),transparent 70%),
    radial-gradient(ellipse 380px 300px at 88% 78%,rgba(210,190,255,.20),transparent 70%),
    radial-gradient(ellipse 260px 200px at 70% 10%,rgba(255,255,255,.12),transparent 70%);
  animation:aqua 14s ease-in-out infinite alternate;
}
@keyframes aqua{0%{opacity:.65;transform:translate3d(0,0,0) scale(1)}100%{opacity:1;transform:translate3d(-10px,14px,0) scale(1.08)}}

/* Kính */
.card,#login .glass-box{
  position:relative;overflow:hidden;
  background:var(--sheen),var(--glass);
  -webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);
  border:1px solid var(--edge);border-radius:26px;
  box-shadow:0 14px 44px rgba(10,24,70,.38),inset 0 1.5px 0 rgba(255,255,255,.65),inset 0 -1px 0 rgba(255,255,255,.12),inset 0 0 34px rgba(255,255,255,.07);
  transition:transform .25s,border-color .25s,box-shadow .25s;
}
.card::before,#login .glass-box::before{
  content:'';position:absolute;inset:0;pointer-events:none;border-radius:inherit;
  background:linear-gradient(115deg,rgba(255,255,255,.28) 0%,rgba(255,255,255,0) 22%),
             radial-gradient(120% 60% at 0% 0%,rgba(255,255,255,.16),transparent 60%);
  mix-blend-mode:soft-light;
}
.card>*,#login .glass-box>*{position:relative}
.card:hover{border-color:rgba(255,255,255,.62);box-shadow:0 18px 52px rgba(10,24,70,.46),inset 0 1.5px 0 rgba(255,255,255,.8),inset 0 0 40px rgba(255,255,255,.1)}
.card h3{color:rgba(255,255,255,.82);letter-spacing:.14em}
.big{background:linear-gradient(135deg,#fff,#ffe9a8 60%,#ffd166);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;text-shadow:none;filter:drop-shadow(0 2px 10px rgba(255,200,80,.35))}

/* Header + sidebar */
.hdr{background:linear-gradient(180deg,rgba(255,255,255,.2),rgba(255,255,255,.07));border-bottom:1px solid var(--edge);-webkit-backdrop-filter:var(--blur-lg);backdrop-filter:var(--blur-lg);box-shadow:0 6px 28px rgba(10,24,70,.28),inset 0 1px 0 rgba(255,255,255,.5)}
.hdr-logo{background:linear-gradient(90deg,#fff,#d6e6ff 55%,#e6d9ff);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;text-shadow:none}
.ham{background:rgba(255,255,255,.16);border:1px solid var(--edge);color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.5)}
.ham:hover{background:rgba(255,255,255,.28)}
#av,.side-head img{border:2px solid rgba(255,255,255,.7);box-shadow:0 0 18px rgba(190,220,255,.5)}
.coin{color:#ffe27a;text-shadow:0 0 14px rgba(255,214,102,.6)}
.overlay{background:rgba(6,12,34,.38);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.sidebar{background:linear-gradient(160deg,rgba(255,255,255,.22),rgba(255,255,255,.07));border-right:1px solid var(--edge);-webkit-backdrop-filter:var(--blur-lg);backdrop-filter:var(--blur-lg);box-shadow:12px 0 44px rgba(8,18,56,.4),inset -1px 0 0 rgba(255,255,255,.3)}
.side-head,.side-foot{border-color:var(--edge-s)}
.side-name{color:#fff}
.side-coin{color:#ffe27a}
.nav-label{color:rgba(255,255,255,.62)}
.nav-item{color:rgba(255,255,255,.82);border-radius:14px;margin:2px 8px;width:calc(100% - 16px)}
.nav-item:hover{background:rgba(255,255,255,.18);color:#fff}
.nav-item.on{background:linear-gradient(135deg,rgba(255,255,255,.36),rgba(255,255,255,.12));border:1px solid rgba(255,255,255,.55);border-right:1px solid rgba(255,255,255,.55);color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.7),0 4px 16px rgba(10,24,70,.25)}
.nav-sep{background:var(--edge-s)}
.side-logout{background:rgba(255,120,140,.16);border:1px solid rgba(255,170,185,.5);color:#ffd2d9}
.side-logout:hover{background:rgba(255,120,140,.3);color:#fff}

/* Nút */
.btn{border:1px solid rgba(255,255,255,.55);color:#fff;text-shadow:0 1px 4px rgba(10,24,70,.45);
  background:linear-gradient(135deg,rgba(255,255,255,.42),rgba(150,190,255,.18) 55%,rgba(255,255,255,.2));
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
  box-shadow:0 6px 20px rgba(14,30,84,.32),inset 0 1.5px 0 rgba(255,255,255,.75),inset 0 -1px 0 rgba(255,255,255,.15)}
.btn:not(:disabled):hover{transform:translateY(-2px);box-shadow:0 10px 28px rgba(14,30,84,.42),inset 0 1.5px 0 rgba(255,255,255,.9);filter:brightness(1.12)}
.btn.ok{background:linear-gradient(135deg,rgba(125,255,192,.5),rgba(40,190,120,.2) 55%,rgba(255,255,255,.18));border-color:rgba(160,255,210,.7)}
.btn.bad{background:linear-gradient(135deg,rgba(255,140,160,.52),rgba(220,60,90,.22) 55%,rgba(255,255,255,.16));border-color:rgba(255,185,196,.7)}
.btn.ok:not(:disabled):hover,.btn.bad:not(:disabled):hover{box-shadow:0 10px 28px rgba(14,30,84,.42),inset 0 1.5px 0 rgba(255,255,255,.9)}
.ghost{background:rgba(255,255,255,.14);border:1px solid var(--edge);color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.45)}
.ghost:hover{background:rgba(255,255,255,.26);color:#fff}

/* Ô nhập */
input,select,textarea{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.38);color:#fff;text-shadow:none;
  box-shadow:inset 0 2px 10px rgba(10,24,70,.18),inset 0 1px 0 rgba(255,255,255,.25)}
input:focus,select:focus,textarea:focus{border-color:rgba(255,255,255,.85);box-shadow:0 0 0 3px rgba(190,220,255,.35),inset 0 2px 10px rgba(10,24,70,.15);background:rgba(255,255,255,.2)}
input::placeholder,textarea::placeholder{color:rgba(255,255,255,.58)}
select option{background:#1d2a52;color:#fff}

/* Chữ, nhãn, khối nhỏ */
.t{color:#fff}.m a,.t a{color:#d6e6ff;text-decoration:underline;text-decoration-color:rgba(214,230,255,.35)}
.hint{color:var(--mut)}
.li,.evar{border-top-color:var(--edge-s)}
.kv{background:rgba(8,16,48,.32);border:1px solid var(--edge-s);color:#eaf2ff;text-shadow:none}
.chip{-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);box-shadow:inset 0 1px 0 rgba(255,255,255,.3)}
.ok.chip,.cok{color:#b9ffdc;border-color:rgba(160,255,210,.7);background:rgba(60,220,150,.22)}
.bad.chip{color:#ffd0d7;border-color:rgba(255,170,185,.7);background:rgba(255,90,120,.24)}
.warn.chip{color:#fff0b0;border-color:rgba(255,226,122,.7);background:rgba(255,200,60,.22)}
.off.chip{color:#fff;border-color:rgba(255,255,255,.45);background:rgba(255,255,255,.14)}
.err{background:rgba(255,90,120,.24);color:#fff;border:1px solid rgba(255,170,185,.7)}

/* Đăng nhập + thông báo */
#login h1{background:linear-gradient(90deg,#fff,#cfe0ff 60%,#e6d9ff);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;text-shadow:none;filter:drop-shadow(0 4px 16px rgba(190,220,255,.5))}
.toast{background:linear-gradient(135deg,rgba(255,255,255,.34),rgba(255,255,255,.14));color:#fff;border:1px solid rgba(255,255,255,.65);-webkit-backdrop-filter:var(--blur-lg);backdrop-filter:var(--blur-lg);box-shadow:0 12px 40px rgba(10,24,70,.45),inset 0 1.5px 0 rgba(255,255,255,.75)}
.toast.bad{background:linear-gradient(135deg,rgba(255,120,145,.55),rgba(255,255,255,.14));color:#fff;border-color:rgba(255,190,200,.8)}
::selection{background:rgba(190,220,255,.5)}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,.35);border-radius:8px}

/* Trình duyệt cũ không hỗ trợ blur: tăng độ đục để vẫn đọc được */
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
  .card,#login .glass-box,.hdr,.sidebar,.toast{background:rgba(40,60,120,.62)}
}
/* ===== TRONG VEO: không làm mờ, nhìn xuyên thẳng qua kính ===== */
:root{
  --glass:rgba(10,20,52,.16);--mut:rgba(255,255,255,.92);
  --sheen:linear-gradient(135deg,rgba(255,255,255,.20),rgba(255,255,255,.02) 34%,rgba(255,255,255,0) 62%,rgba(255,255,255,.10));
  --blur:saturate(1.35) brightness(1.06);--blur-lg:saturate(1.45) brightness(1.08);
}
body::before{background:
  linear-gradient(180deg,rgba(6,12,34,.10),rgba(6,12,34,.30)),
  url(data:image/jpeg;base64,${BG_IMG.toString('base64')}) center top/cover no-repeat,
  linear-gradient(140deg,#1b2a5c,#4d6fb8 45%,#0b1226)}
.card,#login .glass-box,.hdr,.sidebar,.toast,.btn,.chip,.ghost,.ham,input,select,textarea,.kv,.err,.overlay{
  -webkit-backdrop-filter:saturate(1.3) brightness(1.05);backdrop-filter:saturate(1.3) brightness(1.05)}
.overlay{background:rgba(6,12,34,.22)}
.card,#login .glass-box{box-shadow:0 14px 44px rgba(10,24,70,.30),inset 0 1.5px 0 rgba(255,255,255,.85),inset 0 -1.5px 0 rgba(255,255,255,.28),inset 1px 0 0 rgba(255,255,255,.30),inset -1px 0 0 rgba(255,255,255,.18),inset 0 0 26px rgba(255,255,255,.05)}
.hdr{background:linear-gradient(180deg,rgba(255,255,255,.14),rgba(255,255,255,.02))}
.sidebar{background:linear-gradient(160deg,rgba(255,255,255,.14),rgba(255,255,255,.03))}
.btn{background:linear-gradient(135deg,rgba(255,255,255,.30),rgba(170,205,255,.08) 55%,rgba(255,255,255,.14))}
input,select,textarea{background:rgba(6,12,36,.40)}
input::placeholder,textarea::placeholder{color:rgba(255,255,255,.78)}
input:focus,select:focus,textarea:focus{background:rgba(255,255,255,.13)}
.kv{background:rgba(8,16,48,.22)}
/* chữ rõ hơn khi nền không còn bị làm mờ */
body{text-shadow:0 1px 2px rgba(0,8,36,.9),0 0 10px rgba(0,8,36,.7),0 0 22px rgba(0,8,36,.4)}
.big,.hdr-logo,#login h1{filter:drop-shadow(0 1px 2px rgba(0,8,36,.95)) drop-shadow(0 0 10px rgba(0,8,36,.6))}
.btn,.big,.hdr-logo,#login h1{text-shadow:none}
.btn{text-shadow:0 1px 3px rgba(0,8,36,.7)}
input,select,textarea{text-shadow:0 1px 2px rgba(0,8,36,.6)}
@media(max-width:640px){.card{border-radius:22px}}
</style>
<style id="liquid">
/* ===== LIQUID GLASS (kiểu iOS 26): rìa kính bẻ cong ánh sáng, viền sáng, nút viên thuốc ===== */
:root{--glass:rgba(8,14,40,.38);--sheen:linear-gradient(135deg,rgba(255,255,255,.10),rgba(255,255,255,0) 36%,rgba(255,255,255,0) 66%,rgba(255,255,255,.08))}
.card,#login .glass-box,.hdr,.sidebar,.toast{
  -webkit-backdrop-filter:saturate(1.5) brightness(1.08);backdrop-filter:saturate(1.5) brightness(1.08);
  background:var(--sheen),var(--glass);border:0;
  box-shadow:0 18px 50px rgba(8,20,60,.22),0 2px 6px rgba(8,20,60,.10),inset 0 0 22px rgba(255,255,255,.05),inset 0 1px 1px rgba(255,255,255,.7),inset 0 -1px 1px rgba(255,255,255,.35);
}
.card,#login .glass-box{border-radius:30px}
.btn,.ghost,.ham,.chip,.nav-item,input,select{
  -webkit-backdrop-filter:saturate(1.5) brightness(1.1);backdrop-filter:saturate(1.5) brightness(1.1);
}
.btn,.ghost,.chip{border-radius:999px}
.btn{padding:11px 22px;border:0;box-shadow:0 8px 22px rgba(8,20,60,.28),inset 0 0 18px rgba(255,255,255,.16),inset 0 -6px 12px rgba(255,255,255,.10)}
.btn.sm{padding:8px 15px}
input,select{border:0;border-radius:18px;box-shadow:inset 0 2px 12px rgba(8,20,60,.28),inset 0 0 0 1px rgba(255,255,255,.22)}
.nav-item.on{border:0;box-shadow:inset 0 0 18px rgba(255,255,255,.2),0 4px 16px rgba(8,20,60,.22)}
/* Viền sáng chéo: góc trên-trái và dưới-phải bắt sáng như mép kính thật */
.card::after,#login .glass-box::after,.hdr::after,.sidebar::after,.btn::after,.ghost::after,.toast::after,input::after{
  content:'';position:absolute;inset:0;border-radius:inherit;padding:1.4px;pointer-events:none;
  background:linear-gradient(135deg,#fff,rgba(255,255,255,.18) 24%,rgba(255,255,255,.05) 50%,rgba(255,255,255,.18) 76%,#fff);
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;
  mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0);mask-composite:exclude;
}
.btn,.ghost{position:relative}
.hdr::after,.sidebar::after{border-radius:0;opacity:.6}
.card:hover{transform:translateY(-1px)}

/* Máy tính (chuột): bật bẻ cong ở rìa bằng SVG. Điện thoại bỏ để không lag. */
.steps{margin:6px 0 10px 20px;padding:0}.steps li{margin:7px 0;line-height:1.5}
.tok{font:700 21px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.1em;text-align:center;padding:16px 8px;user-select:all;-webkit-user-select:all}
@media (hover:hover) and (pointer:fine){
  .card,#login .glass-box,.hdr,.sidebar,.toast{-webkit-backdrop-filter:url(#lg-big) saturate(1.6) brightness(1.04);backdrop-filter:url(#lg-big) saturate(1.6) brightness(1.04)}
  .btn,.ghost,.ham,.chip,.nav-item,input,select{-webkit-backdrop-filter:url(#lg-small) saturate(1.5) brightness(1.1);backdrop-filter:url(#lg-small) saturate(1.5) brightness(1.1)}
}
/* Điện thoại: chỉ giữ kính ở khối lớn, bỏ hiệu ứng nặng */
@media (hover:none),(pointer:coarse){
  .btn,.ghost,.ham,.chip,.nav-item,input,select,textarea,.kv,.err,.overlay{-webkit-backdrop-filter:none;backdrop-filter:none}
  .card,#login .glass-box,.hdr,.sidebar,.toast{-webkit-backdrop-filter:saturate(1.4) brightness(1.05);backdrop-filter:saturate(1.4) brightness(1.05)}
  body::after{animation:none;opacity:.8}
  .card::before,#login .glass-box::before{mix-blend-mode:normal;opacity:.5}
  .card,.btn,.nav-item{transition:none}
  .card:hover{transform:none}
}
/* Menu bên: kính đậm để chữ không bị nội dung phía sau đè lên */
.sidebar{background:linear-gradient(160deg,rgba(26,42,96,.90),rgba(8,14,42,.94))!important;-webkit-backdrop-filter:blur(18px)!important;backdrop-filter:blur(18px)!important}
</style>
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <defs>
    <filter id="lg-big" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">
      <feImage href="${LG_MAP}" preserveAspectRatio="none" result="map"/>
      <feDisplacementMap in="SourceGraphic" in2="map" scale="34" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="lg-small" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">
      <feImage href="${LG_MAP}" preserveAspectRatio="none" result="map"/>
      <feDisplacementMap in="SourceGraphic" in2="map" scale="12" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  </defs>
</svg></head><body>
<div id="login">
  <div class="glass-box">
  <h1>NIGARIA<span>_</span></h1>
  <p class="hint">Tạo tài khoản web, lấy token rồi gõ <b>/ketnoi</b> trong Discord để liên kết xu và mua cloud phone.</p>
  <button class="btn ok" style="width:100%;padding:14px;margin-bottom:10px" onclick="startGuest()">✨ Bắt đầu và lấy token</button>
  <a id="dlogin" class="btn" style="display:block;text-decoration:none" href="/auth/discord">🎮 Đã liên kết? Đăng nhập Discord</a>
  <details style="text-align:left;margin-top:14px"><summary class="hint" style="cursor:pointer">Admin: đăng nhập bằng mật khẩu</summary>
  <input id="pw" type="password" placeholder="Mật khẩu admin" autocomplete="current-password" style="margin:10px 0">
  <button class="btn" onclick="pwLogin()">Vào bằng mật khẩu</button></details>
  </div>
</div>
<div id="app">
  <header class="hdr">
    <button class="ham" onclick="toggleSide()">☰</button>
    <div class="hdr-logo">NIGARIA<span>_</span>Cloud</div>
    <div class="hdr-right"><span class="coin" id="hc"></span><img id="av" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div>
  </header>
  <div class="overlay" id="overlay" onclick="closeSide()"></div>
  <nav class="sidebar" id="sidebar">
    <div class="side-head">
      <img id="sav" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <div style="min-width:0"><div class="side-name" id="snm"></div><div class="side-coin" id="shc"></div></div>
    </div>
    <div class="side-body" id="sideNav"></div>
    <div class="side-foot"><button onclick="logout()" class="side-logout">Đăng xuất</button></div>
  </nav>
  <div class="main" id="main"></div>
</div>
<div class="toast" id="toast"></div>
<script>
var K=sessionStorage.getItem('k')||'',ME=null,TAB='',OV=null,LAST=null,FILE=null,TOPS='all',DASH_REFRESH=0;
function $(i){return document.getElementById(i)}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function toast(t,bad){var e=$('toast');e.textContent=t;e.className='toast show'+(bad?' bad':'');clearTimeout(window._t);window._t=setTimeout(function(){e.className='toast'},3400)}
function ago(d){if(!d)return '';var s=Math.max(0,(Date.now()-new Date(d).getTime())/1000);if(s<60)return 'vừa xong';if(s<3600)return Math.floor(s/60)+' phút trước';if(s<86400)return Math.floor(s/3600)+' giờ trước';return Math.floor(s/86400)+' ngày trước'}
function api(m,u,b){var hd={'Content-Type':'application/json','x-requested-with':'dashboard'};if(K)hd['x-panel-key']=K;
 return fetch(u,{method:m,headers:hd,credentials:'same-origin',body:b?JSON.stringify(b):undefined}).then(function(r){return r.json().catch(function(){return {}}).then(function(j){if(!r.ok){var e=new Error(j.error||'Có lỗi xảy ra');e.status=r.status;throw e}return j})})}
function num(n){return Number(n||0).toLocaleString('vi-VN')}
function link(u,t){return u?'<a href="'+esc(u)+'" target="_blank" rel="noopener">'+esc(t)+'</a>':esc(t)}
function busy(b,p){b.disabled=true;return p.then(function(r){b.disabled=false;return r},function(e){b.disabled=false;throw e})}
function showLogin(msg){$('app').style.display='none';$('login').style.display='block';if(msg)toast(msg,true)}
function startGuest(){api('POST','/api/guest').then(function(){TAB='';boot()}).catch(function(e){toast(e.message,true)})}
function pwLogin(){K=$('pw').value;sessionStorage.setItem('k',K);boot()}
function logout(){K='';sessionStorage.removeItem('k');api('POST','/api/logout').catch(function(){}).then(function(){ME=null;location.reload()})}
function toggleSide(){var s=$('sidebar'),o=$('overlay');s.classList.contains('open')?closeSide():(s.classList.add('open'),o.classList.add('show'))}
function closeSide(){$('sidebar').classList.remove('open');$('overlay').classList.remove('show')}
function boot(){api('GET','/api/me').then(function(m){ME=m;$('login').style.display='none';$('app').style.display='block';head();buildNav();if(ME.admin)api('GET','/api/admin/db/settings').then(function(d){var st=d.settings||{};DASH_REFRESH=Number(st.refreshSeconds)||0;if(!TAB&&st.defaultTab&&tabList().some(function(t){return t[0]===st.defaultTab}))TAB=st.defaultTab;startDashRefresh()}).catch(function(){}).finally(function(){go(TAB&&tabList().some(function(t){return t[0]===TAB})?TAB:tabList()[0][0])});else go(TAB&&tabList().some(function(t){return t[0]===TAB})?TAB:tabList()[0][0])}).catch(function(e){if(K){K='';sessionStorage.removeItem('k')}showLogin(e.status===401?'':e.message)})}
function startDashRefresh(){if(window._dashRefreshTimer)clearInterval(window._dashRefreshTimer);if(DASH_REFRESH>0)window._dashRefreshTimer=setInterval(function(){if(TAB==='deploy')vDeploy();else if(TAB==='db')loadDatabase();else if(TAB==='notify')loadNotify()},DASH_REFRESH*1000)}
function head(){var u=ME.user;var av=u&&u.avatar?u.avatar:'data:image/gif;base64,R0lGODlhAQABAAAAACw=';$('av').src=av;$('sav').src=av;$('snm').textContent=u?u.name:'Admin';$('hc').textContent=u&&ME.linked?num(ME.coins)+' xu':'';$('shc').textContent=u?(ME.linked?num(ME.coins)+' xu':'Chưa liên kết'):'Admin'}
function refreshMe(){return api('GET','/api/me').then(function(m){ME=m;head();var b=$('bal');if(b)b.textContent=num(ME.coins)})}
function tabList(){var t=[];if(ME.user){if(ME.linked)t.push(['wallet','💰','Ví xu'],['cloud','📱','Cloud Phone'],['top','🏆','Bảng xếp hạng'],['market','🛍️','Marketplace']);t.push(['settings','⚙️','Cài đặt'],['guide','📖','Hướng dẫn'])}if(ME.admin){t.push(['marketadmin','🛠️','Quản lý Marketplace'],['deploy','🚀','Deploy'],['code','💻','GitHub'],['env','🔑','Biến MT'],['bots','🤖','Bot'],['gen','🎁','Gift Code'],['notify','📣','Thông báo'],['db','🗄️','Database'])}return t}
function buildNav(){
  var list=tabList();
  var user=list.filter(function(t){return ['wallet','cloud','top','market'].indexOf(t[0])>=0});
  var acct=list.filter(function(t){return ['settings','guide'].indexOf(t[0])>=0});
  var admin=list.filter(function(t){return ['marketadmin','deploy','code','env','bots','gen','notify','db'].indexOf(t[0])>=0});
  var h='';
  if(user.length){h+='<div class="nav-label">Cloud Phone</div>';user.forEach(function(t){h+='<button class="nav-item'+(TAB===t[0]?' on':'')+'" data-tab="'+t[0]+'"><span class="nav-ico">'+t[1]+'</span>'+t[2]+'</button>'})}
  if(acct.length){h+=(user.length?'<div class="nav-sep"></div>':'')+'<div class="nav-label">Tài khoản</div>';acct.forEach(function(t){h+='<button class="nav-item'+(TAB===t[0]?' on':'')+'" data-tab="'+t[0]+'"><span class="nav-ico">'+t[1]+'</span>'+t[2]+'</button>'})}
  if(admin.length){h+='<div class="nav-sep"></div><div class="nav-label">Quản trị</div>';admin.forEach(function(t){h+='<button class="nav-item'+(TAB===t[0]?' on':'')+'" data-tab="'+t[0]+'"><span class="nav-ico">'+t[1]+'</span>'+t[2]+'</button>'})}
  $('sideNav').innerHTML=h;
  Array.prototype.forEach.call(document.querySelectorAll('.nav-item[data-tab]'),function(b){b.addEventListener('click',function(){go(b.dataset.tab)})});
}
function go(t){clearInterval(window._lkTimer);TAB=t;buildNav();closeSide();M('<div class="m">Đang tải...</div>');({settings:vSettings,guide:vGuide,wallet:vWallet,cloud:vCloud,top:vTop,market:vMarket,marketadmin:vMarketAdmin,deploy:vDeploy,code:vCode,env:vEnv,bots:vBots,gen:vGen,notify:vNotify,db:vDatabase})[t]()}


function ngExchange(){var amount=Number($('ngExchangeAmount').value||0);api('POST','/api/nigaria/exchange',{amount:amount}).then(function(){toast('Đổi ACOIN thành công');ngLoadMarket()}).catch(function(e){toast(e.message,true)})}
function ngComplaint(id){var reason=prompt('Mô tả khiếu nại (ít nhất 5 ký tự):');if(!reason)return;api('POST','/api/nigaria/market/orders/'+id+'/complaint',{reason:reason}).then(function(){toast('Đã gửi khiếu nại');ngLoadMarket()}).catch(function(e){toast(e.message,true)})}
function vMarketAdmin(){
 M('<div class="card"><h2>🛠️ Quản lý Marketplace</h2><p class="hint">Duyệt seller, xử lý khiếu nại và sao lưu dữ liệu Marketplace lên GitHub Gist riêng tư.</p><button class="btn sm" onclick="vMarketAdmin()">Làm mới</button> <button class="btn sm" onclick="ngBackupGist()">Backup Gist</button></div><div class="card"><h3>Yêu cầu Seller</h3><div id="ngAdminSellers">Đang tải...</div></div><div class="card"><h3>Khiếu nại</h3><div id="ngAdminComplaints">Đang tải...</div></div><div class="card"><h3>Link Providers</h3><div id="ngAdminProviders">Đang tải...</div></div>');
 Promise.all([api('GET','/api/nigaria/admin/sellers'),api('GET','/api/nigaria/admin/complaints'),api('GET','/api/nigaria/providers')]).then(function(a){
  var ss=a[0].sellers||[],cc=a[1].complaints||[],pp=a[2].providers||[];
  $('ngAdminSellers').innerHTML=ss.length?ss.map(function(x){return '<div class="row" style="justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--edge)"><span>'+esc(x.userId)+' • '+esc(x.status)+'</span>'+(x.status==='pending'?'<button class="btn sm" onclick="ngApproveSeller(\\''+esc(x.userId)+'\\')">Duyệt</button>':'')+'</div>'}).join(''):'<p class="hint">Không có yêu cầu.</p>';
  $('ngAdminComplaints').innerHTML=cc.length?cc.map(function(x){return '<div style="padding:10px 0;border-bottom:1px solid var(--edge)"><b>'+esc(x.orderId)+'</b><p class="hint">'+esc(x.reason)+'</p><button class="btn sm" onclick="ngResolveComplaint(\\''+x.id+'\\',\\'refund\\')">Hoàn coin</button> <button class="btn sm" onclick="ngResolveComplaint(\\''+x.id+'\\',\\'release\\')">Trả seller</button></div>'}).join(''):'<p class="hint">Không có khiếu nại.</p>';
  $('ngAdminProviders').innerHTML=pp.map(function(x){return '<div class="row" style="justify-content:space-between;padding:7px 0"><span>'+esc(x.name)+'</span><span class="chip '+(x.ready?'ok':'warn')+'">'+(x.ready?'Đã cấu hình':'Thiếu API key')+'</span></div>'}).join('');
 }).catch(function(e){toast(e.message,true)});
}
function ngApproveSeller(uid){api('POST','/api/nigaria/admin/sellers/'+encodeURIComponent(uid)+'/approve',{}).then(function(){toast('Đã duyệt seller');vMarketAdmin()}).catch(function(e){toast(e.message,true)})}
function ngResolveComplaint(id,decision){if(!confirm('Xác nhận xử lý khiếu nại?'))return;api('POST','/api/nigaria/admin/complaints/'+id+'/resolve',{decision:decision}).then(function(){toast('Đã xử lý');vMarketAdmin()}).catch(function(e){toast(e.message,true)})}
function ngBackupGist(){api('POST','/api/nigaria/admin/backup-gist',{}).then(function(d){toast('Đã tạo Gist backup');if(d.url)window.open(d.url,'_blank')}).catch(function(e){toast(e.message,true)})}
function vMarket(){
 M('<div class="card"><div class="row" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><div><h2>🛍️ Nigaria Marketplace</h2><p class="hint">Chợ cộng đồng • thanh toán bằng coin • tiền seller được giữ đến khi hoàn tất đơn</p></div><button class="btn sm" onclick="vMarket()">Làm mới</button></div><div id="ngMarketSummary" class="grid" style="margin-top:14px"></div></div>'
 +'<div class="card"><h3>Đổi coin sang ACOIN</h3><p class="hint">Tỷ giá hiển thị ở trên. Chỉ đổi số coin chia hết cho tỷ giá.</p><input id="ngExchangeAmount" class="field" type="number" min="5" placeholder="Số coin muốn đổi"><button class="btn sm" onclick="ngExchange()">Đổi ACOIN</button></div>'
 +'<div class="card"><h3>Đăng ký người bán</h3><p class="hint">Yêu cầu sẽ được admin duyệt trước khi bạn đăng sản phẩm.</p><button class="btn" onclick="ngApplySeller()">Gửi yêu cầu seller</button><span id="ngSellerStatus" class="hint" style="margin-left:10px"></span></div>'
 +'<div class="card"><h3>Đăng sản phẩm</h3><div class="grid"><input id="ngProdName" class="field" placeholder="Tên sản phẩm"><input id="ngProdPrice" class="field" type="number" min="1" placeholder="Giá coin"><input id="ngProdStock" class="field" type="number" min="1" placeholder="Tồn kho"><textarea id="ngProdDesc" class="field" placeholder="Mô tả sản phẩm"></textarea></div><button class="btn" onclick="ngCreateProduct()">Đăng bán</button></div>'
 +'<div class="card"><h3>Sản phẩm đang bán</h3><div id="ngProducts" class="grid"><div class="m">Đang tải...</div></div></div>'
 +'<div class="card"><h3>Đơn hàng của tôi</h3><div id="ngOrders"><div class="m">Đang tải...</div></div></div>'
 +'<div class="card"><h3>Chat riêng</h3><p class="hint">Nhắn tin bằng Discord ID người nhận đã liên kết.</p><input id="ngPartner" class="field" placeholder="Discord ID người nhận"><button class="btn sm" onclick="ngLoadChat()">Tải hội thoại</button><div id="ngChat" style="margin:12px 0"></div><textarea id="ngMessage" class="field" placeholder="Tin nhắn (tối đa 1000 ký tự)"></textarea><button class="btn" onclick="ngSendChat()">Gửi tin</button></div>');
 ngLoadMarket();
}
function ngLoadMarket(){
 Promise.all([api('GET','/api/nigaria/summary'),api('GET','/api/nigaria/market/products'),api('GET','/api/nigaria/market/orders')]).then(function(a){
  var s=a[0],ps=a[1].products||[],os=a[2].orders||[];
  $('ngMarketSummary').innerHTML='<div class="stat"><b>'+num(s.coin)+'</b><span>Coin</span></div><div class="stat"><b>'+num(s.acoin)+'</b><span>ACOIN</span></div><div class="stat"><b>'+esc(s.sellerStatus)+'</b><span>Trạng thái seller</span></div><div class="stat"><b>'+num(s.exchangeRate)+'</b><span>Coin / ACOIN</span></div>';
  $('ngSellerStatus').textContent='Trạng thái: '+s.sellerStatus;
  $('ngProducts').innerHTML=ps.length?ps.map(function(p){return '<div class="card"><b>'+esc(p.name)+'</b><p class="hint">'+esc(p.description||'')+'</p><p>Giá: <b>'+num(p.price)+' coin</b> • Còn '+num(p.stock)+'</p><p class="hint">Người bán: '+esc(p.sellerName)+'</p><div class="row"><input class="field" id="ngQty_'+esc(p.id)+'" type="number" min="1" max="'+p.stock+'" value="1" style="max-width:90px"><button class="btn sm" onclick="ngBuy(\\''+esc(p.id)+'\\')">Mua</button></div></div>'}).join(''):'<p class="hint">Chưa có sản phẩm.</p>';
  $('ngOrders').innerHTML=os.length?os.map(function(o){var action='';if(o.buyerId===ME.user.id&&(o.status==='delivered'))action='<button class="btn sm" onclick="ngOrderAction(\\''+o.id+'\\',\\'confirm\\')">Xác nhận nhận hàng</button> <button class="btn sm bad" onclick="ngComplaint(\\''+o.id+'\\')">Khiếu nại</button>';if(o.sellerId===ME.user.id&&o.status==='paid')action='<button class="btn sm" onclick="ngOrderAction(\\''+o.id+'\\',\\'delivered\\')">Đánh dấu đã giao</button>';return '<div class="row" style="justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--edge)"><div><b>'+esc(o.productName)+'</b><div class="hint">#'+esc(o.id.slice(0,8))+' • '+num(o.total)+' coin • '+esc(o.status)+'</div></div>'+action+'</div>'}).join(''):'<p class="hint">Chưa có đơn hàng.</p>';
 }).catch(function(e){$('ngProducts').innerHTML=errBox(e.message)});
}
function ngApplySeller(){api('POST','/api/nigaria/market/seller',{}).then(function(d){toast('Yêu cầu seller: '+d.status);ngLoadMarket()}).catch(function(e){toast(e.message,true)})}
function ngCreateProduct(){var b={name:$('ngProdName').value,price:Number($('ngProdPrice').value),stock:Number($('ngProdStock').value),description:$('ngProdDesc').value};api('POST','/api/nigaria/market/products',b).then(function(){toast('Đã đăng sản phẩm');vMarket()}).catch(function(e){toast(e.message,true)})}
function ngBuy(pid){var q=Number($('ngQty_'+pid).value||1);if(!confirm('Xác nhận mua sản phẩm bằng coin?'))return;api('POST','/api/nigaria/market/buy',{productId:pid,quantity:q}).then(function(){toast('Đặt hàng thành công');ngLoadMarket()}).catch(function(e){toast(e.message,true)})}
function ngOrderAction(id,action){api('POST','/api/nigaria/market/orders/'+id+'/'+action,{}).then(function(){toast('Đã cập nhật đơn');ngLoadMarket()}).catch(function(e){toast(e.message,true)})}
function ngLoadChat(){var p=$('ngPartner').value.trim();api('GET','/api/nigaria/chat/'+encodeURIComponent(p)).then(function(d){$('ngChat').innerHTML=(d.messages||[]).map(function(m){return '<div class="hint" style="padding:7px;border-bottom:1px solid var(--edge)"><b>'+esc(m.from)+'</b>: '+esc(m.message)+' <small>'+ago(m.createdAt)+'</small></div>'}).join('')||'<p class="hint">Chưa có tin nhắn.</p>'}).catch(function(e){toast(e.message,true)})}
function ngSendChat(){var p=$('ngPartner').value.trim(),m=$('ngMessage').value;api('POST','/api/nigaria/chat/'+encodeURIComponent(p),{message:m}).then(function(){$('ngMessage').value='';ngLoadChat();toast('Đã gửi tin nhắn')}).catch(function(e){toast(e.message,true)})}

function M(h){$('main').innerHTML=h}
function errBox(m){return '<div class="err">'+esc(m)+'</div>'}


/* ---- Cài đặt: lấy token liên kết ---- */
function vSettings(){
 M('<div class="card"><h3>Liên kết Discord</h3><div id="lk"><div class="m">Đang tải...</div></div></div>'
 +'<div class="card"><h3>Tài khoản web</h3><p class="hint">Đăng xuất chỉ thoát trình duyệt này. Xu và dữ liệu nằm theo tài khoản Discord nên không bị mất.</p><button class="btn bad sm" onclick="logout()">Đăng xuất</button></div>');
 loadLink()}
function loadLink(){api('GET','/api/link').then(function(d){var e=$('lk');if(!e)return;
  if(d.linked){
   e.innerHTML='<div class="top"><div class="who" style="display:flex;gap:12px;align-items:center;min-width:0"><img src="'+esc(d.discord.avatar||'data:image/gif;base64,R0lGODlhAQABAAAAACw=')+'" alt="" style="width:46px;height:46px;border-radius:50%;border:2px solid rgba(255,255,255,.7)"><div style="min-width:0"><div class="t">'+esc(d.discord.name)+'</div><div class="m">Đã liên kết với Discord</div></div></div><span class="chip ok">ĐÃ LIÊN KẾT</span></div>'
   +'<p class="hint">Xu, điểm danh và đơn cloud trên web dùng chung với bot Discord.</p>'
   +(d.via==='token'?'<div class="acts"><button class="btn bad sm" data-a="lunlink">Hủy liên kết</button></div>':'<p class="hint">Bạn đang đăng nhập bằng Discord.</p>');
   return}
  e.innerHTML='<p class="hint">Chưa liên kết. Làm 3 bước sau để dùng ví xu và cloud phone:</p>'
   +'<ol class="steps"><li>Mở <b>Discord</b>, vào server của bot.</li><li>Gõ lệnh <b>/ketnoi</b>, ô <b>token</b> dán mã bên dưới rồi gửi.</li><li>Quay lại đây, trang tự cập nhật khi liên kết xong.</li></ol>'
   +'<div class="kv tok" id="tokv">'+esc(d.token)+'</div>'
   +'<div class="m" style="margin:2px 0 10px">Token dùng 1 lần, còn hiệu lực khoảng '+Math.max(1,Math.round(d.expiresIn/3600))+' giờ.</div>'
   +'<div class="acts"><button class="btn sm ok" data-a="lcopy" data-t="'+esc(d.token)+'">Sao chép token</button><button class="btn sm" data-a="lregen">Tạo token mới</button></div>'
   +'<p class="hint">Chỉ dùng token do chính bạn tạo. Không gửi token cho ai và không nhập token người khác đưa.</p>';
  clearInterval(window._lkTimer);
  window._lkTimer=setInterval(function(){if(TAB!=='settings')return clearInterval(window._lkTimer);api('GET','/api/me').then(function(m){if(m.linked){clearInterval(window._lkTimer);ME=m;head();toast('Liên kết thành công!');TAB='';buildNav();go(tabList()[0][0])}}).catch(function(){})},4000);
 }).catch(function(e){var x=$('lk');if(x)x.innerHTML=errBox(e.message)})}

/* ---- Hướng dẫn ---- */
function vGuide(){
 function box(t,b){return '<div class="card"><h3>'+t+'</h3>'+b+'</div>'}
 M(box('1. Liên kết tài khoản','<ol class="steps"><li>Vào <b>Cài đặt</b> trên web, bấm sao chép token.</li><li>Trong Discord gõ <b>/ketnoi</b> và dán token.</li><li>Bot báo thành công là xong. Web hiện đủ Ví xu và Cloud Phone.</li></ol><p class="hint">Mỗi token chỉ dùng được 1 lần. Hết hạn thì vào Cài đặt bấm <b>Tạo token mới</b>.</p>')
 +box('2. Kiếm xu','<ol class="steps"><li><b>/daily</b> hoặc nút Điểm danh trên web: +20 xu mỗi ngày.</li><li><b>/getlink</b> trong kênh nhiệm vụ: làm link nhận 50 xu, 2 lần mỗi ngày.</li><li><b>/youtube</b>: đăng ký kênh nhận xu mỗi ngày.</li><li><b>/code</b> hoặc ô Gift Code trên web: nhập mã quà.</li></ol>')
 +box('3. Lấy tài khoản (reg)','<ol class="steps"><li>Vào <b>Cloud Phone</b>, chọn VMOS Cloud hoặc VSPhone.</li><li>Mỗi lần lấy tốn <b>10 xu</b>, lỗi sẽ tự hoàn xu.</li><li>Bấm <b>Điền vào form mua</b> để chuyển sang bước mua.</li></ol>')
 +box('4. Mua cloud','<ol class="steps"><li>Chọn loại cloud, nhập <b>email|matkhau</b> của tài khoản đã lấy.</li><li>Bấm <b>Mua ngay</b>, chờ bot xử lý. Kết quả xem ở mục Đơn gần đây.</li></ol>')
 +box('5. Chuyển xu','<p class="hint">Ví xu có ô chuyển xu bằng ID Discord, phí 5%. Lấy ID: bật Chế độ nhà phát triển trong Discord, bấm giữ tên người đó rồi chọn Sao chép ID.</p>')
 +box('Hỏi nhanh','<ol class="steps"><li><b>Token báo sai:</b> kiểm tra lại, chú ý chữ O và số 0. Token đã dùng hoặc hết hạn thì tạo mới.</li><li><b>Mất đăng nhập web:</b> bấm Bắt đầu để tạo tài khoản web mới rồi /ketnoi lại. Xu không mất vì gắn với Discord.</li><li><b>Nghi ngờ lộ token:</b> bấm Hủy liên kết ở Cài đặt, hoặc gõ <b>/ngatketnoi</b> trong Discord.</li></ol>'))}

/* ---- Ví ---- */
function vWallet(){var c=ME.cfg;
 M('<div class="card"><h3>Số dư</h3><div class="big"><span id="bal">'+num(ME.coins)+'</span> xu</div><p class="hint">Xu dùng chung với bot Discord, kiếm xu bằng nhiệm vụ ở Discord.</p>'
 +'<button class="btn ok" data-a="daily"'+(ME.dailyDone?' disabled':'')+'>'+(ME.dailyDone?'Hôm nay đã điểm danh':'Điểm danh +20 xu')+'</button></div>'
 +'<div class="grid"><div class="card"><h3>Nhập Gift Code</h3><div class="row"><input id="gc" placeholder="Mã Gift Code" maxlength="32"><button class="btn" data-a="code">Nhập</button></div></div>'
 +'<div class="card"><h3>Chuyển xu (phí 5%)</h3><input id="tt" inputmode="numeric" placeholder="ID Discord người nhận" style="margin-bottom:8px"><div class="row"><input id="ta" inputmode="numeric" placeholder="Số xu (tối thiểu 10)"><button class="btn" data-a="transfer">Chuyển</button></div>'
 +'<p class="hint">ID Discord: bật Chế độ nhà phát triển, bấm giữ tên người đó rồi chọn Sao chép ID.</p></div></div>')}

/* ---- Cloud ---- */
function vCloud(){var c=ME.cfg;
 M('<div class="card"><h3>Lấy tài khoản (reg) · '+c.regCost+' xu/lần</h3><div class="acts">'
 +c.providers.map(function(p){return '<button class="btn'+(p.ready?'':' ghost')+'" data-a="reg" data-p="'+p.key+'"'+(p.ready?'':' disabled')+'>'+esc(p.name)+(p.ready?'':' · Sắp có')+'</button>'}).join('')
 +'</div><div id="regout"></div></div>'
 +'<div class="card"><h3>Mua cloud'+(c.buyCost?' · '+c.buyCost+' xu':'')+'</h3><select id="bc" style="margin-bottom:8px"><option value="VM">VMOS Cloud</option><option value="VS">VSPhone</option></select>'
 +'<input id="bi" placeholder="email|matkhau" autocomplete="off" style="margin-bottom:8px"><button class="btn ok" data-a="buy">Mua ngay</button></div>'
 +'<div class="card"><h3>Đơn gần đây</h3><div id="ord"><div class="m">Đang tải...</div></div></div>');
 if(LAST)showReg();loadOrders()}
function showReg(){var r=LAST;$('regout').innerHTML='<div class="kv">Tài khoản: '+esc(r.mail)+'</div><div class="kv">Mật khẩu: '+esc(r.pass)+'</div>'+(r.code?'<div class="kv">Mã mời: '+esc(r.code)+'</div>':'')
 +'<div class="acts"><button class="btn sm" data-a="copy">Sao chép email|mk</button><button class="btn sm ok" data-a="fill">Điền vào form mua</button></div>'}
function loadOrders(){api('GET','/api/orders').then(function(d){var e=$('ord');if(!e)return;e.innerHTML=d.list.length?d.list.map(function(o){return '<div class="li"><div class="top"><div class="t">'+esc(o.cloudId==='VS'?'VSPhone':'VMOS')+' · '+esc(o.account)+'</div><span class="chip '+(o.ok?'ok':'bad')+'">'+(o.ok?'OK':'LỖI')+'</span></div><div class="m">'+esc(o.message)+' · '+ago(o.at)+'</div></div>'}).join(''):'<div class="m">Chưa có đơn nào</div>'}).catch(function(e){var x=$('ord');if(x)x.innerHTML=errBox(e.message)})}

/* ---- BXH ---- */
function vTop(){M('<div class="acts" style="margin:0 0 12px"><button class="btn sm'+(TOPS==='all'?'':' ghost')+'" data-a="tops" data-s="all">Tổng</button><button class="btn sm'+(TOPS==='week'?'':' ghost')+'" data-a="tops" data-s="week">Tuần này</button></div><div class="card" id="tl"><div class="m">Đang tải...</div></div>');
 api('GET','/api/top?scope='+TOPS).then(function(d){$('tl').innerHTML=d.list.length?d.list.map(function(x){return '<div class="li"><div class="top"><div class="t">#'+x.rank+' '+esc(x.name)+'</div><b class="coin">'+num(x.score)+' xu</b></div></div>'}).join(''):'<div class="m">Chưa có ai</div>'}).catch(function(e){$('tl').innerHTML=errBox(e.message)})}

/* ---- Deploy ---- */
var CH={live:['ok','LIVE'],success:['ok','LIVE'],deployed:['ok','LIVE'],active:['ok','LIVE'],completed:['ok','XONG'],build_in_progress:['warn','BUILD'],update_in_progress:['warn','DEPLOY'],created:['warn','CHỜ'],building:['warn','BUILD'],deploying:['warn','DEPLOY'],initializing:['warn','KHỞI TẠO'],queued:['warn','HÀNG CHỜ'],in_progress:['warn','CHẠY'],waiting:['warn','CHỜ'],build_failed:['bad','LỖI'],update_failed:['bad','LỖI'],failed:['bad','LỖI'],crashed:['bad','CRASH'],failure:['bad','LỖI'],timed_out:['bad','TIMEOUT'],canceled:['off','HỦY'],cancelled:['off','HỦY'],removed:['off','GỠ'],skipped:['off','BỎ QUA'],suspended:['off','TẠM DỪNG'],deactivated:['off','CŨ'],sleeping:['off','NGỦ']};
function chip(s){var k=String(s||'').toLowerCase();var c=CH[k]||['off',(s||'?').toString().toUpperCase()];return '<span class="chip '+c[0]+'">'+esc(c[1])+'</span>'}
function ovRender(r){if(!r.ok)return errBox(r.error);if(!r.data.length)return '<div class="m">Không có service</div>';
 return r.data.map(function(s){return '<div class="card"><div class="top"><div style="min-width:0"><div class="t">'+esc(s.name)+'</div><div class="m">'+esc(s.project||s.type||'')+(s.environment?' · '+esc(s.environment):'')+(s.branch?' · '+esc(s.branch):'')+'</div></div>'+chip(s.status)+'</div>'
  +(s.commit?'<div class="m">'+esc(s.commit)+'</div>':'')+'<div class="m">'+ago(s.at)+(s.url?' · '+link(s.url,s.url.replace('https://','')):'')+'</div>'
  +'<div class="acts">'+(s.projectId?'<button class="btn sm" data-a="rwdeploy" data-id="'+esc(s.id)+'" data-e="'+esc(s.environmentId)+'" data-n="'+esc(s.name)+'">Redeploy</button>':'<button class="btn sm" data-a="rdeploy" data-id="'+esc(s.id)+'" data-n="'+esc(s.name)+'">Deploy</button>')+'<button class="btn sm ghost" data-a="infraDetail" data-provider="'+(s.projectId?'railway':'render')+'" data-id="'+esc(s.id)+'" data-p="'+esc(s.projectId||'')+'" data-e="'+esc(s.environmentId||'')+'">Lịch sử / Logs</button>'+(s.projectId?'':'<button class="btn sm ghost" data-a="rrestart" data-id="'+esc(s.id)+'">Restart</button>')
  +'<a class="ghost" style="padding:7px 10px;font-size:12px" href="'+esc(s.dash)+'" target="_blank" rel="noopener">Log</a></div></div>'}).join('')}
function ghRender(r){if(!r.ok)return errBox(r.error);var g=r.data;
 return '<div class="card"><div class="t">'+link(g.url,g.repo)+(g.private?' 🔒':'')+'</div><div class="m">Nhánh '+esc(g.branch)+' · Issue/PR mở '+g.issues+' · Push '+ago(g.pushedAt)+'</div></div>'
 +'<div class="card"><h3>Commit mới</h3>'+g.commits.map(function(c){return '<div class="li"><div class="t">'+link(c.url,c.msg)+'</div><div class="m">'+esc(c.sha)+' · '+esc(c.author)+' · '+ago(c.at)+'</div></div>'}).join('')+'</div>'
 +'<div class="card"><h3>Actions</h3>'+(g.runs.length?g.runs.map(function(x){return '<div class="li"><div class="top"><div class="t" style="min-width:0">'+link(x.url,x.name)+'</div>'+chip(x.status)+'</div><div class="m">'+esc(x.branch)+' · '+ago(x.at)+'</div>'+(x.status==='failure'?'<div class="acts"><button class="btn sm" data-a="rerun" data-id="'+x.id+'">Chạy lại</button></div>':'')+'</div>'}).join(''):'<div class="m">Chưa có workflow</div>')+'</div>'
 +'<div class="card"><h3>Pull request mở</h3>'+(g.pulls.length?g.pulls.map(function(p){return '<div class="li"><div class="t">'+link(p.url,'#'+p.n+' '+p.title)+'</div><div class="m">'+esc(p.user)+' · '+ago(p.at)+'</div></div>'}).join(''):'<div class="m">Không có</div>')+'</div>'}
function vDeploy(){M('<div class="m">Đang tải...</div>');api('GET','/api/admin/overview').then(function(d){OV=d;
 M('<div class="grid"><div><h3 class="hint">RENDER</h3>'+ovRender(d.render)+'</div><div><h3 class="hint">RAILWAY</h3>'+ovRender(d.railway)+'</div><div><h3 class="hint">GITHUB</h3>'+ghRender(d.github)+'</div></div>')}).catch(function(e){M(errBox(e.message))})}

/* ---- Database / Redis ---- */
function vDatabase(){M('<div class="card"><h3>Redis · Database dashboard</h3><div id="dbs" class="m">Đang kiểm tra...</div><div class="acts"><button class="btn sm" data-a="dbrefresh">Làm mới</button><button class="btn sm ok" data-a="dbsnapshot">Lưu snapshot hạ tầng</button></div></div><div class="card"><h3>Lịch sử thao tác admin</h3><div id="dbaudit" class="m">Đang tải...</div></div><div class="card"><h3>Snapshot hạ tầng</h3><div id="dbsnapshots" class="m">Đang tải...</div></div><div class="card"><h3>Cài đặt dashboard</h3><label class="hint">Tự làm mới (giây, 0 = tắt)</label><input id="dbrefreshsec" type="number" min="0" max="300" value="0"><label class="hint">Tab mặc định</label><select id="dbdefault"><option value="deploy">Deploy</option><option value="code">GitHub</option><option value="env">Biến môi trường</option><option value="bots">Bot</option><option value="gen">Gift Code</option><option value="notify">Thông báo</option><option value="db">Database</option></select><div class="acts"><button class="btn" data-a="dbsettings">Lưu cài đặt</button></div></div>');loadDatabase()}
function loadDatabase(){api('GET','/api/admin/db/summary').then(function(d){$('dbs').innerHTML='<div class="kv">Redis: '+esc(d.stats.status)+' · Keys: '+esc(d.stats.keys)+' · RAM: '+esc(d.stats.usedMemory||'n/a')+' · Peak: '+esc(d.stats.peakMemory||'n/a')+'</div><div class="m">Audit: '+d.auditCount+' · Snapshots: '+d.snapshotCount+' · Snapshot cuối: '+(d.lastSnapshot?ago(d.lastSnapshot.at):'chưa có')+'</div>'}).catch(function(e){$('dbs').innerHTML=errBox(e.message)});
 api('GET','/api/admin/db/audit?limit=30').then(function(d){$('dbaudit').innerHTML=d.list.length?d.list.map(function(x){return '<div class="li"><div class="top"><b>'+esc(x.action)+'</b><span class="m">'+ago(x.at)+'</span></div><div class="m">'+esc(JSON.stringify(x.detail||{}))+'</div></div>'}).join(''):'Chưa có thao tác' }).catch(function(e){$('dbaudit').innerHTML=errBox(e.message)});
 api('GET','/api/admin/db/snapshots?limit=10').then(function(d){$('dbsnapshots').innerHTML=d.list.length?d.list.map(function(x){return '<div class="li"><b>'+new Date(x.at).toLocaleString()+'</b><div class="m">Render: '+(x.snapshot.render.ok?'OK':'Lỗi')+' · Railway: '+(x.snapshot.railway.ok?'OK':'Lỗi')+' · GitHub: '+(x.snapshot.github.ok?'OK':'Lỗi')+'</div></div>'}).join(''):'Chưa có snapshot'}).catch(function(e){$('dbsnapshots').innerHTML=errBox(e.message)});
 api('GET','/api/admin/db/settings').then(function(d){var s=d.settings||{};$('dbrefreshsec').value=s.refreshSeconds||0;$('dbdefault').value=s.defaultTab||'deploy'}).catch(function(){});
}
/* ---- Thông báo Discord ---- */
function vNotify(){M('<div class="card"><h3>Gửi thông báo Discord</h3><p class="hint">Chọn kênh mà bot chính có quyền xem và gửi tin nhắn.</p><select id="nch"><option value="">Đang tải kênh...</option></select><div class="row" style="margin-top:8px"><input id="ndname" placeholder="Tên địa chỉ lưu"><input id="ndid" placeholder="Channel ID Discord"></div><div class="acts"><button class="btn sm" data-a="ndsave">Lưu địa chỉ</button><button class="btn sm ghost" data-a="nrefresh">Tải lại kênh</button></div><textarea id="nmsg" style="min-height:130px;white-space:pre-wrap" placeholder="Nội dung thông báo (tối đa 2000 ký tự)"></textarea><div class="acts"><button class="btn ok" data-a="nsend">Gửi thông báo</button><button class="btn sm" data-a="nquick" data-type="vmos">Stock VMOS</button><button class="btn sm" data-a="nquick" data-type="vsphone">Stock VSPhone</button><button class="btn sm bad" data-a="nquick" data-type="empty-vmos">Hết máy VMOS</button><button class="btn sm bad" data-a="nquick" data-type="empty-vsphone">Hết máy VSPhone</button></div></div><div class="card"><h3>Địa chỉ đã lưu</h3><div id="ndlist" class="m">Đang tải...</div></div><div class="card"><h3>Lịch sử gửi</h3><div id="nhistory" class="m">Đang tải...</div></div>');loadNotify()}
function loadNotify(){api('GET','/api/admin/notify/channels').then(function(d){var opts=d.channels.map(function(c){return '<option value="'+esc(c.id)+'">'+esc(c.guild)+' · '+esc(c.name)+'</option>'});d.destinations.forEach(function(x){opts.push('<option value="'+esc(x.channelId)+'">★ '+esc(x.name)+'</option>')});$('nch').innerHTML='<option value="">Chọn kênh...</option>'+opts.join('');$('ndlist').innerHTML=d.destinations.length?d.destinations.map(function(x){return '<div class="li"><div class="top"><b>'+esc(x.name)+'</b><button class="btn sm bad" data-a="nddel" data-id="'+esc(x.id)+'">Xóa</button></div><div class="m">'+esc(x.channelId)+'</div></div>'}).join(''):'Chưa lưu địa chỉ'}).catch(function(e){$('nch').innerHTML='<option value="">Không tải được kênh</option>';$('ndlist').innerHTML=errBox(e.message)});api('GET','/api/admin/notify/history').then(function(d){$('nhistory').innerHTML=d.list.length?d.list.map(function(x){return '<div class="li"><div class="m">'+new Date(x.at).toLocaleString()+' · '+esc(x.channelId)+'</div><div style="white-space:pre-wrap;overflow-wrap:anywhere">'+esc(x.message)+'</div></div>'}).join(''):'Chưa gửi thông báo nào'}).catch(function(e){$('nhistory').innerHTML=errBox(e.message)})}
function infraDetail(provider,id,project,environment){
 var q=provider==='render'?'provider=render&serviceId='+encodeURIComponent(id):'provider=railway&projectId='+encodeURIComponent(project)+'&environmentId='+encodeURIComponent(environment)+'&serviceId='+encodeURIComponent(id);
 M('<div class="card" data-service="'+(provider==='render'?esc(id):'')+'"><div class="top"><h3>'+provider.toUpperCase()+' · Lịch sử deploy</h3><button class="btn sm ghost" data-a="backdeploy">Quay lại</button></div><div id="ihistory" class="m">Đang tải...</div></div><div class="card"><h3>Logs gần đây</h3><div id="ilogs" class="m">Đang tải...</div></div>');
 api('GET','/api/admin/infra/history?'+q).then(function(d){
  var rows=d.list||[];
  $('ihistory').innerHTML=rows.length?rows.map(function(x){var can=x.canRollback;return '<div class="li"><div class="top"><b>'+esc(x.status||'?')+'</b><span class="m">'+ago(x.createdAt||x.at)+'</span></div><div class="m">'+esc(x.id)+'</div>'+(provider==='railway'&&can?'<button class="btn sm bad" data-a="railrollback" data-id="'+esc(x.id)+'">Rollback về bản này</button>':'')+(provider==='render'&&x.commitId?'<button class="btn sm bad" data-a="renderrollback" data-commit="'+esc(x.commitId)+'">Deploy lại commit này</button>':'')+'</div>'}).join(''):'Không có lịch sử';
  var logq=provider==='render'?'provider=render&serviceId='+encodeURIComponent(id)+'&limit=50':(rows.length?'provider=railway&deploymentId='+encodeURIComponent(rows[0].id)+'&limit=50':'');
  if(!logq){$('ilogs').textContent='Chưa có deployment để lấy log';return;}
  api('GET','/api/admin/infra/logs?'+logq).then(function(ld){var logs=Array.isArray(ld.logs)?ld.logs:[];$('ilogs').innerHTML=logs.length?logs.map(function(x){return '<div class="li"><div class="m">'+esc(x.timestamp||x.time||'')+' · '+esc(x.level||x.severity||'')+'</div><div style="font:12px ui-monospace;white-space:pre-wrap;overflow-wrap:anywhere">'+esc(x.message||x.text||JSON.stringify(x))+'</div></div>'}).join(''):'Không có log trong khoảng thời gian truy vấn'}).catch(function(e){$('ilogs').innerHTML=errBox(e.message)});
 }).catch(function(e){$('ihistory').innerHTML=errBox(e.message);$('ilogs').textContent='Không tải được lịch sử deployment'});
}

/* ---- Sửa code ---- */
function vCode(){FILE=null;M('<div class="card"><h3>Quản lý file GitHub</h3><p class="hint">Mở file để sửa hoặc tạo file mới. Commit được gửi trực tiếp lên repository.</p><div class="row"><select id="cf"><option>Đang tải...</option></select><button class="btn" data-a="cload">Mở</button></div><div class="acts"><button class="btn sm" data-a="cnew">+ Tạo file mới</button></div></div><div id="ced"></div>');
 api('GET','/api/admin/gh/tree').then(function(d){$('cf').innerHTML=d.files.map(function(f){return '<option value="'+esc(f.path)+'">'+esc(f.path)+' ('+Math.ceil(f.size/1024)+' KB)</option>'}).join('')||'<option value="">Trống</option>'}).catch(function(e){$('cf').innerHTML='<option value="">Lỗi</option>';$('ced').innerHTML=errBox(e.message)})}
function showEditor(){$('ced').innerHTML='<div class="card"><h3>'+esc(FILE.path)+'</h3><textarea id="ct" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea><input id="cm" placeholder="Nội dung commit (tuỳ chọn)" style="margin:10px 0"><div class="acts"><button class="btn ok" data-a="csave">Commit lên GitHub</button>'+(FILE.sha?'<button class="btn bad" data-a="cdelete">Xóa file</button>':'')+'<button class="btn ghost" data-a="cload">Tải lại</button></div></div>';$('ct').value=FILE.content}

/* ---- Biến môi trường ---- */
function vEnv(){M('<div class="m">Đang tải danh sách service...</div>');(OV?Promise.resolve(OV):api('GET','/api/admin/overview').then(function(d){OV=d;return d})).then(function(d){
 var o='';if(d.render.ok)d.render.data.forEach(function(s){o+='<option value="r|'+esc(s.id)+'">Render · '+esc(s.name)+'</option>'});
 if(d.railway.ok)d.railway.data.forEach(function(s){o+='<option value="w|'+esc(s.projectId)+'|'+esc(s.environmentId)+'|'+esc(s.id)+'">Railway · '+esc(s.project)+' / '+esc(s.name)+'</option>'});
 M('<div class="card"><h3>Biến môi trường</h3><div class="row"><select id="es">'+o+'</select><button class="btn" data-a="eload">Tải</button></div></div><div id="ev"></div>')}).catch(function(e){M(errBox(e.message))})}
function envUrl(){var v=$('es').value.split('|');return v[0]==='r'?{u:'/api/admin/env/render/'+v[1],b:{}}:{u:'/api/admin/env/railway',b:{p:v[1],e:v[2],s:v[3]},rw:1}}
function envRow(k,v){return '<div class="evar" data-k="'+esc(k)+'"><div class="t">'+esc(k)+'</div><input class="ev" type="password" value="'+esc(v)+'" autocomplete="off"><div class="acts"><button class="btn sm" data-a="eshow">Hiện</button><button class="btn sm ok" data-a="esave">Lưu</button><button class="btn sm bad" data-a="edel">Xóa</button></div></div>'}
function loadEnv(){var t=envUrl();var url=t.rw?t.u+'?p='+t.b.p+'&e='+t.b.e+'&s='+t.b.s:t.u;
 $('ev').innerHTML='<div class="m">Đang tải...</div>';api('GET',url).then(function(d){d.vars.sort(function(a,b){return a.key<b.key?-1:1});
 $('ev').innerHTML='<div class="card"><h3>'+d.vars.length+' biến</h3>'+d.vars.map(function(x){return envRow(x.key,x.value)}).join('')+'<div class="evar"><h3 style="margin:0">Thêm biến</h3><input id="nk" placeholder="TEN_BIEN" autocapitalize="characters"><input id="nv" placeholder="Giá trị"><div class="acts"><button class="btn sm ok" data-a="eadd">Thêm</button></div></div><p class="hint">Sau khi lưu, qua tab Deploy bấm Deploy/Redeploy để biến mới có hiệu lực.</p></div>'}).catch(function(e){$('ev').innerHTML=errBox(e.message)})}
function envSend(m,key,val){var t=envUrl();var body=t.rw?{p:t.b.p,e:t.b.e,s:t.b.s,key:key,value:val}:{key:key,value:val};return api(m,t.u,body)}

/* ---- Bot ---- */
function vBots(){M('<div class="card" id="bl"><div class="m">Đang tải...</div></div><div class="card"><h3>Thêm bot</h3><input id="bt" type="password" placeholder="Token bot Discord" autocomplete="off" style="margin-bottom:8px"><button class="btn" data-a="badd">Thêm và chạy</button></div>');loadBots()}
function loadBots(){api('GET','/api/admin/bots').then(function(d){$('bl').innerHTML='<h3>Bot ('+d.bots.length+')</h3>'+d.bots.map(function(b){return '<div class="li"><div class="top"><div style="min-width:0"><div class="t">'+esc(b.name)+'</div><div class="m">'+(b.online?'Đang chạy':'Đã tắt')+' · token '+esc(b.tail)+'</div></div><span class="chip '+(b.online?'ok':'off')+'">'+(b.online?'ON':'OFF')+'</span></div><div class="acts"><button class="btn sm" data-a="btog" data-id="'+esc(b.id)+'">'+(b.enabled?'Tắt':'Bật')+'</button>'+(b.id!=='main'?'<button class="btn sm bad" data-a="bdel" data-id="'+esc(b.id)+'">Xóa</button>':'')+'</div></div>'}).join('')}).catch(function(e){$('bl').innerHTML=errBox(e.message)})}

/* ---- Gift code ---- */
function vGen(){M('<div class="card"><h3>Tạo Gift Code</h3><div class="row"><input id="gn" inputmode="numeric" placeholder="Số lượng (1–100)"><input id="gx" inputmode="numeric" placeholder="Xu mỗi code"></div><div class="acts"><button class="btn" data-a="gen">Tạo</button></div><textarea id="go" readonly style="min-height:160px;margin-top:10px;display:none"></textarea></div>')}

/* ---- Sự kiện ---- */
document.addEventListener('click',function(ev){
 var b=ev.target.closest('[data-a]');if(!b)return;var a=b.dataset.a,p;
 function done(msg,after){return function(r){toast(msg||(r&&r.message)||'Xong');if(after)after(r)}}
 function bad(e){toast(e.message,true)}
 if(a==='daily'){busy(b,api('POST','/api/daily')).then(function(r){toast(r.message);refreshMe().then(vWallet)}).catch(bad)}
 else if(a==='code'){var c=$('gc').value;busy(b,api('POST','/api/code',{code:c})).then(function(r){toast(r.message);refreshMe();$('gc').value=''}).catch(bad)}
 else if(a==='transfer'){busy(b,api('POST','/api/transfer',{target:$('tt').value,amount:$('ta').value})).then(function(r){toast(r.message);refreshMe();$('ta').value=''}).catch(bad)}
 else if(a==='reg'){busy(b,api('POST','/api/reg',{provider:b.dataset.p})).then(function(r){LAST=r;ME.coins=r.coins;head();var x=$('bal');showReg();toast('Lấy tài khoản thành công')}).catch(bad)}
 else if(a==='copy'){var txt=LAST.mail+'|'+LAST.pass;(navigator.clipboard?navigator.clipboard.writeText(txt):Promise.reject()).then(function(){toast('Đã sao chép')}).catch(function(){toast('Không sao chép được, hãy tự chọn và copy',true)})}
 else if(a==='fill'){$('bc').value=LAST.cloud||'VM';$('bi').value=LAST.mail+'|'+LAST.pass;$('bi').scrollIntoView({behavior:'smooth',block:'center'})}
 else if(a==='buy'){busy(b,api('POST','/api/buy',{cloud:$('bc').value,info:$('bi').value})).then(function(r){toast(r.message);refreshMe();loadOrders()}).catch(function(e){bad(e);loadOrders();refreshMe()})}
 else if(a==='tops'){TOPS=b.dataset.s;vTop()}
 else if(a==='rdeploy'){if(!confirm('Deploy '+b.dataset.n+'?'))return;busy(b,api('POST','/api/admin/render/'+b.dataset.id+'/deploy')).then(done('Đã gửi deploy Render',function(){setTimeout(vDeploy,2500)})).catch(bad)}
 else if(a==='rwdeploy'){if(!confirm('Redeploy '+b.dataset.n+'?'))return;busy(b,api('POST','/api/admin/railway/redeploy',{serviceId:b.dataset.id,environmentId:b.dataset.e})).then(done('Đã gửi redeploy Railway',function(){setTimeout(vDeploy,2500)})).catch(bad)}
 else if(a==='rerun'){busy(b,api('POST','/api/admin/github/rerun/'+b.dataset.id)).then(done('Đã chạy lại workflow')).catch(bad)}
 else if(a==='cload'){var path=$('cf')&&$('cf').value;if(!path)return;busy(b,api('GET','/api/admin/gh/file?path='+encodeURIComponent(path))).then(function(r){FILE=r;showEditor()}).catch(bad)}
 else if(a==='cnew'){var path=prompt('Đường dẫn file mới, ví dụ src/new.js');if(!path)return;if(!/^[\w.\-\/]{1,120}$/.test(path)||path.indexOf('..')>=0||/(^|\/)\.env/i.test(path)||path[0]==='/')return toast('Đường dẫn không hợp lệ',true);FILE={path:path,sha:null,content:''};showEditor()}
 else if(a==='csave'){if(!FILE)return;if(!confirm((FILE.sha?'Commit sửa ':'Tạo file ')+FILE.path+' lên GitHub?'))return;busy(b,api('PUT','/api/admin/gh/file',{path:FILE.path,content:$('ct').value,sha:FILE.sha,message:$('cm').value})).then(function(r){FILE.sha=r.sha;FILE.content=$('ct').value;toast('Đã commit '+r.commit);}).catch(bad)}
 else if(a==='cdelete'){if(!FILE||!FILE.sha||!confirm('Xóa vĩnh viễn '+FILE.path+' khỏi GitHub?'))return;busy(b,api('DELETE','/api/admin/gh/file',{path:FILE.path,sha:FILE.sha,message:$('cm').value})).then(done('Đã xóa file khỏi GitHub',function(){FILE=null;$('ced').innerHTML='';vCode()})).catch(bad)}
 else if(a==='eload'){loadEnv()}
 else if(a==='eshow'){var i=b.closest('.evar').querySelector('.ev');i.type=i.type==='password'?'text':'password';b.textContent=i.type==='password'?'Hiện':'Ẩn'}
 else if(a==='esave'){var r2=b.closest('.evar');busy(b,envSend('PUT',r2.dataset.k,r2.querySelector('.ev').value)).then(done('Đã lưu '+r2.dataset.k)).catch(bad)}
 else if(a==='edel'){var r3=b.closest('.evar');if(!confirm('Xóa biến '+r3.dataset.k+'?'))return;busy(b,envSend('DELETE',r3.dataset.k)).then(done('Đã xóa',loadEnv)).catch(bad)}
 else if(a==='eadd'){var k=$('nk').value.trim();if(!k)return toast('Nhập tên biến',true);busy(b,envSend('PUT',k,$('nv').value)).then(done('Đã thêm '+k,loadEnv)).catch(bad)}
 else if(a==='btog'){busy(b,api('POST','/api/admin/bots/'+b.dataset.id+'/toggle')).then(done('Đã đổi trạng thái bot',loadBots)).catch(bad)}
 else if(a==='bdel'){if(!confirm('Xóa bot này?'))return;busy(b,api('DELETE','/api/admin/bots/'+b.dataset.id)).then(done('Đã xóa bot',loadBots)).catch(bad)}
 else if(a==='badd'){var tk=$('bt').value.trim();if(!tk)return toast('Dán token bot trước',true);busy(b,api('POST','/api/admin/bots',{token:tk})).then(done('Đã thêm bot và đang chạy',function(){$('bt').value='';loadBots()})).catch(bad)}
 else if(a==='gen'){busy(b,api('POST','/api/admin/gen',{count:$('gn').value,coins:$('gx').value})).then(function(r){var o=$('go');o.style.display='block';o.value=r.codes.join('\n');toast('Đã tạo '+r.codes.length+' code')}).catch(bad)}
 else if(a==='dbrefresh'){loadDatabase()}
 else if(a==='dbsnapshot'){busy(b,api('POST','/api/admin/db/snapshot',{})).then(done('Đã lưu snapshot Redis',loadDatabase)).catch(bad)}
 else if(a==='dbsettings'){var sec=Math.floor(Number($('dbrefreshsec').value));busy(b,api('PUT','/api/admin/db/settings',{settings:{refreshSeconds:sec,defaultTab:$('dbdefault').value}})).then(function(){DASH_REFRESH=sec;startDashRefresh();toast('Đã lưu cài đặt')}).catch(bad)}
 else if(a==='nrefresh'){loadNotify()}
 else if(a==='ndsave'){busy(b,api('POST','/api/admin/notify/destinations',{name:$('ndname').value,channelId:$('ndid').value})).then(done('Đã lưu địa chỉ',loadNotify)).catch(bad)}
 else if(a==='nddel'){if(!confirm('Xóa địa chỉ này?'))return;busy(b,api('DELETE','/api/admin/notify/destinations/'+b.dataset.id)).then(done('Đã xóa',loadNotify)).catch(bad)}
 else if(a==='nsend'){busy(b,api('POST','/api/admin/notify/send',{channelId:$('nch').value,message:$('nmsg').value})).then(done('Đã gửi Discord')).catch(bad)}
 else if(a==='nquick'){var m={vmos:'📱 STOCK VMOS CLOUD\n\nHiện đã có máy VMOS. Ai cần nhận máy hãy vào mục Cloud Phone.',vsphone:'📱 STOCK VSPHONE\n\nHiện đã có máy VSPhone. Ai cần nhận máy hãy vào mục Cloud Phone.','empty-vmos':'⚠️ VMOS CLOUD\n\nHiện tại đã hết máy VMOS. Khi có máy mới sẽ thông báo sau.','empty-vsphone':'⚠️ VSPHONE\n\nHiện tại đã hết máy VSPhone. Khi có máy mới sẽ thông báo sau.'};$('nmsg').value=m[b.dataset.type]||''}
 else if(a==='infraDetail'){infraDetail(b.dataset.provider,b.dataset.id,b.dataset.p,b.dataset.e)}
 else if(a==='backdeploy'){vDeploy()}
 else if(a==='rrestart'){if(!confirm('Restart service Render này?'))return;busy(b,api('POST','/api/admin/render/'+b.dataset.id+'/restart',{})).then(done('Đã gửi restart',function(){setTimeout(vDeploy,2500)})).catch(bad)}
 else if(a==='renderrollback'){if(!confirm('Deploy lại commit '+b.dataset.commit+'?'))return;var svc=b.closest('.card')&&b.closest('.card').dataset.service;if(!svc){toast('Thiếu service ID, hãy mở lại lịch sử từ thẻ service',true);return}busy(b,api('POST','/api/admin/render/'+svc+'/rollback',{commitId:b.dataset.commit})).then(done('Đã gửi deploy commit cũ',function(){setTimeout(vDeploy,3000)})).catch(bad)}
 else if(a==='railrollback'){if(!confirm('Rollback Railway về deployment này?'))return;busy(b,api('POST','/api/admin/railway/rollback',{deploymentId:b.dataset.id})).then(done('Đã gửi rollback',function(){setTimeout(vDeploy,3000)})).catch(bad)}
 else if(a==='railredeploy'){busy(b,api('POST','/api/admin/railway/redeploy',{serviceId:'',environmentId:''})).catch(bad)}
 else if(a==='lcopy'){var tt=b.dataset.t;(navigator.clipboard?navigator.clipboard.writeText(tt):Promise.reject()).then(function(){toast('Đã sao chép token')}).catch(function(){var el=$('tokv');if(el){var r=document.createRange();r.selectNodeContents(el);var sl=getSelection();sl.removeAllRanges();sl.addRange(r)}toast('Hãy giữ và sao chép token đang được chọn',true)})}
 else if(a==='lregen'){busy(b,api('POST','/api/link/regen',{})).then(function(){toast('Đã tạo token mới');loadLink()}).catch(bad)}
 else if(a==='lunlink'){if(!confirm('Hủy liên kết Discord? Bạn sẽ phải lấy token và /ketnoi lại.'))return;busy(b,api('POST','/api/link/unlink',{})).then(function(){toast('Đã hủy liên kết');return api('GET','/api/me')}).then(function(m){ME=m;head();TAB='';buildNav();go(tabList()[0][0])}).catch(bad)}
});
$('pw').addEventListener('keydown',function(e){if(e.key==='Enter')pwLogin()});
boot();
</script></body></html>`;
