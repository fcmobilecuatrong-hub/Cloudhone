/**
 * UMO (WillClouds, clientCode=ae02b) Pool API Server
 * Deploy on Railway — same pattern as vsphone
 * Endpoints: GET /health  POST /register
 */
import crypto from 'node:crypto';
import express from 'express';
import pg from 'pg';

const app = express();
app.use(express.json());

// ── CONFIG ──────────────────────────────────────────────────────────
const C = {
  clientCode:    'ae02b',
  baseApi:       'https://oem-api.willclouds.com',
  baseCore:      'https://oem-core.willclouds.com',
  tenantId:      '242',
  clientBrandId: '108',
  salt:          '4d9cbb6b585448419578a95954a2b886',
  chnl:          'h5_cphone',
  cid:           '50000',
  cver:          '1001021',
  locale:        'en-US',
  clientType:    'h5',
};

const API_KEYS  = new Set((process.env.API_KEYS || process.env.API_KEY || 'devkey').split(',').map(s => s.trim()).filter(Boolean));
const POOL_MAX  = parseInt(process.env.POOL_MAX || '30');
const WARM_SIZE = parseInt(process.env.WARM_SIZE || '5');
const PORT      = parseInt(process.env.PORT || '3000');

// ── DATABASE ─────────────────────────────────────────────────────────
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function setupDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS umo_pool (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      token TEXT,
      user_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      taken_at TIMESTAMPTZ,
      status TEXT DEFAULT 'ready'
    );
  `);
}

// ── HELPERS ──────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function javaEncode(s) {
  const bytes = Buffer.from(String(s), 'utf8');
  let out = '';
  for (const b of bytes) {
    if (b === 32) out += '+';
    else if ((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 45 || b === 46 || b === 95 || b === 42)
      out += String.fromCharCode(b);
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function toQS(obj) {
  return Object.keys(obj).sort((a, b) => a.localeCompare(b)).map(k => `${javaEncode(k)}=${javaEncode(obj[k])}`).join('&');
}

function sign(params) {
  const qs = toQS(params);
  const h = crypto.createHash('md5').update(qs + C.salt, 'utf8').digest('hex');
  return h.slice(4, 20);
}

function commonParams(userId = '') {
  const ts = Date.now().toString();
  const cuid = ts + Math.floor(1000000 + Math.random() * 9000000) + C.clientCode;
  return { cuid, ts, userId: String(userId || ''), cid: C.cid, chnl: C.chnl, cver: C.cver, locale: C.locale, clientType: C.clientType };
}

async function saasRequest(path, data, { core = false, token = null, userId = '' } = {}) {
  const base = core ? C.baseCore : C.baseApi;
  const params = { ...commonParams(userId), ...data };
  const sig = sign(params);
  const headers = {
    'x-signature':    sig,
    'content-type':   'application/x-www-form-urlencoded',
    'tenant-id':      C.tenantId,
    'client-brand-id': C.clientBrandId,
    'timezone':       'Asia/Saigon',
    'accept-language': C.locale,
    'origin':         'https://h5.willclouds.com',
    'referer':        'https://h5.willclouds.com/',
    'user-agent':     'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const body = toQS(params);
  const res = await fetch(base + path, { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

// ── INBOXKITTEN ───────────────────────────────────────────────────────
function randomEmail() {
  return `umo${crypto.randomBytes(5).toString('hex')}${Date.now().toString(36).slice(-4)}@inboxkitten.com`;
}

async function inboxList(localPart) {
  const r = await fetch(`https://inboxkitten.com/api/v1/mail/list?recipient=${encodeURIComponent(localPart)}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`inbox list ${r.status}`);
  return r.json();
}

