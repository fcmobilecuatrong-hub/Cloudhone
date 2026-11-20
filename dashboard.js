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
                const u = JSON.parse(raw);
                u.admin = (await adminIds()).includes(u.id);
                req.user = u;
            }
        }
        next();
    }));
    const userOnly = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Chưa đăng nhập' });
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

    const buyCost = () => parseInt(env('BUYCLOUD_COST') || '0', 10) || 0;
    const PROVIDERS = [
        { key: 'vmos', name: 'VMOS Cloud', cloud: 'VM', ready: true },
        { key: 'vsphone', name: 'VSPhone', cloud: 'VS', ready: true },
        { key: 'ugphone', name: 'UGPhone', cloud: '', ready: false }
    ];

    app.get('/api/me', (req, res, next) => req.user ? next() : adminOnly(req, res, next), wrap(async (req, res) => {
        const u = req.user || null;
        res.json({
            user: u ? { id: u.id, name: u.name, avatar: u.avatar } : null,
            admin: !!(u ? u.admin : true),
            coins: u ? await coinsOf(u.id) : 0,
            dailyDone: u ? !!(await redis.exists(`daily_${u.id}_${todayVN()}`)) : false,
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

    app.get('/dashboard', (req, res) => res.type('html').send(DASH_HTML));
};

const DASH_HTML = String.raw`<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0e0f1c">
<title>Nigaria Control Center</title>
<style>
:root{--bg:#0a0b18;--sf:#12152b;--ln:#1d2040;--tx:#eceeff;--mut:#6b7099;--ok:#4ade80;--ac:#6366f1;--bad:#f87171;--warn:#fbbf24}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh}
/* HEADER */
.hdr{position:fixed;top:0;left:0;right:0;height:56px;background:rgba(10,11,24,.95);border-bottom:1px solid var(--ln);display:flex;align-items:center;gap:12px;padding:0 16px;z-index:200;backdrop-filter:blur(10px);padding-top:env(safe-area-inset-top,0)}
.ham{background:none;border:none;color:var(--tx);font-size:22px;cursor:pointer;padding:4px 6px;line-height:1;border-radius:8px}
.ham:hover{background:var(--sf)}
.hdr-logo{font-weight:900;font-size:16px;letter-spacing:2px;flex:1}
.hdr-logo span{color:var(--ac)}
.hdr-right{display:flex;align-items:center;gap:10px}
#av{width:32px;height:32px;border-radius:50%;background:var(--sf);flex:none;object-fit:cover}
.coin{color:var(--warn);font-weight:700;font-size:13px}
/* OVERLAY */
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:299;backdrop-filter:blur(2px)}
.overlay.show{display:block}
/* SIDEBAR */
.sidebar{position:fixed;top:0;left:0;bottom:0;width:260px;background:var(--sf);border-right:1px solid var(--ln);z-index:300;transform:translateX(-100%);transition:transform .28s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column;padding-top:env(safe-area-inset-top,0)}
.sidebar.open{transform:translateX(0)}
.side-head{padding:20px 16px 16px;border-bottom:1px solid var(--ln);display:flex;align-items:center;gap:12px}
.side-head img{width:46px;height:46px;border-radius:50%;background:var(--bg);flex:none;object-fit:cover}
.side-name{font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side-coin{color:var(--warn);font-size:12px;font-weight:600;margin-top:2px}
.side-body{flex:1;overflow-y:auto;padding:8px 0;scrollbar-width:none}
.side-body::-webkit-scrollbar{display:none}
.nav-label{font-size:10.5px;font-weight:700;letter-spacing:.12em;color:var(--mut);padding:14px 18px 5px;text-transform:uppercase}
.nav-item{display:flex;align-items:center;gap:12px;width:100%;background:none;border:none;color:var(--mut);font:inherit;font-size:14px;font-weight:500;padding:11px 18px;cursor:pointer;text-align:left;transition:background .15s,color .15s}
.nav-item:hover{background:rgba(99,102,241,.08);color:var(--tx)}
.nav-item.on{background:rgba(99,102,241,.18);color:#a5b4fc;font-weight:700}
.nav-ico{font-size:18px;width:26px;text-align:center;flex:none}
.nav-sep{height:1px;background:var(--ln);margin:8px 14px}
.side-foot{padding:12px;border-top:1px solid var(--ln);padding-bottom:calc(12px + env(safe-area-inset-bottom,0))}
.side-logout{width:100%;background:none;border:1px solid var(--ln);color:var(--mut);font:inherit;font-size:13px;padding:10px;border-radius:12px;cursor:pointer;transition:color .15s,border-color .15s}
.side-logout:hover{color:var(--bad);border-color:var(--bad)}
/* MAIN */
.main{padding:72px 14px 36px;max-width:680px;margin:0 auto}
/* CARDS */
.card{background:var(--sf);border:1px solid var(--ln);border-radius:16px;padding:16px;margin-bottom:12px}
.card h3{margin:0 0 12px;font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mut)}
.big{font-size:36px;font-weight:800;color:var(--warn);line-height:1.1}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.row>input,.row>select{flex:1;min-width:120px}
input,select,textarea{width:100%;padding:12px;border-radius:12px;border:1px solid var(--ln);background:#0d0f22;color:var(--tx);font:inherit;font-size:14px}
input:focus,select:focus,textarea:focus{outline:2px solid var(--ac);border-color:transparent}
textarea{font:12.5px/1.45 ui-monospace,Menlo,Consolas,monospace;min-height:55vh;resize:vertical;white-space:pre;tab-size:4}
.m{color:var(--mut);font-size:12.5px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.m a,.t a{color:var(--ac);text-decoration:none}
.t{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.chip{font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;border:1px solid;white-space:nowrap}
.ok.chip,.cok{color:var(--ok);border-color:var(--ok)}.bad.chip{color:var(--bad);border-color:var(--bad)}.warn.chip{color:var(--warn);border-color:var(--warn)}.off.chip{color:var(--mut);border-color:var(--mut)}
.acts{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
.err{background:#3a1225;color:#ffc4cf;border-radius:12px;padding:12px;font-size:13px;border:1px solid #6b1535}
.li{padding:10px 0;border-top:1px solid var(--ln)}.li:first-child{border-top:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;align-items:start}
.kv{font:13px ui-monospace,Menlo,monospace;background:#0d0f22;border:1px solid var(--ln);border-radius:10px;padding:10px;word-break:break-all;margin:6px 0}
.hint{color:var(--mut);font-size:13px;margin:6px 0 10px}
.btn{border:0;border-radius:10px;padding:10px 16px;background:var(--ac);color:#fff;font:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .15s}
.btn.ok{background:#166534}.btn.bad{background:#991b1b}.btn.sm{padding:7px 11px;font-size:12px}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn:not(:disabled):hover{opacity:.85}
.ghost{background:none;border:1px solid var(--ln);color:var(--mut);border-radius:10px;padding:8px 12px;font:inherit;font-size:13px;cursor:pointer;text-decoration:none;display:inline-block}
.ghost:hover{color:var(--tx)}
#login{display:none;max-width:380px;margin:16vh auto 0;text-align:center;padding:0 20px}
#login h1{font-size:30px;font-weight:900;letter-spacing:2px;margin-bottom:4px}
#login h1 span{color:var(--ac)}
#login .hint{margin-bottom:20px}
#login .btn{width:100%;padding:14px;margin-bottom:10px;font-size:15px}
#app{display:none}
.toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,30px);background:var(--sf);padding:12px 20px;border-radius:14px;font-size:14px;opacity:0;pointer-events:none;transition:.25s;max-width:90vw;z-index:9999;border:1px solid var(--ln)}
.toast.show{opacity:1;transform:translate(-50%,0)}.toast.bad{background:#3a1225;color:#ffc4cf;border-color:var(--bad)}
.evar{display:grid;grid-template-columns:1fr;gap:6px;padding:10px 0;border-top:1px solid var(--ln)}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body>
<div id="login">
  <h1>NIGARIA<span>_</span></h1>
  <p class="hint">Đăng nhập để xem ví xu, đăng ký và mua cloud phone.</p>
  <a id="dlogin" class="btn" style="display:block;text-decoration:none" href="/auth/discord">🎮 Đăng nhập Discord</a>
  <details style="text-align:left;margin-top:14px"><summary class="hint" style="cursor:pointer">Admin: đăng nhập bằng mật khẩu</summary>
  <input id="pw" type="password" placeholder="Mật khẩu admin" autocomplete="current-password" style="margin:10px 0">
  <button class="btn" onclick="pwLogin()">Vào bằng mật khẩu</button></details>
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
function pwLogin(){K=$('pw').value;sessionStorage.setItem('k',K);boot()}
function logout(){K='';sessionStorage.removeItem('k');api('POST','/api/logout').catch(function(){}).then(function(){ME=null;location.reload()})}
function toggleSide(){var s=$('sidebar'),o=$('overlay');s.classList.contains('open')?closeSide():(s.classList.add('open'),o.classList.add('show'))}
function closeSide(){$('sidebar').classList.remove('open');$('overlay').classList.remove('show')}
function boot(){api('GET','/api/me').then(function(m){ME=m;$('login').style.display='none';$('app').style.display='block';head();buildNav();if(ME.admin)api('GET','/api/admin/db/settings').then(function(d){var st=d.settings||{};DASH_REFRESH=Number(st.refreshSeconds)||0;if(!TAB&&st.defaultTab&&tabList().some(function(t){return t[0]===st.defaultTab}))TAB=st.defaultTab;startDashRefresh()}).catch(function(){}).finally(function(){go(TAB&&tabList().some(function(t){return t[0]===TAB})?TAB:tabList()[0][0])});else go(TAB&&tabList().some(function(t){return t[0]===TAB})?TAB:tabList()[0][0])}).catch(function(e){if(K){K='';sessionStorage.removeItem('k')}showLogin(e.status===401?'':e.message)})}
function startDashRefresh(){if(window._dashRefreshTimer)clearInterval(window._dashRefreshTimer);if(DASH_REFRESH>0)window._dashRefreshTimer=setInterval(function(){if(TAB==='deploy')vDeploy();else if(TAB==='db')loadDatabase();else if(TAB==='notify')loadNotify()},DASH_REFRESH*1000)}
function head(){var u=ME.user;var av=u&&u.avatar?u.avatar:'data:image/gif;base64,R0lGODlhAQABAAAAACw=';$('av').src=av;$('sav').src=av;$('snm').textContent=u?u.name:'Admin';$('hc').textContent=u?num(ME.coins)+' xu':'';$('shc').textContent=u?num(ME.coins)+' xu':'Admin'}
function refreshMe(){return api('GET','/api/me').then(function(m){ME=m;head();var b=$('bal');if(b)b.textContent=num(ME.coins)})}
function tabList(){var t=[];if(ME.user){t.push(['wallet','💰','Ví xu'],['cloud','📱','Cloud Phone'],['top','🏆','Bảng xếp hạng'])}if(ME.admin){t.push(['deploy','🚀','Deploy'],['code','💻','GitHub'],['env','🔑','Biến MT'],['bots','🤖','Bot'],['gen','🎁','Gift Code'],['notify','📣','Thông báo'],['db','🗄️','Database'])}return t}
function buildNav(){
  var list=tabList();
  var user=list.filter(function(t){return ['wallet','cloud','top'].indexOf(t[0])>=0});
  var admin=list.filter(function(t){return ['deploy','code','env','bots','gen','notify','db'].indexOf(t[0])>=0});
  var h='';
  if(user.length){h+='<div class="nav-label">Cloud Phone</div>';user.forEach(function(t){h+='<button class="nav-item'+(TAB===t[0]?' on':'')+'" data-tab="'+t[0]+'"><span class="nav-ico">'+t[1]+'</span>'+t[2]+'</button>'})}
  if(admin.length){h+='<div class="nav-sep"></div><div class="nav-label">Quản trị</div>';admin.forEach(function(t){h+='<button class="nav-item'+(TAB===t[0]?' on':'')+'" data-tab="'+t[0]+'"><span class="nav-ico">'+t[1]+'</span>'+t[2]+'</button>'})}
  $('sideNav').innerHTML=h;
  Array.prototype.forEach.call(document.querySelectorAll('.nav-item[data-tab]'),function(b){b.addEventListener('click',function(){go(b.dataset.tab)})});
}
function go(t){TAB=t;buildNav();closeSide();M('<div class="m">Đang tải...</div>');({wallet:vWallet,cloud:vCloud,top:vTop,deploy:vDeploy,code:vCode,env:vEnv,bots:vBots,gen:vGen,notify:vNotify,db:vDatabase})[t]()}
function M(h){$('main').innerHTML=h}
function errBox(m){return '<div class="err">'+esc(m)+'</div>'}

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
});
$('pw').addEventListener('keydown',function(e){if(e.key==='Enter')pwLogin()});
boot();
</script></body></html>`;