async function inboxGetHtml(storage) {
  const r = await fetch(`https://inboxkitten.com/api/v1/mail/getHtml?region=${encodeURIComponent(storage.region)}&key=${encodeURIComponent(storage.key)}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`inbox html ${r.status}`);
  return r.text();
}

async function waitOtp(localPart, known = new Set(), timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let msgs = [];
    try { msgs = await inboxList(localPart); } catch {}
    for (const m of msgs) {
      const id = m?.storage?.key;
      if (id && known.has(id)) continue;
      const storage = m?.storage;
      if (!storage?.region || !storage?.key) continue;
      try {
        const html = await inboxGetHtml(storage);
        const subject = m?.message?.headers?.subject || '';
        const otp = (subject + ' ' + html.replace(/<[^>]+>/g, ' ')).match(/\b(\d{6})\b/)?.[1];
        if (otp) return otp;
      } catch {}
      if (id) known.add(id);
    }
    await sleep(4000);
  }
  throw new Error('OTP timeout');
}

// ── REGISTRATION ──────────────────────────────────────────────────────
async function registerOne() {
  const email = randomEmail();
  const localPart = email.split('@')[0];

  const before = new Set((await inboxList(localPart).catch(() => [])).map(m => m?.storage?.key).filter(Boolean));

  const send = await saasRequest('/saas-api/cloud-client/auth/send-verification-code', { account: email, accountType: 'mail', scene: '1', captcha: '' });
  if (send.json?.code !== 0) throw new Error(`send-code: ${JSON.stringify(send.json)}`);

  const otp = await waitOtp(localPart, before);

  const login = await saasRequest('/saas-api/cloud-client/auth/login', { loginType: 'MAIL_CODE', account: email, captcha: '', authContent: otp }, { core: true });
  if (login.json?.code !== 0) throw new Error(`login: ${JSON.stringify(login.json)}`);

  const data  = login.json.data || {};
  const token  = data.token;
  const userId = String(data.userId || '');
  if (!token) throw new Error('no token from login');

  // activate trial
  await saasRequest('/saas-api/cloud-client/user/receive-instance', {}, { token, userId }).catch(() => {});

  return { email, token, userId };
}

// ── POOL MANAGER ──────────────────────────────────────────────────────
let producing = false;
let produced = 0, failed = 0;

async function poolSize() {
  const r = await db.query("SELECT COUNT(*) c FROM umo_pool WHERE status='ready'");
  return parseInt(r.rows[0].c);
}

async function fillPool() {
  if (producing) return;
  producing = true;
  try {
    while (true) {
      const size = await poolSize();
      if (size >= POOL_MAX) break;
      try {
        const { email, token, userId } = await registerOne();
        await db.query("INSERT INTO umo_pool(email,token,user_id,status) VALUES($1,$2,$3,'ready') ON CONFLICT(email) DO NOTHING", [email, token, userId]);
        produced++;
        console.log(`[pool] +1 ${email} total=${size+1}`);
      } catch (e) {
        failed++;
        console.error('[pool] fail:', e.message);
        await sleep(8000);
      }
      await sleep(2000);
    }
  } finally { producing = false; }
}

// warm on start and periodically
async function warmPool() {
  const size = await poolSize().catch(() => 0);
  if (size < WARM_SIZE) fillPool().catch(console.error);
}

setInterval(() => warmPool(), 30000);

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apikey || '';
  if (!API_KEYS.has(key)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// ── ROUTES ────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const size = await poolSize().catch(() => -1);
  const total = await db.query("SELECT COUNT(*) c FROM umo_pool").then(r => parseInt(r.rows[0].c)).catch(() => -1);
  res.json({ ok: true, pool: { ready: size, total }, producer: { running: producing, produced, failed } });
});

app.post('/register', auth, async (req, res) => {
  try {
    // pop from pool
    const r = await db.query("UPDATE umo_pool SET status='taken',taken_at=NOW() WHERE id=(SELECT id FROM umo_pool WHERE status='ready' ORDER BY created_at ASC LIMIT 1) RETURNING email,token,user_id");
    if (r.rows.length) {
      const { email, token, user_id } = r.rows[0];
      warmPool().catch(() => {});
      return res.json({ ok: true, account: email, token, userId: user_id, source: 'pool' });
    }
    // pool empty — register on demand
    const acc = await registerOne();
    warmPool().catch(() => {});
    res.json({ ok: true, account: acc.email, token: acc.token, userId: acc.userId, source: 'live' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/pool', auth, async (req, res) => {
  await db.query("DELETE FROM umo_pool");
  res.json({ ok: true });
});

// ── START ─────────────────────────────────────────────────────────────
await setupDb();
warmPool().catch(console.error);
app.listen(PORT, () => console.log(`UMO API :${PORT}`));
