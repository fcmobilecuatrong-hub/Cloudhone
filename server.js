require('dotenv').config();
const vm = require('vm');
const express = require('express');
const crypto = require('crypto');
const Redis = require('ioredis');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags, Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');

if (!process.env.DISCORD_TOKEN) console.warn('⚠️ Không có DISCORD_TOKEN trong .env: bot chính sẽ không chạy, chỉ chạy các bot thêm từ bảng điều khiển.');
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
process.on('uncaughtException', err => console.error('[uncaughtException]', err));

const app = express();
app.use(express.json({ limit: '3mb' }));
const PORT = Number(process.env.PORT) || 3000;
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
redis.on('error', err => console.error('[Redis]', err.message));

function generateGiftCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 12; i++) result += chars[crypto.randomInt(chars.length)];
    return result;
}

async function getAdminIds() {
    const envAdmins = (process.env.ADMIN_DISCORD_ID || '').split(',').map(id => id.trim()).filter(id => id);
    const redisAdmins = await redis.smembers('admins');
    return [...new Set([...envAdmins, ...redisAdmins])];
}

function getTodayString() {
    const now = new Date();
    const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    return vnTime.toISOString().split('T')[0];
}

function secondsUntilVnMidnight() {
    const vn = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const next = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate() + 1);
    return Math.max(1, Math.floor((next - vn.getTime()) / 1000));
}


// ===== BXH XU TUẦN (múi giờ Việt Nam, tuần bắt đầu thứ Hai) =====
function dateKeyUTC(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
function getWeekStartVNDate(weeksAgo = 0) {
    const vn = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const daysSinceMonday = (vn.getUTCDay() + 6) % 7;
    vn.setUTCDate(vn.getUTCDate() - daysSinceMonday - (weeksAgo * 7));
    return dateKeyUTC(vn);
}
function weeklyLeaderboardKey(weekStart = getWeekStartVNDate()) {
    return `leaderboard_weekly:${weekStart}`;
}
function weeklyRewards() {
    const values = (process.env.TOP_REWARDS || '1000,700,500,300,250,150')
        .split(',').map(v => Math.max(0, parseInt(v.trim(), 10) || 0));
    return Array.from({ length: 6 }, (_, i) => values[i] || 0);
}
async function addEarnedCoins(userId, amount) {
    const value = Math.floor(Number(amount));
    if (!userId || !Number.isFinite(value) || value <= 0) throw new Error('Số xu cộng không hợp lệ.');
    const key = weeklyLeaderboardKey();
    return redis.multi()
        .incrby(`coins_${userId}`, value)
        .zincrby('leaderboard', value, userId)
        .zincrby(key, value, userId)
        .exec();
}

// Nhận thưởng một lần: khóa chống nhận trùng và cộng số dư/BXH trong cùng Lua script.
const CLAIM_REWARD_LUA = `
local claimed = redis.call('SET', KEYS[1], '1', 'EX', ARGV[2], 'NX')
if not claimed then return 0 end
redis.call('INCRBY', KEYS[2], ARGV[1])
redis.call('ZINCRBY', KEYS[3], ARGV[1], ARGV[3])
redis.call('ZINCRBY', KEYS[4], ARGV[1], ARGV[3])
return 1
`;
async function claimEarnedCoinsOnce(claimKey, userId, amount, ttlSeconds) {
    const value = Math.floor(Number(amount));
    const ttl = Math.max(1, Math.floor(Number(ttlSeconds)));
    if (!claimKey || !userId || !Number.isSafeInteger(value) || value <= 0 || !Number.isFinite(ttl)) {
        throw new Error('Thông tin nhận thưởng không hợp lệ.');
    }
    return Number(await redis.eval(CLAIM_REWARD_LUA, 4, claimKey, `coins_${userId}`, 'leaderboard', weeklyLeaderboardKey(), value, ttl, userId)) === 1;
}

const REDEEM_SESSION_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local data = cjson.decode(raw)
if not data.userId then return redis.error_reply('Session không có userId') end
redis.call('DEL', KEYS[1])
local amount = tonumber(ARGV[1])
local balance = redis.call('INCRBY', 'coins_' .. data.userId, amount)
redis.call('ZINCRBY', 'leaderboard', amount, data.userId)
redis.call('ZINCRBY', ARGV[2], amount, data.userId)
return cjson.encode({ userId = data.userId, provider = data.provider or '', balance = balance })
`;

const REDEEM_GIFT_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local amount = tonumber(raw)
if not amount or amount <= 0 or amount ~= math.floor(amount) then return redis.error_reply('Gift Code có số xu không hợp lệ') end
redis.call('DEL', KEYS[1])
local balance = redis.call('INCRBY', 'coins_' .. ARGV[1], amount)
redis.call('ZINCRBY', 'leaderboard', amount, ARGV[1])
redis.call('ZINCRBY', ARGV[2], amount, ARGV[1])
return tostring(amount)
`;

const TRANSFER_COINS_LUA = `
local balance = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
local net = tonumber(ARGV[2])
if not balance or not amount or not net or amount <= 0 or net <= 0 then return redis.error_reply('Dữ liệu chuyển xu không hợp lệ') end
if balance < amount then return { 0, balance } end
redis.call('DECRBY', KEYS[1], amount)
redis.call('INCRBY', KEYS[2], net)
redis.call('ZINCRBY', KEYS[3], net, ARGV[3])
redis.call('ZINCRBY', KEYS[4], net, ARGV[3])
return { 1, balance - amount }
`;

const MANUAL_AWARD_LUA = `
local saved = redis.call('SET', KEYS[1], '1', 'EX', ARGV[2], 'NX')
if not saved then return 0 end
redis.call('INCRBY', KEYS[2], ARGV[1])
return 1
`;
function getPublicBaseUrl() {
    const raw = String(process.env.RENDER_EXTERNAL_URL || process.env.RENDER_DOMAIN || '').trim();
    if (!raw) throw new Error('Chưa cấu hình RENDER_EXTERNAL_URL hoặc RENDER_DOMAIN.');
    let parsed;
    try { parsed = new URL(raw.includes('://') ? raw : `https://${raw}`); }
    catch { throw new Error('RENDER_EXTERNAL_URL/RENDER_DOMAIN không phải URL hợp lệ.'); }
    if (parsed.protocol !== 'https:') throw new Error('Đường dẫn public phải sử dụng HTTPS.');
    return parsed.origin;
}

function formatWeekRange(weekStart) {
    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
    return `${weekStart} đến ${dateKeyUTC(end)} (giờ Việt Nam)`;
}

// WEB SERVER
// ── Auto-redeploy Railway vsphone mỗi 30 phút ──────────────────────
async function redeployVsphone() {
    const token = process.env.RAILWAY_API_TOKEN;
    const serviceId = process.env.VSPHONE_SERVICE_ID;
    const envId = process.env.VSPHONE_ENV_ID;
    if (!token || !serviceId) return;
    const query = `mutation { serviceInstanceRedeploy(serviceId: "${serviceId}"${envId ? `, environmentId: "${envId}"` : ''}) }`;
    try {
        const r = await fetch('https://backboard.railway.app/graphql/v2', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(15000) });
        const d = await r.json();
        if (d.errors) console.log('[vsphone-redeploy] lỗi:', d.errors[0].message);
        else console.log('[vsphone-redeploy] ✓ redeploy lúc', new Date().toLocaleTimeString('vi-VN'));
    } catch (e) { console.log('[vsphone-redeploy] lỗi:', e.message); }
}
if (process.env.RAILWAY_API_TOKEN && process.env.VSPHONE_SERVICE_ID) {
    setInterval(redeployVsphone, 30 * 60 * 1000);
    console.log('[vsphone-redeploy] auto-redeploy mỗi 30 phút đã bật');
}


app.get('/redeem', async (req, res) => {
    const { sid } = req.query;
    const renderError = (msg) => res.status(403).send(`
        <body style="background:#080d0b; color:#ff6b81; text-align:center; padding-top:100px; font-family:sans-serif;">
            <h1>❌ LỖI TRUY CẬP</h1>
            <p style="color:#fff">${msg}</p>
            <a href="https://discord.com/app" style="color:#39f58a;">Quay lại Discord</a>
        </body>
    `);
    if (!sid) return renderError("Bạn phải lấy link từ lệnh /getlink trên Discord.");
    if (!/^[a-f0-9]{32}$/i.test(String(sid))) return renderError('Mã liên kết không hợp lệ.');
    try {
        const redeemed = await redis.eval(REDEEM_SESSION_LUA, 1, `session_${sid}`, 50, weeklyLeaderboardKey());
        if (!redeemed) return renderError("Link này đã được sử dụng hoặc đã hết hạn.");
        const { userId, provider, balance: newBalance } = JSON.parse(redeemed);
        console.log(`[WEB] ${userId} +50 xu (${provider}). Số dư: ${newBalance}`);
        res.send(`
            <body style="background:#080d0b; color:#fff; display:flex; justify-content:center; align-items:center; height:100vh; font-family:sans-serif; margin:0;">
                <div style="background:#101a14; padding:30px; border-radius:16px; border:1px solid #39f58a; text-align:center; max-width:400px; width:100%;">
                    <h2 style="color:#39f58a;">✅ VƯỢT LINK THÀNH CÔNG!</h2>
                    <p style="font-size:16px; margin-bottom:20px;">Bạn đã nhận được <b style="color:#ffc107;">+50 xu</b>.</p>
                    <p style="color:#91a096; font-size:14px; margin-bottom:20px;">Số dư hiện tại: <b style="color:#39f58a;">${newBalance} xu</b></p>
                    <a href="https://discord.com/app" style="background:#39f58a; color:#000; text-decoration:none; padding:10px 20px; border-radius:8px; font-weight:bold; display:inline-block;">Quay lại Discord</a>
                </div>
            </body>
        `);
    } catch (error) {
        console.error(error);
        res.status(500).send("Lỗi Server.");
    }
});
const ICONS = {
    vmos: Buffer.from('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', 'base64'),
    vsphone: Buffer.from('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', 'base64'),
    ugphone: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAcEElEQVR42u2deZhU1Zn/P+fcW9Xd1dUL3TQgaNgEdEgExA3jEhDiZKI/nYyOeVySjAkajZho1MQYE00ky8xoMD4xoyT+dCZmTJ7EZEbjAi4RcI+KSgAFAsjSQLP03rXce878ce7tqgaEe291NXR3nee5T0F1Vd1zz/t91/O+7xFaa01pDNohS0tQAkBplABQGiUAlEYJAKVRAkBpDLJhl5aggNHtQfuvYq//9/YQ5reFyLtXgb9YigOEorhH294lQmTwCVGSAH3H6RqE9GjuLXwmBR2t0NkGLbsh1QFutngSQEgYdhQcMRZi8ZIK6DMR73N7JgVNm2HTGti2Adr2QDYDXe2edNDgOkW02CywbaisgSlnmGsf9VNSAb1MeGDHZlj3Nqx9G1p2gnINMaTMvQppiFBMraABrcDJGmkzaTqc/Tmw7J7zLUmAQhZZecTEcPmbz8PGVZDuglgZlFXsa+zpPDXRF+zkz2PVa1BWCbM/a+YdAX0lCdCDvbwF3NUIry+GtcsNYePlhsu09hb6MBlCQKoD/ZlrEaPG9QRvSQJE4HqtYfkSeO1J6OowulYAShmxf7gNb87iry/ByHGRJEAJAEoZHd7VDs/8Gta8DYkqqKoF1+0bkV4IcGNlsHkNdLZDZbKnJCsBIMACSglNW+CJB4yBV11n3nfd/vEMQpj5djQbAISj/yAGgC/2//ZXePohI+IT1YenqD84CqA8EckblIOb+KvgsfvMe2UV/ZP4rgO1DcZeiYAAOWiJv2MTPPUAxMuMHlWq/z2LtCCThonTwbIieSiDCwDaC+d2tMCTD5n/x8r6J+dbMROGrh8BE6flnq3kBRxMZLqw+NfQvB0qa3uJ+KLnHkGR1T0IY/SVV8InLzPqK2I4xx5c3C/g7aXwt3egemjhxBfCcJ3reJdbZMp7gSjlwvAxMOdiqD+ioJ1Be1ARf/c2eO0pSNYWFtGT0tgMmRQ4GShLGCMsXg7xBFAEe0J7gKuohLEfg0nHey5gYdvCg0sFvPoUpDuhsjqa0ecvdFe7McBGjIZxU+CIMVA1xIhiIYsXLvY3n/YGdgHDHjTcv2mtie0nIhJfWpBNG44fMxmmnAkfmfhhFlpxn6db/ZQSQgIaTcBbz0U30qQFqS6Ix+Gsi4zble9W5t+o2Hag6N0bDGwA+HH+HZth6zqjo8OKZ2kZkV/bAP9wuXG7/K1X3wjsx0MOCu5f85ZJoLBC4l1KkwdQ2wDnX2WIr7xAkhADYokGOACkydFb947nK4fgfiEgmzUpWOfONUaev3k0gMbABYBvLDVuNLt8djxksERAugM+cYGRAEr1e3E/OAGwdZ0X/w8hsqUFna1w9FSYdELOlhiAY+ACQHiRs63rw3Oudo3EOOUfimJ5lwDQV75/Vwe07jJ6PKj4l9K4fEdOgKEjSwDo16Or3UT+RJjAjDDBnrGT9/LzSwDoTyLAvLQ1GzfOsoJJACGM15CoMuHdHr5kCQD9jv5kOg03h7EBXBcqklBVx2AYAxMAPtOmukJm9QpjAJaVewUgA1v/D3wbQLkgIxCwLJHzIkoSYJANTV6iiCgBoF8Pyw659eu5j+mufpoeXgJAzxGvBDsWLgQsLUinTKWNH1MoAaCfjoqKXEePQAJAG6nR3mLSx0oA6OduQHUdJKtNwmZQa15a4KRhy9pBYQYMbDcwWWtSwFwnOCW1gngFrHvXNGIoBYL6KQKUMuK8ZqgJ7gSlo18ssqvRdATxiy9LAOinUuDI8V5jh5C+YCwOrz5pUr8RA9YWGMBGoIeAI4819X9huFhrEw3cswNefCyXf18CQH+ivweA2nqzsZPuCr8nUFkN7y6Dla/likFKAOhHw88EGj3ZBHai2HNlCXjuEXj/TQMCrQeUNBjgoWCP4secYFzCbCbc5o7Wxi2MxeHp/4I3nssVZGg1IIBw+AHA5zCl9r3CLrivuysqYeLxXnKIDC9FpGVsgiWPwp9+CXuaeqaGf9h88+d9mILl8GgTl79AB0u+VCpcWZSfHtbRAr/+V5PwYcUiEESYncXONrNVfMyJcOzJMPTIYGzkg0SIwyrB9NABwDeo9l6MbBY6OtAtLdCVQre3gZNFVCRgxAjE8OG57wddSP+zf3kWlj5qkj2ibvZIrxw83Ql2GYw4Co4cj7br0DoG7R2ARtTUQLIKkklEIgHV1fsHfS/V+PUfAPicYFndxNFbtqJXvIt6ezl68xZoakI3N5vFVAosCUojGoYijp+O9blLEWPHGUvdskLc14Xf3W3aw1Qko1v1Qpi4gg26M41682+odU1oRxsp4W8pl5Ujkkmor0ccMQIxbjzyhOmIY4+F8vJ9ATqgAbCX6NYffIBetgz15xdQG9ZDW7v5TDxuFiMez33e55BsFtraoKIC+7u3ImedFbxE2v/c9o3wu5+aaF9U/14pKLPRuztxnl2N7khDeXxfL0NpE05Wysw9kzGEb2hAnjoD68wzECecmJt/GED3KwDkIVyvWoX7x/9BvfAC7NxpduzKy03qdj5B8g9j0Hni17KMimhuIXb/z5EnnhScg/zPvfU8PP874xmEVQVaQ8xGt6dw/vQOOutAWXz/0cZ88PqvSkE6DZ2dYFmIY4/BOvdc5Dnn9Exf7yO1UFwA5HGn3rIF96GHUE8vgq4uoxPLyqJZybYNLS2Io44k9uCD5ndCxQYkPPkgrHwFaoaBCtPiXUN5Oc5zq1DrtkFVAlwVXoVYlnn21lbIZBCTJ2NdfjnyjNP7VBoUDwB5XKn++79xHnwQdu+BujpDQNeN7hppbX5j1y7sH/0QOXNmCD3qcaqbhf+9Hz5432sL64Tg/jTZx94y9QaFMqplGUC0tEA6g5w9C2veNYiRo8J7PIdNHMB1QUp0UxPOjTfh3HkXZB0YNsz83XEK84u7F0Sglr0YLThkx+GcuTDmGGjb3bP1ygGwQ8xCbW2BdBYs0Ttr5ThGIg6tRz3zLNkvfhH1/DPeOQTFVQWyKJxvWagVK8jOvcLo+uHDjZh2evE0Da0hFoPWFi9iJ4ODyrc14mVw7hUmVNy66+ALLgChoCNFr+cJuK5Zu2HDIJXBufFbuAsX7hsnOawB4HG+eu11nHlfhaYm80COU5yNFOXS3akjrOHkg8CyDQimn2UaLzrOh0sD70yIbjewGCPrGKN4aD3uz/8D57bbiqoGZK9z/pIlOF/9qnmvtta4PkWxXoQBXF1dDnyR/HkNtgVn/hPMucRIgc4WYyjubVMIwBWI2oQR/8UAgcgLkh1xBOoPf8S55dsGmIXYTUUFgGeA6TffwL31O0bcV5Qb37eYOsxVyE+cWZjblB/P/7uT4aLrYdxxJuSb8vYO/P0DD3RiWBJR7hmyxXo+rQ3RjzoK9fifcH7ww+A1jn0KAJ/4mzaRvfEbaK0hkQCnSIujtQkS7dyFmDYVefLJORugUImilekGcs6XzDXsKNMoIt2ZFwbWiJoEcvww6EpHqzwKpRKyMGoU6g9/wH3oIW8OvVezUJgb6Bsn2SzZK7+MXv0e1Nf1Hufv/RtCdLt/ojKBfe+9iAkTejeUmh+IcV3TVvbdZbB9E2S6zEZSeQVg4zzxFqqpFaoq92+o9Ra3+uuwaxf2PT9FnnJKrz1zYQDwJuHe/VODzpEjDfELfVjfovd1Xh7QaG9DjDsa+zvfRhx3XK+doHmgIBZgThVZ9zZseg92NprgUVbh/Pk91I42iNm5aKZPGN/H9/c/Co0XtLdDVRWx//pPxJAhvRIxjA4AX/SvWEH2S3ONHxvGFdtHGXkuWFfKVPUqZazhigqIxxFSIhoakDNnIs75NKK6unjE7xE02qsNu5OF5ibYtQ1am2BHI+qNlbhrGqG9A+27c+mMcVHBqKzKysLFdywGjY1YF/wT1s0394oUiA4AD9XZuVcY0V9bE90Sl9Js8qTTcOQo5PTpyI9+FDF6jPl7VdJsr9bX7zfS2CfDl0Ifdk8nA7v3oFvbobPDfGXLFvT7a8wu56rV5nM1NeaZIksEAXt2E/vFQiMBC1yHaADwbqoWLcL55s0wYkQ04luWsXSbmxFHj8e68ELErJmImtoD3/uQ7qF/yKbPgUY6jV65Evc3vzGRS8uCZDJaYMyyYM8exPHTiN19t3dyqehDAPgfz2TIXnEFeu06g+qwALAts98vBPLSS7AuvtgkTuRJlx4Le4gTJwIDI385fRWVx6H65Zdx7roLvWFjLkgWRV3u3oO94C7kjBkFbRzJSKJQCNSLLxmxVl0djvj+Rk5zKyKZJHb3AuwvfckQ398Z9HfLpMxdh32nDpEjtn/5z5CXMyhmzMD+xS8QM2bA9u1mLaIAQGvUH/6Y+3+fxQE8QqjFi3IPGorzva3coUOx7/0ZYsqUnLUv5cBsyZIPDNdF1NQQu+tO5FlneSCIhfs9x4HaGtTLL6M/+KCgwhUZhftp2o5+6y2T8xZGhAkB6TQikcD+939FjB6dE19i4Hfj6NbhSoFtY8+/A3nCdGjaEV4S2DZkMqjFi3O2UdEB4N1EvfgKenez8X3DckJzM9ZXrzUBHMcJrLuUUt1Xvz/v2q8ysm2s+fMRI0aYDKGw0jRmo/7yl9w6RlgXGZqAgHrzTWP0BJ1wXgKHnDMH+elP90wMDbRmsvsSh5m00FqHB6WvDurrseZ9BVrbwtti8TL0ho3o7dsjRx5lqBtKafLx1q41AZqgYkcIg9JYDPkvX8i5UQEI6S/s0qVLueqqq7jrrrtoa2vr8bdDNZT3/EKIblCGklCeMSdnz0accLyJhQRlCj9Q1tSEXrOmD4xA76H0tkZ041YT3QoKANuG5hbkmWcgJ00KLD2UUgghWLZsGZdccgnPP/888+fP5/bbb98HIIeC66X3DNu2bWPjxo2kUqluCaWDdib12tBb//iPuUypoBLOc431e+8HZqh9SBP6wTdtgc4uqE8Ed/+UAjTi4x/P/f8gSFdK4bouWmuWLFlCPB6noaGBsrIyXnnlFVpaWkgmk2itsSyrz9SCT1ghBE8++ST33Xcfu3fvRilFLBbjggsu4PLLL6eiogKt9cHn5YFIzDgFMXw4uq3NMFcI1arXr+tOximeBPAfpGnHvkGag30vm0UMGYKcNi2Q3+pzVywWw7IsEokEWmscx0EpRTweJ5lMYlkWtm33qU3gE3XBggV8/vOfZ9WqVbS2ttLe3s7OnTv53ve+x5e//GXS6XQwCeW5cKKmFjFpogmHh6l4Ki83QaWWlkjuYDgAuC66sTGc+BfCZAUNG2as3QCiSgjBmjVreOGFF3jzzTfZtGkTsVism9tTqRSLFi3i1Vdf5eWXX8bxXNFiqwOlFFJKnn32We68805Gjx7NkCFDiMVixGIxKioqOProo3n88cdZsGABQohuOyGIehWTJ4fbTfWPke3sgmwq0jOFUwFCQCYbTQKMGpmLin3Id/0Ffuqpp5g3bx4A8XicWCxGMpnEcRxisRjpdJrrrrsOKSXt7e3MmjWL++67j3hQ0VkA52uteeSRRygrK8O2bbJ5BNNak8lkGD16NL///e+ZO3cudXV1wVQBIBoawolxDdgWOpNBbWtCDh8ZeodUBr8ToFx0W4speQrFOhoSFQGwYjhmwYIFKKWor6+nvLwcOy9I4i9mMpkkkUgwYsQInnvuOZ544gmEELhFPL9XCEFXVxeNjY3E4/H9crcvpdrb21m/fn04yVRWliuWCcOUfvpY0SWAFIaYUXRugIcSQuA4Dq7rEo/HEUJgWdZ+/Wzf2vYvqw9r6gJxc96cAtsoZWVESjcvoOQ8ZCgYs40ZNvFDenoqgI6NxWJcf/31ZLNZWltb6ezsJJPJdC+iLyU6Ojro7Oxk69atzJkzh7PPPrub+4pFdK018Xicuro6HMfZL2GllGQyGRKJBGPHjg13k+Zmk3ASlsGEQER87tBuoCiLg9DhGjTEYuht2w66bSmlRGvNpz71KZ544gk2btxITU0NDz/8ME8//TS1tbWkUilqamq44447SCaTSCk5+eSTicViRed8rTW2bXPZZZexaNEiampqsG27W+1IKbFtmy1btnDNNddQU1PTbdcE+v2dO01dQBgAOI7JwG5oiBQLCAiAXONFccRIUxYVBgDxOHpHE3pnE2L4iAMaKj6nTZw4kYkTzeHMr7zyCtlstlvHW5bFnDlz+oTo+wPo7Nmzufrqq7nnnnuoq6sjkUh02wd79uzh1FNPZd68eYGNv+4C2pUrTZ5EmIIDrRF2DBGmQDayCgAYNdJMMqih4pdw7dqFXr7ce08FMgZ9v7+9vR0hRHdcIJVK0dnZ2SNY1Jf6XynFrbfeys9+9jMmTpzYHYsYOXIkN910E7/61a9IJpPB9L/PDG1t6DVrjR2gAyMSUinE2LEmKad4EmAvVyVRkYs8BVl8v0r4haXIs/8+kKHji00pJaeddhoLFy5ky5Yt7N69m0svvZSqqiqEEIHFazEkwYUXXshnPvMZ1qxZg+M4jBkzppvwgbnfr6h68UXU1q2IurpwMRalEOPG5baZQ66HHQL65vWIUYhhw01AKJEIBgDXhdpa1EsvodetQ4wfH8hf9Rf6jDPOYOHChTz66KOMHDmSa6+9tvtvwYIsUSTEgVPQfElgWRbHHHNM3qO64XYsPTdO/e73CD+tPIT4x1WIiRMigzkcAJRCVCUR48ejN2wwHkHQSJeXCeTefz/2j38ceDvYtwlmz57N7NmzQ7tjZkFFUSVB/v5AKC/EM4rVosWo5cuhYVjw/RUvuYa6WsTRR/cBAHxCSomYOgWeeSZcwMJ1YcgQ1PN/Ri1ejJwzJ3Ay494h1fzt1wP7rAI2r4X175qeQIHUlTAnhgwfDZOmB5qbiBoXsSxo3oPz03tM3UAYSeXr/+M+hvjIRyLp/wiBIE8vf2Im7n33545XD1OXn0zi3DGf2JjRiAkTA4MgtK73VczWtabhc6I6WMNoKU1h6N+dFAgAkYYfSnccnB//G+xsMjUPYaN5joM88cRcwUmEWED4jCBt2rXJaVNNZ68wN1XKJJI4Ls43vgmbNpnvFzF8Syxumj6HveIVxSO+lxLmzP8B6plnTYl7BOJTXo6cNasHcxbfDfS4XZ57bs9a9jATr61G72gie/U1qBUrciAqQv1795wP1Mp1f1dvFv/n319KdEsLzg9+gHr8T9AwNFpNRWsb4sQTEGPGRBb/0QDgSQF5yimISZPCpTF1g8CFmmp0czPOV67BffjhntnBfn1dfmFolAsgkzbh1aAc4nf/8BtbFHJ/pXI9BLy0cP366zhzr0Q99jgMawhPfAG45rft887PMU5UQzYqAIjHsT57EaTS0dDnuFCVhHgc9ycLyP7L5agnnjQVsH5BRX6jyLCX9PzisR+DyirT7OFgjaCE9ErbgWNO6tnKNdIcvOKQTAa9fDnubbeR/dp16G2NJnQbqSrIMnUV06YiTj+t4N4IhRWHuq4pD1v9nmkHU2BxqO7qQk6cgJgyBXn8dMTYMYjqqtz2swwSJhWmd1B+f96t60xLONcx/f/31xxSSFPyne6Csz+XMwAdxzS0DJp2nelCI0Er9Lr16BUrUG+/g37vPcMsQ2oLs3uEgD3NxP7jXsS0aYeoODTPmFFvvIFz1dW5Xj2Flod3dJrycCFMWbgXWQOCEcFPtHQcrO9+B3nqqeb9bevh8Qcg3QFllT1BIKTpG+hk4OzPw4Sp5lF27cK95RZT/+iXrh1sTRwHrZQ5m0Bpo0rKyozxa9uFdUqLxdCbN2Oddx727bcd4vLwvECG+5Of4D70nzBqVOGt4Hwg+DrUcXr28QnhI+O6xH78I8TpXvfNpi3w2P3Q1W4kget1BFOO6f7xyRzn6z17cL52HXrlKsO1QThW6xxI89XY3nZJlGFZ0NWFqKrC/uUvEEOHFmT89Q4A/K+mUmSvuNLUC0RxaYKEoCMuGKkU9r//W04S7GqE/73P+PoVSXMqmJMxYn/CNI/zd+JcfyN69WpjpUd5nt70ZnyboqnJtIiZMaPX+iPIgiemtenefdttRkx6TZB71YWKcmWzpnCivBzn6zegli4zv1d/hOkQWlltDpFwHZhzWTfxaWnGuf6GHPGz2egeSG8N24ZNm7CuvDJXDt5Lm2C9ACET1BDjxxH70Q+N25XJ9Hnb8/2C03W728w43/gG6qWXzN8aRpnmkJXVcNZnYdLx3To/O+9rxmAbWl94v6PeIv4HHyD/+UKsuV8MXVJXXBWwv42Nxc/gfOtbxgIvL/cyXA7xIlqWsQm6uow68AtUMmnTLhagtRVn3rWo1ath6NDeVWNRAewT/7zzsL//vaK0ku/dbuF5IHDv+L6Zb3WVAQGHAQgyGWhvx779NuQn53R7lHrHDpwbbyqODRNVqgJs3oy84ALsb9+Se6+Xi2Bkry+y4yDnzMa++27TyWtHk0GyPMRiQCmTmdTZid61q2fThrY29KYPjMQ61KXnXt0/27ZhXTkX+7vfyYn8IlRAyaI8gOsipk7F/v8PIE46CRobIePk+ugdCo7SGhobsW+5Bevii03AaONqyGYQEyYQu/deRKLSHOAQpW1Lb8zRsk3QKR7Dnv99rGvm9WybUwxN0xcHRriPPIL65QPmJLDaWsOJfSVm/WYM27dj3fxNrIsuMu+/vRQWPwzTZsLMC02cfvV7OF//Orq1FaqqirtL2S01pQFjezt0pZCnn4Z1zVdMmpfrHZhVTFOjqEfG5Ld027QJZ+FC1J9fMP75kCE5TlNFOoXzw4i/fAk8/1vjBaQ6YPIpMPMiA4JVK8necJORBNXVxQFqfoCoowM6u0ybvC98Afn3Z+/DQP0XAHsZhwB6xQrc3/4WtfRF01DRtk02jA+G3vKlP5Tzl8Bzv4HKGq8DqDYNoY+fBR8/H6RAr15N9us3mIrbmprCQOCLbp/ortvtkWDbiPHjsc4/z3RN8VO7i94Bta8BkE9Y//SwDRtQixahXn8dvX694TjLNuohFsttDYuIpVKuAzuasG++GXnRP+dxvk98v5Tau0dnC0w+FWblJIFzw43o1jbjybgq2jO7rrkyGQMk29RWiMnHIufMRp50cq4fgFKesdx3dlLfHxy5n06fevVq1F//in7/ffT778POneiUF1DaX2fOAz6R99regXXTjTnOf2cpPPvIXsTfi0s72+Cjp8InLgTLQq9ebUCwcxeURyjaBCgrQyQrEePGI8aPR0w5Djl5ci6P35eQh6hF3qE7OlbnNWIWPdWFbt5jmialUibhJMwU/WzZmhrTS7cH51ebk74+LDdQSmhvhqlnwsf/H8TK0Bs3ojdsyDWyDOMSV1ZCZSWivt5L+tyLEfz5DqqjY/dFQm6/v7cXQ2vYuAr++HNIVAXroCEtaN0Jp54LJ3+qd+fjG7uHUUNM+9BPQewbJNq7324k4ptaRrZvNBJGWgFPCdUmhXx3Y8+t3EIMQP/fh9Gp4YcRAAIsXETBAphYv5A5gy/ody37sBDRgxMAvW10druWQaqYJKAOfUi4BIDCTYvutHUn6xFVBfue77qVANCPh29XfGQSnH6+MQJVwNKwVCfUDB0UADgMvIDSOKR8UlqCEgBKowSA0igBoDRKACiNEgBKowSA0igBoDQGzfg/b4mSmGwN8n4AAAAASUVORK5CYII=', 'base64'),
};
app.get('/icons/:name.png', (req, res) => {
    const img = ICONS[req.params.name];
    if (!img) return res.status(404).end();
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' }).send(img);
});

app.get('/', (req, res) => res.send('Bot đang chạy ✅'));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
// Tự truy cập web của chính mình mỗi 5 phút để Render không cho ngủ
let SELF_URL = '';
try { SELF_URL = getPublicBaseUrl(); } catch {}
if (SELF_URL) {
    setInterval(() => {
        fetch(SELF_URL, { signal: AbortSignal.timeout(15000) }).catch(e => console.error('[keep-alive]', e.message));
    }, 5 * 60 * 1000);
}

app.listen(PORT, () => console.log(`\n✅ Web Server: http://localhost:${PORT}`));

// ===== KÊNH BXH XU TUẦN + TỔNG KẾT TỰ ĐỘNG =====
async function getWeeklyLeaderboardChannel(client) {
    const configuredId = process.env.WEEKLY_LEADERBOARD_CHANNEL_ID;
    if (configuredId) {
        try {
            const configured = await client.channels.fetch(configuredId);
            if (configured && configured.type === ChannelType.GuildText) return configured;
        } catch (e) {
            console.error('[weekly] Không lấy được WEEKLY_LEADERBOARD_CHANNEL_ID:', e.message);
        }
    }

    for (const guild of client.guilds.cache.values()) {
        let channel = guild.channels.cache.find(ch => ch.type === ChannelType.GuildText &&
            ['bxhxutuan', 'bxhxu'].includes(String(ch.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')));
        if (channel) return channel;
    }

    // Tự tạo kênh trong server đầu tiên nếu bot có quyền Manage Channels.
    const guild = client.guilds.cache.first();
    if (guild) {
        try {
            return await guild.channels.create({
                name: 'bxh-xu-tuan',
                type: ChannelType.GuildText,
                topic: 'Bảng xếp hạng xu tuần. Chốt và trao thưởng tự động lúc 00:00 thứ Hai (giờ Việt Nam).'
            });
        } catch (e) {
            console.error('[weekly] Không tạo được kênh bxh-xu-tuan. Hãy cấp quyền Quản lý kênh hoặc đặt WEEKLY_LEADERBOARD_CHANNEL_ID:', e.message);
        }
    }
    return null;
}

async function updateWeeklyLeaderboardBoard(client, channel) {
    const weekStart = getWeekStartVNDate();
    const rows = await redis.zrevrange(weeklyLeaderboardKey(weekStart), 0, 5, 'WITHSCORES');
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣'];
    const lines = [];
    for (let i = 0; i < rows.length; i += 2) {
        lines.push(`${medals[i / 2]} **TOP ${i / 2 + 1}** <@${rows[i]}> — **${rows[i + 1]} xu**`);
    }
    const embed = new EmbedBuilder().setColor(0xffc107).setTitle('🏆 BXH XU TUẦN')
        .setDescription(lines.length ? lines.join('\n') : 'Chưa có ai tích lũy xu trong tuần này.')
        .addFields({ name: 'Thời gian', value: `${formatWeekRange(weekStart)}\nTổng kết: 00:00 thứ Hai` })
        .setFooter({ text: 'Top 1–6 • Cập nhật tự động mỗi 5 phút' });
    const messageKey = `weekly_board_message:${channel.id}`;
    const savedId = await redis.get(messageKey);
    if (savedId) {
        try {
            const oldMessage = await channel.messages.fetch(savedId);
            await oldMessage.edit({ embeds: [embed], allowedMentions: { parse: [] } });
            return;
        } catch {}
    }
    const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    await redis.set(messageKey, message.id);
}

const WEEKLY_SETTLE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
    return redis.call('GET', KEYS[1])
end
local awards = cjson.decode(ARGV[1])
for i = 1, #awards do
    local item = awards[i]
    if tonumber(item.reward) and tonumber(item.reward) > 0 then
        redis.call('INCRBY', 'coins_' .. item.userId, tonumber(item.reward))
    end
end
redis.call('SET', KEYS[1], ARGV[1])
return ARGV[1]
`;

async function settlePreviousWeek(client, channel) {
    const previousWeek = getWeekStartVNDate(1);
    const awardKey = `weekly_awarded:${previousWeek}`;
    let saved = await redis.get(awardKey);
    if (!saved) {
        const rows = await redis.zrevrange(weeklyLeaderboardKey(previousWeek), 0, 5, 'WITHSCORES');
        if (!rows.length) return;
        const rewards = weeklyRewards();
        const awards = [];
        for (let i = 0; i < rows.length; i += 2) {
            const rank = i / 2 + 1;
            const reward = rewards[rank - 1] || 0;
            awards.push({ rank, userId: rows[i], score: Number(rows[i + 1]) || 0, reward });
        }
        saved = await redis.eval(WEEKLY_SETTLE_LUA, 1, awardKey, JSON.stringify(awards));
    }

    let awards;
    try { awards = JSON.parse(saved); } catch { awards = []; }
    if (!Array.isArray(awards) || !awards.length) return;

    const sentKey = `weekly_announcement_sent:${previousWeek}:${channel.id}`;
    if (await redis.exists(sentKey)) return;
    const lockKey = `weekly_announcement_lock:${previousWeek}:${channel.id}`;
    const lock = await redis.set(lockKey, '1', 'EX', 90, 'NX');
    if (!lock) return;

    try {
        const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣'];
        const lines = awards.map(item =>
            `${medals[item.rank - 1]} **TOP ${item.rank}** <@${item.userId}> — tích lũy **${item.score} xu**, nhận thưởng **+${item.reward} xu**`
        );
        const mentions = awards.map(item => `<@${item.userId}>`).join(' ');
        const embed = new EmbedBuilder().setColor(0x2ecc71).setTitle('🎉 TỔNG KẾT BXH XU TUẦN')
            .setDescription(`Tuần ${formatWeekRange(previousWeek)}\n\n${lines.join('\n')}`)
            .setFooter({ text: 'Phần thưởng đã được cộng tự động vào số dư.' });
        await channel.send({ content: `🏆 Chúc mừng các thành viên đạt TOP 1–6!\n${mentions}`, embeds: [embed],
            allowedMentions: { users: awards.map(item => item.userId) } });
        await redis.set(sentKey, '1');
    } finally {
        await redis.del(lockKey);
    }
}

async function runWeeklyLeaderboard(client) {
    try {
        const channel = await getWeeklyLeaderboardChannel(client);
        if (!channel) return console.warn('[weekly] Chưa có kênh BXH tuần; tạo kênh bxh-xu-tuan hoặc đặt WEEKLY_LEADERBOARD_CHANNEL_ID.');
        // Trao thưởng tuần đã kết thúc (chạy bù nếu bot từng ngoại tuyến).
        await settlePreviousWeek(client, channel);
        await updateWeeklyLeaderboardBoard(client, channel);
    } catch (e) {
        console.error('[weekly] Lỗi cập nhật/tổng kết BXH:', e);
    }
}

async function startWeeklyLeaderboard(client, botId) {
    // Chỉ bot chính xử lý lịch tuần để tránh nhiều bot cộng thưởng trùng.
    if (botId !== 'main' || client._weeklyLeaderboardTimer) return;
    await runWeeklyLeaderboard(client);
    client._weeklyLeaderboardTimer = setInterval(() => runWeeklyLeaderboard(client), 5 * 60 * 1000);
}

// DISCORD BOT
async function onReady(client, token, botId) {
    const commands = [
        new SlashCommandBuilder().setName('getlink').setDescription('Lấy link nhiệm vụ nhận 50 xu (2 lần/ngày)').addStringOption(opt => opt.setName('provider').setDescription('Dịch vụ').addChoices({ name: 'Link4M', value: 'link4m' }, { name: 'LayMa', value: 'layma' }).setRequired(false)),
        new SlashCommandBuilder().setName('vi').setDescription('Xem số dư xu'),
        new SlashCommandBuilder().setName('reg').setDescription('Chọn loại cloud và lấy tài khoản (10 xu)'),
        new SlashCommandBuilder().setName('buycloud').setDescription('Mua cloud phone: nhập email|mật khẩu'),
        new SlashCommandBuilder().setName('daily').setDescription('Điểm danh nhận 20 xu'),
        new SlashCommandBuilder().setName('ketnoi').setDescription('Liên kết tài khoản Dashboard web với Discord của bạn')
            .addStringOption(o => o.setName('token').setDescription('Token lấy ở Dashboard > Cài đặt').setRequired(true).setMaxLength(40)),
        new SlashCommandBuilder().setName('ngatketnoi').setDescription('Hủy mọi liên kết Dashboard web đang gắn với Discord của bạn'),
        new SlashCommandBuilder().setName('youtube').setDescription('Đăng ký kênh YouTube nhận xu mỗi ngày'),
        new SlashCommandBuilder().setName('testwelcome').setDescription('Gửi thử lời chào mừng vào kênh welcome (Admin)'),
        new SlashCommandBuilder().setName('nhiemvu').setDescription('Đăng bảng nhiệm vụ nhận xu vào kênh này (Admin)'),
        new SlashCommandBuilder().setName('clearall').setDescription('Xóa toàn bộ tin nhắn trong kênh, trừ tin ghim và bảng nhiệm vụ (Admin)'),
        new SlashCommandBuilder().setName('tangqua').setDescription('Tặng xu cho người đạt top (Admin)')
            .addUserOption(o => o.setName('nguoi').setDescription('Người nhận quà').setRequired(true))
            .addIntegerOption(o => o.setName('top').setDescription('Hạng của người đó (1 đến 6)').setRequired(true).setMinValue(1).setMaxValue(6)),
        new SlashCommandBuilder().setName('top').setDescription('BXH kiếm xu').addIntegerOption(o => o.setName('limit').setDescription('Số người').setMinValue(1).setMaxValue(25).setRequired(false)),
        new SlashCommandBuilder().setName('top-tuan').setDescription('BXH kiếm xu trong tuần hiện tại (top 1–6)'),
        new SlashCommandBuilder().setName('transfer').setDescription('Chuyển xu (phí 5%)').addUserOption(o => o.setName('target').setDescription('Người nhận').setRequired(true)).addIntegerOption(o => o.setName('amount').setDescription('Số xu').setRequired(true).setMinValue(10).setMaxValue(1000000)),
        new SlashCommandBuilder().setName('code').setDescription('Nhập Gift Code').addStringOption(o => o.setName('gift_code').setDescription('Mã').setMinLength(8).setMaxLength(32).setRequired(true)),
        new SlashCommandBuilder().setName('gen').setDescription('Tạo Gift Code (Admin)').addIntegerOption(o => o.setName('soluong').setDescription('Số lượng (tối đa 100)').setMinValue(1).setMaxValue(100).setRequired(true)).addIntegerOption(o => o.setName('xuthuong').setDescription('Số xu mỗi code').setMinValue(1).setMaxValue(1000000).setRequired(true)),
        new SlashCommandBuilder().setName('clear').setDescription('Xóa tin nhắn bot (Admin)'),
        new SlashCommandBuilder().setName('capquyenadmin').setDescription('Cấp quyền Admin').addUserOption(o => o.setName('target').setDescription('User').setRequired(true)),
        new SlashCommandBuilder().setName('thuquyenadmin').setDescription('Thu hồi quyền Admin').addUserOption(o => o.setName('target').setDescription('User').setRequired(true)),
        new SlashCommandBuilder().setName('xoatk').setDescription('Xóa data user (Admin)').addUserOption(o => o.setName('target').setDescription('User').setRequired(true))
    ].map(c => c.toJSON());

    try {
        const rest = new REST({ version: '10' }).setToken(token);
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log(`✅ Bot online: ${client.user.tag}`);
        console.log(`✅ Đã đăng ký ${commands.length} lệnh Slash!`);
    } catch (error) {
        console.error('Lỗi đăng ký lệnh:', error);
    }
    await ensureCloudEmojis(client);
    await startWeeklyLeaderboard(client, botId);
}

async function onInteraction(interaction) {
    try {
        await handleInteraction(interaction);
    } catch (error) {
        console.error('[interaction]', error);
        const msg = { content: '❌ Có lỗi xảy ra, thử lại sau.', flags: MessageFlags.Ephemeral };
        try {
            if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg.content });
            else await interaction.reply(msg);
        } catch {}
    }
}

// ===== /reg: CHỌN HÃNG CLOUD =====
// Ảnh logo được nhúng trong code và phục vụ ở /icons/<tên>.png
function iconUrl(name) {
    const base = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_DOMAIN || '';
    return base.startsWith('https://') ? `${base.replace(/\/+$/, '')}/icons/${name}.png?v=2` : undefined;
}
// Avatar mỗi hãng: đặt link ảnh vào biến ICON_VMOS, ICON_VSPHONE, ICON_UGPHONE (Render > Environment)
const CLOUD_PROVIDERS = {
    vmos:    { name: 'VMOS Cloud', emoji: '☁️', color: 0x2f6bff, icon: process.env.ICON_VMOS    || iconUrl('vmos'),    ready: true },
    vsphone: { name: 'VSPhone',    emoji: '🟠', color: 0xff9f1a, icon: process.env.ICON_VSPHONE || iconUrl('vsphone'), ready: true },
    ugphone: { name: 'UGPhone',    emoji: '🔴', color: 0xff5a4f, icon: process.env.ICON_UGPHONE || iconUrl('ugphone'), ready: false },
};
// Tạo emoji ứng dụng từ logo để hiện ảnh trong ô chọn (mỗi bot có bộ emoji riêng)
async function ensureCloudEmojis(client) {
    client.cloudEmojis = {};
    try {
        if (!client.application || !client.application.emojis || typeof client.application.emojis.create !== 'function') {
            return console.error('[emoji] Phiên bản discord.js chưa hỗ trợ emoji ứng dụng, menu dùng biểu tượng thường.');
        }
        const existing = await client.application.emojis.fetch();
        for (const key of Object.keys(ICONS)) {
            const name = `cloud_${key}_1`;
            let e = existing.find(x => x.name === name);
            if (!e) e = await client.application.emojis.create({ attachment: ICONS[key], name });
            client.cloudEmojis[key] = { id: e.id, name: e.name };
        }
        console.log('✅ Đã nạp emoji logo cho menu /reg');
    } catch (err) {
        console.error('[emoji] Không tạo được emoji logo:', err.message);
    }
}
const hasIcon = p => typeof p.icon === 'string' && p.icon.startsWith('http');
function providerAuthor(p) { return hasIcon(p) ? { name: p.name, iconURL: p.icon } : { name: `${p.emoji} ${p.name}` }; }
function inRegChannel(interaction) {
    let ch = interaction.channel;
    if (ch && typeof ch.isThread === 'function' && ch.isThread()) ch = ch.parent;
    const cat = String((ch && ch.parent && ch.parent.name) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return cat.includes('cloudphone');
}
const REG_DENY = '❌ Lệnh `/reg` chỉ dùng được trong các kênh thuộc danh mục **cloudphone**.';
function regEmbeds() {
    const embed = new EmbedBuilder()
        .setColor(0x19b9f2)
        .setTitle('📋 Reg Panel')
        .setDescription('Chọn dịch vụ bên dưới để tạo tài khoản nhanh gọn.\n\n**Dịch vụ cloud**\n• 🌐 VMOS Cloud — Đang hoạt động\n• 🟠 VSPhone — Đang hoạt động\n• 🔴 UGPhone — Sắp có\n\n*Panel chỉ dùng được bởi người đã mở lệnh.*')

        .setFooter({ text: 'Kasumi Bot • Reg System' });
    return [embed];
}
function regMenu(client) {
    const emojiFor = (key, fallback) => (client && client.cloudEmojis && client.cloudEmojis[key]) || fallback;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('regprovider:vmos').setLabel('VMOS Cloud').setEmoji(emojiFor('vmos', '🌐')).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('regprovider:vsphone').setLabel('VSPhone').setEmoji(emojiFor('vsphone', '🟠')).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('regprovider:ugphone').setLabel('UGPhone • Sắp có').setEmoji(emojiFor('ugphone', '🔴')).setStyle(ButtonStyle.Secondary)
    );
}
async function handleRegProvider(interaction, providerKey) {
    if (!inRegChannel(interaction)) return interaction.update({ content: REG_DENY, embeds: [], components: [] });
    const prov = CLOUD_PROVIDERS[providerKey];
    if (!prov) return interaction.update({ content: '❌ Lựa chọn không hợp lệ.', embeds: regEmbeds(), components: [regMenu(interaction.client)] });
    if (!prov.ready) return interaction.update({ content: `⏳ ${prov.name} sắp có, bạn chọn loại khác nhé.`, embeds: regEmbeds(), components: [regMenu(interaction.client)] });
    await interaction.deferUpdate();
    const userId = interaction.user.id;
    let charged = false;
    try {
        const remaining = await redis.decrby(`coins_${userId}`, 10);
        if (remaining < 0) {
            await redis.incrby(`coins_${userId}`, 10);
            return interaction.editReply({ content: '❌ Không đủ 10 xu.', embeds: regEmbeds(), components: [regMenu(interaction.client)] });
        }
        charged = true;
        let mail, pass, code;
        if (providerKey === 'vsphone') {
            const vsUrl = String(process.env.VSPHONE_API_URL || 'https://vsphone-production.up.railway.app').replace(/\/+$/, '');
            const vsKey = process.env.VSPHONE_API_KEY || '';
            const response = await fetch(`${vsUrl}/register`, { headers: { 'x-api-key': vsKey }, signal: AbortSignal.timeout(30000) });
            const data = await response.json();
            if (!response.ok || !data.ok || !data.account) throw new Error(data.error || `VSPhone API lỗi (HTTP ${response.status}).`);
            [mail = 'Không có', pass = 'Không có'] = data.account.split('|');
            code = null;
        } else {
            if (!process.env.APIKEY) throw new Error('Chưa cấu hình APIKEY để lấy tài khoản VMOS.');
            const response = await fetch('https://wxygtmfttyidwnhjdwdw.supabase.co/functions/v1/get-key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': process.env.APIKEY }, body: JSON.stringify({ clientId: crypto.randomUUID() }), signal: AbortSignal.timeout(15000) });
            const data = await response.json();
            if (!response.ok || !data.content) throw new Error(data.message || `Lỗi lấy dữ liệu VMOS (HTTP ${response.status}).`);
            [mail = 'Không có', pass = 'Không có', code = 'Không có'] = data.content.split('|');
        }
        if (!mail || !pass || mail === 'Không có' || pass === 'Không có') throw new Error('API trả về tài khoản không đúng định dạng.');
        const fields = [{ name: '📧 Tài khoản', value: `\`${mail}\`` }, { name: '🔑 Mật khẩu', value: `\`${pass}\`` }];
        if (code) fields.push({ name: '🎁 Mã mời', value: `\`${code}\`` });
        fields.push({ name: '💡 Mẹo', value: 'Bấm **📋 Sao chép**, nhấn giữ tin nhắn hiện ra rồi chọn **Sao chép văn bản**. Dán vào `/buycloud`, hoặc bấm **🛒 Mua ngay**.' });
        const embed = new EmbedBuilder().setColor(prov.color).setAuthor(providerAuthor(prov)).setTitle('Lấy tài khoản thành công')
            .addFields(...fields)
            .setFooter({ text: `Đã trừ 10 xu, số dư còn lại ${remaining} xu` });
        if (hasIcon(prov)) embed.setThumbnail(prov.icon);
        const copyId = crypto.randomBytes(6).toString('hex');
        await redis.set(`regcopy_${copyId}`, JSON.stringify({ userId, provider: providerKey, text: `${mail}|${pass}` }), 'EX', 1800);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`regcopy:${copyId}`).setLabel('Sao chép').setEmoji('📋').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`regbuy:${copyId}`).setLabel('Mua ngay').setEmoji('🛒').setStyle(ButtonStyle.Success)
        );
        await interaction.editReply({ content: null, embeds: [embed], components: [row] });
        charged = false; // tài khoản đã trả về thành công, giữ khoản trừ 10 xu
    } catch (error) {
        if (charged) await redis.incrby(`coins_${userId}`, 10).catch(e => console.error('[reg] Không hoàn được xu:', e.message));
        await interaction.editReply({ content: `❌ ${error.message}`, embeds: regEmbeds(), components: [regMenu(interaction.client)] });
    }
}

// Lấy địa chỉ IP mà máy chủ dùng khi gọi ra ngoài (để gửi cho bên API cho phép)
async function getPublicIp() {
    for (const url of ['https://api.ipify.org?format=json', 'https://ifconfig.me/ip']) {
        try {
            const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
            const t = (await r.text()).trim();
            let ip = t;
            try { ip = JSON.parse(t).ip || t; } catch {}
            if (/^[0-9a-fA-F.:]{3,45}$/.test(ip)) return ip;
        } catch {}
    }
    return null;
}

// Gọi LayMa kèm tiêu đề giống trình duyệt (Link4M chạy được nhờ có User-Agent); lỗi HTML thì báo rõ và ghi log
async function fetchLayma(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36', 'Accept': 'application/json, text/plain, */*' },
        signal: AbortSignal.timeout(15000)
    });
    const text = await res.text();
    console.log(`[LayMa] HTTP ${res.status}`, text.replace(/\s+/g, ' ').slice(0, 200));
    try { return JSON.parse(text); }
    catch {
        const title = ((text.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim().slice(0, 80);
        const blocked = /just a moment|cloudflare|attention required|access denied/i.test(text);
        throw new Error(blocked
            ? `LayMa đang chặn IP máy chủ (Cloudflare, HTTP ${res.status}). Cần nhờ LayMa mở IP.`
            : `LayMa trả về trang lỗi (HTTP ${res.status})${title ? `: ${title}` : ''}. Kiểm tra LAYMA_TOKEN.`);
    }
}

// ===== /buycloud: chọn loại cloud rồi nhập email|matkhau =====
const BUY_TYPES = { vmos: { id: 'VM', provider: 'vmos' }, vsphone: { id: 'VS', provider: 'vsphone' } };
function buyMenu(client) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('buycloud_select').setPlaceholder('Chọn loại cloud').addOptions(
            Object.entries(BUY_TYPES).map(([key, t]) => ({ label: CLOUD_PROVIDERS[t.provider].name, value: key, emoji: (client && client.cloudEmojis && client.cloudEmojis[key]) || CLOUD_PROVIDERS[t.provider].emoji }))
        )
    );
}
async function showBuyModal(interaction) {
    const t = BUY_TYPES[interaction.values[0]];
    if (!t) return interaction.update({ content: '❌ Lựa chọn không hợp lệ.', components: [buyMenu(interaction.client)] });
    const name = CLOUD_PROVIDERS[t.provider].name;
    const modal = new ModalBuilder().setCustomId(`buycloud_modal:${t.id}`).setTitle(`Mua ${name}`.slice(0, 45));
    const input = new TextInputBuilder().setCustomId('info').setLabel('Nhập: email|matkhau').setPlaceholder('email@gmail.com|matkhau').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(300);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
}

// Tạo link rút gọn bằng Link4M
async function makeLink4m(targetUrl) {
    const apiKey = String(process.env.LINK4M_API_KEY || '').trim();
    if (!apiKey) throw new Error('Chưa cấu hình LINK4M_API_KEY.');
    const endpoint = new URL('https://link4m.co/api-shorten/v2');
    endpoint.searchParams.set('api', apiKey);
    endpoint.searchParams.set('url', targetUrl);
    const res = await fetch(endpoint, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    let data;
    try { data = await res.json(); } catch { throw new Error(`Link4M trả về dữ liệu không hợp lệ (HTTP ${res.status}).`); }
    if (res.ok && data.status === 'success' && data.shortenedUrl) return data.shortenedUrl;
    throw new Error(data.message || `Link4M không tạo được link (HTTP ${res.status}).`);
}

// Nút trong khung kết quả /reg: Sao chép (email|mk) và Mua ngay (mở form /buycloud điền sẵn)
async function handleRegButton(interaction) {
    const [action, id] = interaction.customId.split(':');
    if (action === 'regprovider') return handleRegProvider(interaction, id);
    if (action !== 'regcopy' && action !== 'regbuy') return;
    const raw = await redis.get(`regcopy_${id}`);
    if (!raw) return interaction.reply({ content: '⏳ Dữ liệu đã hết hạn (quá 30 phút), hãy lấy tài khoản mới bằng /reg.', flags: MessageFlags.Ephemeral });
    const data = JSON.parse(raw);
    if (data.userId !== interaction.user.id) return interaction.reply({ content: '❌ Đây không phải tài khoản của bạn.', flags: MessageFlags.Ephemeral });
    if (action === 'regcopy') {
        // chỉ có đúng chuỗi email|mk để nhấn giữ và chọn "Sao chép văn bản" cho gọn
        return interaction.reply({ content: data.text, flags: MessageFlags.Ephemeral });
    }
    const cloudId = data.provider === 'vsphone' ? 'VS' : 'VM';
    const cloudName = cloudId === 'VS' ? 'VSPhone' : 'VMOS Cloud';
    const modal = new ModalBuilder().setCustomId(`buycloud_modal:${cloudId}`).setTitle(`Mua ${cloudName}`.slice(0, 45));
    const input = new TextInputBuilder().setCustomId('info').setLabel('Nhập: email|matkhau').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(300).setValue(data.text.slice(0, 300));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
}

// ===== /youtube: đăng ký kênh YouTube nhận xu, 1 lần mỗi ngày =====
const ytReward = () => Math.max(1, Math.min(1000000, Number.parseInt(process.env.YT_REWARD || '30', 10) || 30));
async function handleYoutubeClaim(interaction) {
    const startedAt = parseInt(interaction.customId.split(':')[1]) || 0;
    const age = Date.now() - startedAt;
    if (age < 15000) return interaction.reply({ content: '⏳ Bạn hãy mở kênh và đăng ký trước, rồi quay lại bấm nút này nhé.', flags: MessageFlags.Ephemeral });
    if (age > 30 * 60 * 1000) return interaction.reply({ content: '⌛ Nút này đã hết hạn, hãy gõ lại /youtube.', flags: MessageFlags.Ephemeral });
    const userId = interaction.user.id;
    const reward = ytReward();
    const ok = await claimEarnedCoinsOnce(`yt_${userId}_${getTodayString()}`, userId, reward, secondsUntilVnMidnight());
    if (!ok) return interaction.reply({ content: '⏳ Hôm nay bạn đã nhận rồi, mai quay lại nhé.', flags: MessageFlags.Ephemeral });
    return interaction.update({ content: `✅ Nhận thành công **+${reward} xu**! Cảm ơn bạn đã đăng ký kênh.`, embeds: [], components: [] });
}

// ===== KÊNH NHIỆM VỤ NHẬN XU =====
// Chỉ dùng được trong kênh tên "nhiem-vu-nhan-xu" (hoặc kênh có ID trong biến MISSION_CHANNEL_ID)
function inMissionChannel(interaction) {
    let channel = interaction.channel;
    if (channel && typeof channel.isThread === 'function' && channel.isThread()) channel = channel.parent;
    if (process.env.MISSION_CHANNEL_ID) return !!channel && channel.id === process.env.MISSION_CHANNEL_ID;
    const name = String((channel && channel.name) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return name.includes('nhiemvunhanxu');
}
const MISSION_DENY = '❌ Chỉ dùng được trong kênh **#nhiem-vu-nhan-xu**.';

async function runGetLink(interaction, provider) {
    if (!['link4m', 'layma'].includes(provider)) {
        return interaction.reply({ content: '❌ Nhà cung cấp link không hợp lệ.', flags: MessageFlags.Ephemeral });
    }
    const userId = interaction.user.id;
    const limitKey = `limit_${userId}_${provider}_${getTodayString()}`;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let used = 0;
    let sessionId = null;
    try {
        used = await redis.incr(limitKey);
        await redis.expire(limitKey, secondsUntilVnMidnight());
        if (used > 2) {
            await redis.decr(limitKey);
            used = 0;
            return interaction.editReply({ content: `❌ Đã đạt giới hạn 2 lần/ngày cho ${provider}.` });
        }

        sessionId = crypto.randomBytes(16).toString('hex');
        const targetUrl = `${getPublicBaseUrl()}/redeem?sid=${sessionId}`;
        let finalUrl = '';
        let usedProvider = provider;
        let fallbackNote = '';
        if (provider === 'link4m') {
            finalUrl = await makeLink4m(targetUrl);
        } else {
            try {
                const token = String(process.env.LAYMA_TOKEN || '').trim();
                if (!token) throw new Error('Chưa cấu hình LAYMA_TOKEN.');
                const data = await fetchLayma(`https://api.layma.net/api/admin/shortlink/quicklink?tokenUser=${encodeURIComponent(token)}&format=json&url=${encodeURIComponent(targetUrl)}`);
                if (data.success === true && data.html) finalUrl = data.html;
                else throw new Error("Lỗi từ LayMa" + (data.message ? `: ${data.message}` : ''));
            } catch (layErr) {
                console.log('[getlink] LayMa lỗi, dùng Link4M thay thế:', layErr.message);
                finalUrl = await makeLink4m(targetUrl);
                usedProvider = 'link4m';
                fallbackNote = '\n⚠️ LayMa đang lỗi nên bot dùng **Link4M** thay thế.';
            }
        }
        if (!/^https:\/\//i.test(finalUrl)) throw new Error('Nhà cung cấp trả về đường dẫn không hợp lệ.');
        await redis.set(`session_${sessionId}`, JSON.stringify({ userId, provider: usedProvider }), 'EX', 300);
        const remaining = 2 - used;
        const embed = new EmbedBuilder().setColor(usedProvider === 'link4m' ? 0xffc107 : 0x8b5cf6)
            .setTitle(`🔗 LINK NHẬN XU (${usedProvider.toUpperCase()})`)
            .setDescription(`Bấm link nhận **50 xu**. Còn **${remaining}** lượt.${fallbackNote}`)
            .addFields({ name: 'Link', value: finalUrl });
        await interaction.editReply({ embeds: [embed] });
    } catch (e) {
        if (sessionId) await redis.del(`session_${sessionId}`).catch(() => {});
        if (used > 0) await redis.decr(limitKey).catch(() => {});
        await interaction.editReply({ content: `❌ ${e.message}` });
    }
}

async function runYoutube(interaction) {
    const userId = interaction.user.id;
    const url = process.env.YOUTUBE_URL;
    if (!url || !url.startsWith('http')) return interaction.reply({ content: '❌ Chưa cấu hình link YouTube (biến YOUTUBE_URL).', flags: MessageFlags.Ephemeral });
    const key = `yt_${userId}_${getTodayString()}`;
    if (await redis.exists(key)) {
        const left = await redis.ttl(key);
        return interaction.reply({ content: `⏳ Hôm nay bạn đã nhận rồi. Quay lại sau ${Math.floor(left / 3600)}h ${Math.floor((left % 3600) / 60)}m.`, flags: MessageFlags.Ephemeral });
    }
    const embed = new EmbedBuilder().setColor(0xff0033).setTitle('🎬 Đăng ký kênh YouTube nhận xu')
        .setDescription(`1. Bấm **Mở kênh YouTube** và đăng ký kênh.\n2. Quay lại đây, bấm **Tôi đã đăng ký** để nhận **${ytReward()} xu**.\nMỗi ngày nhận 1 lần.`);
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Mở kênh YouTube').setStyle(ButtonStyle.Link).setURL(url),
        new ButtonBuilder().setCustomId(`ytclaim:${Date.now()}`).setLabel('Tôi đã đăng ký').setEmoji('✅').setStyle(ButtonStyle.Success)
    );
    return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

function missionPanel() {
    const embed = new EmbedBuilder().setColor(0xffc107).setTitle('🎯 NHIỆM VỤ NHẬN XU')
        .setDescription('Chọn một nhiệm vụ bên dưới để nhận xu:\n\n🔗 **Link4M**: vượt link nhận **50 xu** (2 lần/ngày)\n🔗 **LayMa**: vượt link lấy mã nhận **50 xu** (2 lần/ngày)\n🎬 **YouTube**: đăng ký kênh nhận **' + ytReward() + ' xu** (1 lần/ngày)');
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('mission:link4m').setLabel('Nhiệm vụ Link4M').setEmoji('🔗').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('mission:layma').setLabel('Nhiệm vụ LayMa').setEmoji('🔑').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('mission:youtube').setLabel('Nhiệm vụ YouTube').setEmoji('🎬').setStyle(ButtonStyle.Danger)
    );
    return { embeds: [embed], components: [row] };
}
async function handleMissionButton(interaction) {
    if (!inMissionChannel(interaction)) return interaction.reply({ content: MISSION_DENY, flags: MessageFlags.Ephemeral });
    const kind = interaction.customId.split(':')[1];
    if (kind === 'youtube') return runYoutube(interaction);
    if (kind === 'link4m' || kind === 'layma') return runGetLink(interaction, kind);
    return interaction.reply({ content: '❌ Nhiệm vụ không hợp lệ.', flags: MessageFlags.Ephemeral });
}

// ===== /clearall: xóa hết tin nhắn trong kênh (có xác nhận) =====
const keepMsg = m => m.pinned || m.components.some(r => (r.components || []).some(c => String(c.customId || '').startsWith('mission:')));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wipeChannel(channel) {
    const startedAt = Date.now();
    let total = 0, singles = 0;
    for (let round = 0; round < 80 && Date.now() - startedAt < 12 * 60 * 1000; round++) {
        const msgs = await channel.messages.fetch({ limit: 100 });
        const targets = msgs.filter(m => !keepMsg(m));
        if (targets.size === 0) break;
        const deleted = await channel.bulkDelete(targets, true); // Discord chỉ cho xóa hàng loạt tin dưới 14 ngày
        total += deleted.size;
        if (deleted.size === 0) {
            // còn lại tin quá 14 ngày: xóa từng tin (chậm), tối đa 100 tin mỗi lần chạy
            for (const m of targets.values()) {
                if (singles >= 100) return { total, more: true };
                try { await m.delete(); total++; } catch {}
                singles++;
                await sleep(1100);
            }
        }
    }
    return { total, more: false };
}

async function handleClearAll(interaction) {
    const [action, channelId, ts] = interaction.customId.split(':');
    if (!(await getAdminIds()).includes(interaction.user.id)) return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
    if (action === 'clearall_cancel') return interaction.update({ content: 'Đã hủy, không xóa gì cả.', components: [] });
    if (interaction.channelId !== channelId || Date.now() - parseInt(ts) > 60000) {
        return interaction.update({ content: '⌛ Yêu cầu đã hết hạn, hãy gõ lại /clearall.', components: [] });
    }
    await interaction.update({ content: '⏳ Đang xóa tin nhắn, vui lòng chờ...', components: [] });
    try {
        const r = await wipeChannel(interaction.channel);
        await interaction.editReply({ content: `✅ Đã xóa **${r.total}** tin nhắn.${r.more ? ' Còn tin cũ hơn 14 ngày, gõ /clearall lần nữa để xóa tiếp.' : ''}` });
    } catch (e) {
        await interaction.editReply({ content: e.code === 50013 ? '❌ Bot thiếu quyền **Quản lý tin nhắn** hoặc **Xem lịch sử tin nhắn** trong kênh này.' : `❌ ${e.message}` });
    }
}

async function handleBuyCloud(interaction) {
    const cloudId = interaction.customId.split(':')[1];
    if (cloudId !== 'VM' && cloudId !== 'VS') return interaction.reply({ content: '❌ Loại cloud không hợp lệ.', flags: MessageFlags.Ephemeral });
    const raw = interaction.fields.getTextInputValue('info').trim();
    const i = raw.indexOf('|');
    const account = i > 0 ? raw.slice(0, i).trim() : '';
    const password = i > 0 ? raw.slice(i + 1).trim() : '';
    if (!account || !password || raw.length > 300) {
        return interaction.reply({ content: '❌ Sai định dạng. Nhập theo mẫu: `email|matkhau` (ngăn cách bằng dấu `|`).', flags: MessageFlags.Ephemeral });
    }
    if (!process.env.HANAMI_TOKEN) {
        return interaction.reply({ content: '❌ Bot chưa cấu hình token mua cloud (HANAMI_TOKEN).', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userId = interaction.user.id;
    const cost = parseInt(process.env.BUYCLOUD_COST || '0') || 0;
    if (cost > 0) {
        const left = await redis.decrby(`coins_${userId}`, cost);
        if (left < 0) {
            await redis.incrby(`coins_${userId}`, cost);
            return interaction.editReply({ content: `❌ Không đủ ${cost} xu.` });
        }
    }
    let result;
    try {
        const res = await fetch('https://hanaminikata.com/dev/buy_device_cloud', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' },
            body: JSON.stringify({ token: process.env.HANAMI_TOKEN, cloud_id: cloudId, input_data: `${account}|${password}` }),
            signal: AbortSignal.timeout(60000)
        });
        const text = await res.text();
        console.log('[buycloud]', userId, account, res.status, text.slice(0, 300));
        if (res.status === 403) console.log('[buycloud] IP máy chủ gọi ra ngoài:', await getPublicIp());
        try { result = JSON.parse(text); }
        catch { result = { code: -1, message: `Máy chủ mua cloud trả về lỗi (HTTP ${res.status}).` }; }
    } catch (e) {
        const reason = (e && e.name === 'TimeoutError') ? 'quá thời gian chờ 60 giây' : String((e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || 'không rõ');
        console.error('[buycloud] lỗi kết nối:', reason, '|', e && e.message);
        result = { code: -1, message: `Không kết nối được tới máy chủ mua cloud (${reason}).` };
    }
    const ok = !!result && result.code === 0;
    const message = String((result && result.message) || 'Có lỗi xảy ra.');
    if (!ok && cost > 0) await redis.incrby(`coins_${userId}`, cost); // hoàn xu
    await redis.rpush('buycloud_orders', JSON.stringify({ userId, cloudId, account, ok, message, at: Date.now() }));
    await redis.ltrim('buycloud_orders', -1000, -1);
    for (const id of await getAdminIds()) {
        try {
            const admin = await interaction.client.users.fetch(id);
            await admin.send(`🛒 Buycloud ${cloudId}: <@${userId}> | \`${account}\` | ${ok ? 'thành công' : 'lỗi'}: ${message}`);
        } catch {}
    }
    await interaction.editReply({ content: ok ? message : `❌ ${message}` });
}

async function handleInteraction(interaction) {
    if (interaction.isButton() && interaction.customId.startsWith('clearall')) return handleClearAll(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('mission:')) return handleMissionButton(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('ytclaim:')) return handleYoutubeClaim(interaction);
    if (interaction.isButton()) return handleRegButton(interaction);
    if (interaction.isStringSelectMenu() && interaction.customId === 'buycloud_select') return showBuyModal(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith('buycloud_modal:')) return handleBuyCloud(interaction);
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'buycloud') {
        return interaction.reply({ content: '**Chọn loại cloud bạn muốn mua:**', components: [buyMenu(interaction.client)], flags: MessageFlags.Ephemeral });
    }
    if (interaction.commandName === 'ketnoi') {
        const uid = interaction.user.id;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tries = await redis.incr(`ketnoi_try_${uid}`);
        if (tries === 1) await redis.expire(`ketnoi_try_${uid}`, 600);
        if (tries > 10) return interaction.editReply('⛔ Bạn thử quá nhiều lần. Đợi 10 phút rồi thử lại.');
        const norm = String(interaction.options.getString('token') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!/^NGA[A-Z0-9]{12}$/.test(norm)) return interaction.editReply('❌ Token không đúng định dạng. Token có dạng `NGA-XXXX-XXXX-XXXX`, lấy ở Dashboard > Cài đặt.');
        const webId = await redis.eval("local v=redis.call('GET',KEYS[1]); if v then redis.call('DEL',KEYS[1]) end return v", 1, `ketnoi_tok_${norm}`);
        if (!webId || !/^[a-f0-9]{16}$/.test(webId)) return interaction.editReply('❌ Token sai, đã dùng hoặc đã hết hạn. Vào Dashboard > Cài đặt bấm **Tạo token mới**.');
        await redis.del(`webtok_${webId}`);
        await redis.set(`webacct_${webId}`, JSON.stringify({
            discordId: uid,
            name: interaction.user.globalName || interaction.user.username,
            avatar: interaction.user.displayAvatarURL({ extension: 'png', size: 64 }),
            at: Date.now()
        }));
        await redis.sadd(`discord_webs_${uid}`, webId);
        await redis.del(`ketnoi_try_${uid}`);
        return interaction.editReply('✅ **Liên kết thành công!** Quay lại Dashboard, trang sẽ tự mở Ví xu và Cloud Phone.\nNếu không phải bạn tạo token này, gõ `/ngatketnoi` để hủy.');
    }
    if (interaction.commandName === 'ngatketnoi') {
        const uid = interaction.user.id;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const ids = await redis.smembers(`discord_webs_${uid}`);
        for (const w of ids) if (/^[a-f0-9]{16}$/.test(w)) await redis.del(`webacct_${w}`);
        await redis.del(`discord_webs_${uid}`);
        return interaction.editReply(ids.length ? `✅ Đã hủy ${ids.length} liên kết Dashboard. Muốn dùng lại thì lấy token mới và /ketnoi.` : 'ℹ️ Bạn chưa có liên kết Dashboard nào.');
    }
    const adminIds = await getAdminIds();
    const userId = interaction.user.id;

    if (interaction.commandName === 'getlink') {
        if (!inMissionChannel(interaction)) return interaction.reply({ content: MISSION_DENY, flags: MessageFlags.Ephemeral });
        return runGetLink(interaction, interaction.options.getString('provider') || 'link4m');
    }

    if (interaction.commandName === 'vi') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const coins = await redis.get(`coins_${userId}`) || 0;
        await interaction.editReply({ content: `💰 Số dư: **${coins} xu**` });
    }

    if (interaction.commandName === 'reg') {
        if (!inRegChannel(interaction)) {
            return interaction.reply({ content: REG_DENY, flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ embeds: regEmbeds(), components: [regMenu(interaction.client)], flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'daily') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const dailyKey = `daily_${userId}_${getTodayString()}`;
        const ttl = secondsUntilVnMidnight();
        const ok = await claimEarnedCoinsOnce(dailyKey, userId, 20, ttl);
        if (!ok) {
            const left = await redis.ttl(dailyKey);
            return interaction.editReply({ content: `⏳ Đã điểm danh. Thử lại sau ${Math.floor(Math.max(0, left)/3600)}h ${Math.floor((Math.max(0, left)%3600)/60)}m.` });
        }
        await interaction.editReply({ content: `✅ Điểm danh thành công! **+20 xu**.` });
    }

    if (interaction.commandName === 'youtube') {
        return runYoutube(interaction);
    }

    if (interaction.commandName === 'testwelcome') {
        if (!adminIds.includes(userId)) return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        if (!interaction.inGuild() || !interaction.member) return interaction.reply({ content: '❌ Hãy gõ lệnh trong server.', flags: MessageFlags.Ephemeral });
        try {
            const r = await sendWelcome(interaction.member);
            const lines = [
                r.welcome ? `✅ Đã gửi lời chào vào <#${r.welcome.id}>.` : '❌ Không tìm thấy kênh welcome (tên kênh chứa "welcome" hoặc đặt WELCOME_CHANNEL_ID).',
                r.help ? `✅ Đã gửi hướng dẫn vào <#${r.help.id}>.` : '❌ Không tìm thấy kênh help (tên kênh chứa "help" hoặc đặt HELP_CHANNEL_ID).'
            ];
            return interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
        } catch (e) {
            return interaction.reply({ content: e.code === 50013 ? '❌ Bot thiếu quyền **Xem kênh** hoặc **Gửi tin nhắn** trong kênh welcome hoặc help.' : `❌ ${e.message}`, flags: MessageFlags.Ephemeral });
        }
    }

    if (interaction.commandName === 'nhiemvu') {
        if (!adminIds.includes(userId)) return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        if (!interaction.channel || typeof interaction.channel.send !== 'function') {
            return interaction.reply({ content: '❌ Hãy gõ lệnh trong kênh chat của server.', flags: MessageFlags.Ephemeral });
        }
        try {
            // đăng thành tin nhắn thường của bot (ai cũng thấy) và ghim lại cho khỏi trôi
            const msg = await interaction.channel.send(missionPanel());
            try { await msg.pin(); } catch {}
            return interaction.reply({ content: '✅ Đã đăng bảng nhiệm vụ vào kênh (và ghim nếu bot có quyền Quản lý tin nhắn).', flags: MessageFlags.Ephemeral });
        } catch (e) {
            return interaction.reply({ content: e.code === 50013 ? '❌ Bot thiếu quyền **Gửi tin nhắn** trong kênh này.' : `❌ ${e.message}`, flags: MessageFlags.Ephemeral });
        }
    }

    if (interaction.commandName === 'tangqua') {
        if (!adminIds.includes(userId)) return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        const target = interaction.options.getUser('nguoi');
        const top = interaction.options.getInteger('top');
        if (target.bot) return interaction.reply({ content: '❌ Không thể tặng cho bot.', flags: MessageFlags.Ephemeral });
        // Phần thưởng theo hạng, đổi được bằng biến TOP_REWARDS (ví dụ 1000,700,500,300,250,150)
        const rewards = weeklyRewards();
        const amount = rewards[top - 1];
        if (!amount) return interaction.reply({ content: `❌ Chưa có phần thưởng cho TOP ${top}.`, flags: MessageFlags.Ephemeral });
        // chặn lỡ tay tặng trùng cùng hạng cho cùng một người trong ngày
        const awardKey = `tangqua_${target.id}_${top}_${getTodayString()}`;
        const ok = await redis.eval(MANUAL_AWARD_LUA, 2, awardKey, `coins_${target.id}`, amount, 86400);
        if (Number(ok) !== 1) return interaction.reply({ content: `⚠️ Hôm nay đã tặng quà TOP ${top} cho <@${target.id}> rồi.`, flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setColor(0xffc107).setTitle(`🎉 TẶNG QUÀ TOP ${top}`)
            .setDescription(`<@${target.id}> nhận **${amount} xu** vì đạt **TOP ${top}** bảng xếp hạng vượt link!`);
        return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'top') {
        await interaction.deferReply();
        const limit = Math.min(interaction.options.getInteger('limit') || 10, 25);
        const rows = await redis.zrevrange('leaderboard', 0, limit - 1, 'WITHSCORES');
        if (!rows.length) return interaction.editReply({ content: '📭 Chưa có ai.' });
        let lines = [];
        for (let i = 0; i < rows.length; i += 2) {
            let tag = `<@${rows[i]}>`;
            try { tag = (await interaction.client.users.fetch(rows[i])).username; } catch {}
            lines.push(`**#${i / 2 + 1}** ${tag} — **${rows[i + 1]} xu**`);
        }
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xffc107).setTitle(`🏆 TOP ${limit}`).setDescription(lines.join('\n'))] });
    }

    if (interaction.commandName === 'top-tuan') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const weekStart = getWeekStartVNDate();
        const rows = await redis.zrevrange(weeklyLeaderboardKey(weekStart), 0, 5, 'WITHSCORES');
        if (!rows.length) return interaction.editReply({ content: '📭 Tuần này chưa có ai tích lũy xu.' });
        const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣'];
        const lines = [];
        for (let i = 0; i < rows.length; i += 2) {
            lines.push(`${medals[i / 2]} **TOP ${i / 2 + 1}** <@${rows[i]}> — **${rows[i + 1]} xu**`);
        }
        const embed = new EmbedBuilder().setColor(0xffc107).setTitle('🏆 BXH XU TUẦN')
            .setDescription(lines.join('\n')).setFooter({ text: `Tuần bắt đầu ${weekStart} • Chốt lúc 00:00 thứ Hai (giờ Việt Nam)` });
        return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === 'transfer') {
        const target = interaction.options.getUser('target');
        const amount = interaction.options.getInteger('amount');
        if (target.id === userId || target.bot) return interaction.reply({ content: '❌ Không hợp lệ.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply();
        const fee = Math.max(1, Math.floor(amount * 0.05));
        const net = amount - fee;
        const result = await redis.eval(TRANSFER_COINS_LUA, 4, `coins_${userId}`, `coins_${target.id}`, 'leaderboard', weeklyLeaderboardKey(), amount, net, target.id);
        if (Number(result[0]) !== 1) return interaction.editReply({ content: `❌ Không đủ xu (Hiện có ${result[1]} xu).` });
        await interaction.editReply({ content: `✅ Đã chuyển **${net} xu** cho <@${target.id}> (Phí: ${fee} xu).` });
    }

    if (interaction.commandName === 'code') {
        const giftCode = interaction.options.getString('gift_code').trim();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const codeData = await redis.eval(REDEEM_GIFT_LUA, 1, `gift_${giftCode}`, userId, weeklyLeaderboardKey());
        if (!codeData) return interaction.editReply({ content: `❌ Code sai hoặc đã dùng.` });
        await interaction.editReply({ content: `✅ Nhận **${codeData} xu**.` });
    }

    if (interaction.commandName === 'gen') {
        if (!adminIds.includes(userId)) return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        const count = interaction.options.getInteger('soluong');
        const coinAmount = interaction.options.getInteger('xuthuong');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let giftCodes = [];
        for (let i = 0; i < count; i++) {
            let code = '';
            for (let attempt = 0; attempt < 10; attempt++) {
                const candidate = generateGiftCode();
                const saved = await redis.set(`gift_${candidate}`, coinAmount.toString(), 'EX', 30 * 24 * 60 * 60, 'NX');
                if (saved) { code = candidate; break; }
            }
            if (!code) throw new Error('Không tạo được mã duy nhất, hãy thử lại.');
            giftCodes.push(`${code} (${coinAmount} xu)`);
        }
        await interaction.editReply({ content: `✅ Đã tạo **${count}** code:`, files: [{ attachment: Buffer.from(giftCodes.join('\n')), name: `codes.txt` }] });
    }

    if (interaction.commandName === 'clearall') {
        if (!adminIds.includes(userId)) return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        if (!interaction.inGuild() || !interaction.channel || typeof interaction.channel.bulkDelete !== 'function') {
            return interaction.reply({ content: '❌ Lệnh này chỉ dùng được trong kênh chat của server.', flags: MessageFlags.Ephemeral });
        }
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`clearall:${interaction.channelId}:${Date.now()}`).setLabel('Xóa tất cả').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('clearall_cancel').setLabel('Hủy').setStyle(ButtonStyle.Secondary)
        );
        return interaction.reply({ content: '⚠️ Bạn sắp **xóa toàn bộ tin nhắn** trong kênh này (trừ tin đã ghim và bảng nhiệm vụ). Không khôi phục được. Bấm **Xóa tất cả** trong 60 giây để xác nhận.', components: [row], flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'clear') {
        if (!adminIds.includes(userId)) return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const messages = await interaction.channel.messages.fetch({ limit: 100 });
        const isKeep = m => m.pinned || m.components.some(r => (r.components || []).some(c => String(c.customId || '').startsWith('mission:')));
        const toDelete = messages.filter(msg => msg.author.id === interaction.client.user.id && msg.createdTimestamp < Date.now() - 2*60*60*1000 && !isKeep(msg));
        if (toDelete.size === 0) return interaction.editReply({ content: 'ℹ️ Không có tin nhắn cũ.' });
        await interaction.channel.bulkDelete(toDelete, true);
        await interaction.editReply({ content: `✅ Đã xóa ${toDelete.size} tin nhắn.` });
    }

    if (interaction.commandName === 'capquyenadmin') {
        if (!adminIds.includes(userId)) return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        const target = interaction.options.getUser('target');
        if (target.bot || target.id === userId) return interaction.reply({ content: '❌ Không hợp lệ.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const added = await redis.sadd('admins', target.id);
        await interaction.editReply({ content: added ? `✅ Đã cấp quyền cho <@${target.id}>.` : `ℹ️ Đã có quyền rồi.` });
    }

    if (interaction.commandName === 'thuquyenadmin') {
        if (!adminIds.includes(userId)) return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        const target = interaction.options.getUser('target');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const removed = await redis.srem('admins', target.id);
        await interaction.editReply({ content: removed ? `✅ Đã thu hồi quyền của <@${target.id}>.` : `ℹ️ Không có quyền.` });
    }

    if (interaction.commandName === 'xoatk') {
        if (!adminIds.includes(userId)) return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        const target = interaction.options.getUser('target');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await redis.del(`coins_${target.id}`);
        await redis.zrem('leaderboard', target.id);
        let cursor = '0';
        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'leaderboard_weekly:*', 'COUNT', 100);
            cursor = nextCursor;
            if (keys.length) {
                const pipeline = redis.pipeline();
                for (const key of keys) pipeline.zrem(key, target.id);
                await pipeline.exec();
            }
        } while (cursor !== '0');
        await interaction.editReply({ content: `✅ Đã xóa số dư và dữ liệu BXH của <@${target.id}>.` });
    }
}

// ===== QUẢN LÝ NHIỀU BOT + BẢNG ĐIỀU KHIỂN =====
const PANEL_HTML = String.raw`<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0e0f1c">
<title>Bảng điều khiển bot</title>
<style>
:root{--bg:#0e0f1c;--sf:#171830;--ln:#26284a;--tx:#eceeff;--mut:#8a8fb8;--on:#5ee6a8;--ac:#6b78ff;--bad:#ff7a90}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--tx);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:520px;margin:0 auto;padding:28px 18px 80px}
header{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:22px}
h1{margin:0;font-size:26px;font-weight:700;letter-spacing:-.02em}
.summary{margin:4px 0 0;color:var(--mut);font-size:14px}
.summary b{color:var(--on);font-weight:600}
.ghost{background:none;border:1px solid var(--ln);color:var(--mut);border-radius:10px;padding:8px 12px;font:inherit;font-size:13px;cursor:pointer}
.panel{background:var(--sf);border:1px solid var(--ln);border-radius:20px;overflow:hidden}
.bot{display:flex;align-items:center;gap:14px;padding:16px 16px;border-top:1px solid var(--ln);transition:opacity .2s}
.bot:first-child{border-top:0}.bot.busy{opacity:.5;pointer-events:none}
.av{width:46px;height:46px;border-radius:50%;background:#23265a;color:#aab2ff;display:grid;place-items:center;font-weight:700;font-size:18px;flex:none}
.info{flex:1;min-width:0}
.name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sub{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--mut);margin-top:3px}
.dot{width:8px;height:8px;border-radius:50%;background:#4a4e78;flex:none}
.on .dot{background:var(--on);box-shadow:0 0 0 4px rgba(94,230,168,.15)}
.on .st{color:var(--on)}
.del{background:none;border:0;color:var(--bad);font:inherit;font-size:13px;padding:6px 4px;cursor:pointer;opacity:.8}
.sw{position:relative;width:64px;height:36px;flex:none}
.sw input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:2}
.sw i{position:absolute;inset:0;border-radius:99px;background:#2b2e55;transition:background .2s}
.sw i:after{content:"";position:absolute;left:4px;top:4px;width:28px;height:28px;border-radius:50%;background:#fff;transition:transform .2s}
.sw input:checked+i{background:var(--on)}
.sw input:checked+i:after{transform:translateX(28px)}
.sw input:focus-visible+i{outline:3px solid var(--ac);outline-offset:3px}
h2{font-size:17px;margin:34px 0 4px}
.hint{margin:0 0 14px;color:var(--mut);font-size:14px}
input[type=password]{width:100%;padding:14px;border-radius:14px;border:1px solid var(--ln);background:var(--sf);color:var(--tx);font:inherit;margin-bottom:10px}
input[type=password]:focus{outline:2px solid var(--ac);border-color:transparent}
.btn{width:100%;border:0;border-radius:14px;padding:14px;background:var(--ac);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.btn:disabled{opacity:.5}
.file{width:100%;padding:12px;border:1px dashed var(--ln);border-radius:14px;color:var(--mut);background:var(--sf);font:inherit;font-size:14px;margin-bottom:10px}
#login{display:none;padding-top:12vh}
#app{display:none}
.toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,30px);background:#242650;color:var(--tx);padding:12px 18px;border-radius:14px;font-size:14px;opacity:0;pointer-events:none;transition:.25s;max-width:90vw;text-align:center}
.toast.show{opacity:1;transform:translate(-50%,0)}.toast.bad{background:#4a1d2b;color:#ffc4cf}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
.dp-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.dp-svc{background:var(--sf);border:1px solid var(--ln);border-radius:14px;padding:12px 14px}
.dp-name{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:4px}
.dp-url{color:var(--ac);font-size:11px;text-decoration:none;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:8px}
.dp-row{display:flex;gap:6px}
.dp-btn{flex:1;border:0;border-radius:8px;padding:8px;background:var(--ac);color:#fff;font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.dp-btn:disabled{opacity:.4;cursor:not-allowed}
.dp-log{border-radius:8px;padding:8px 10px;border:1px solid var(--ln);background:none;color:var(--mut);font:inherit;font-size:12px;cursor:pointer}
.dp-log:hover{color:var(--tx)}
.dp-badge{display:inline-block;font-size:10px;padding:2px 7px;border-radius:6px;border:1px solid;margin-bottom:6px}
.dp-live{color:var(--on);border-color:var(--on)}.dp-fail{color:var(--bad);border-color:var(--bad)}.dp-build{color:#ffd60a;border-color:#ffd60a}.dp-off{color:var(--mut);border-color:var(--mut)}
@media(max-width:420px){.dp-grid{grid-template-columns:1fr}}
input[type=text]{width:100%;padding:14px;border-radius:14px;border:1px solid var(--ln);background:var(--sf);color:var(--tx);font:inherit;margin-bottom:10px}
input[type=text]:focus{outline:2px solid var(--ac);border-color:transparent}
</style></head><body><div class="wrap">
<div id="login"><h1>Đăng nhập</h1><p class="hint">Nhập mật khẩu bảng điều khiển để quản lý bot.</p>
<input id="pw" type="password" placeholder="Mật khẩu" autocomplete="current-password">
<button class="btn" onclick="doLogin()">Vào bảng điều khiển</button></div>
<div id="app"><header><div><h1>Bot của bạn</h1><p class="summary" id="sum"></p></div><button class="ghost" onclick="logout()">Đăng xuất</button></header>
<div class="panel" id="list"></div>
<h2>Thêm bot</h2><p class="hint">Dán token bot Discord. Bot sẽ đăng nhập và chạy ngay.</p>
<input id="tk" type="password" placeholder="Token bot" autocomplete="off">
<button class="btn" id="addb" onclick="add()">Thêm và chạy</button>
<h2>Cập nhật code</h2><p class="hint">Chọn file server.js mới, nhập mã cập nhật rồi bấm lưu. Bot tự khởi động lại, không cần qua GitHub.</p>
<input id="sf" type="file" accept=".js,text/javascript" class="file">
<input id="dk" type="password" placeholder="Mã cập nhật" autocomplete="off">
<button class="btn" id="updb" onclick="upd()">Lưu và khởi động lại</button>
<button class="ghost" style="margin-top:10px;width:100%" onclick="resetUpd()">Quay về bản trên GitHub</button>
<h2>Địa chỉ IP máy chủ</h2><p class="hint">Gửi IP này cho bên API để họ cho phép bot gọi vào.</p>
<div class="panel" style="padding:16px;margin-bottom:10px"><b id="ipv" style="font-size:20px">Chưa kiểm tra</b></div>
<button class="btn" onclick="getIp()">Kiểm tra IP</button>
<button class="ghost" style="margin-top:10px;width:100%" onclick="copyIp()">Sao chép IP</button>
<h2>Triển khai — Render &amp; Railway</h2>
<p class="hint">Quản lý deploy từ đây, không cần mở từng trang.</p>
<input id="rKey" type="text" placeholder="Render API Key (rnd_xxxx)">
<input id="rwKey" type="text" placeholder="Railway Token">
<button class="btn" onclick="saveDpKeys()">Lưu key &amp; tải dịch vụ</button>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:14px 0 4px">
  <span style="font-size:13px;color:var(--mut)">● RENDER</span>
  <span style="font-size:13px;color:var(--mut)">● RAILWAY</span>
</div>
<div class="dp-grid">
  <div id="rList"><div style="color:var(--mut);font-size:13px;padding:12px 0">Chưa tải</div></div>
  <div id="rwList"><div style="color:var(--mut);font-size:13px;padding:12px 0">Chưa tải</div></div>
</div></div>
</div><div class="toast" id="toast"></div>
<script>
var K=sessionStorage.getItem('k')||'';
function $(i){return document.getElementById(i)}
function toast(t,bad){var e=$('toast');e.textContent=t;e.className='toast show'+(bad?' bad':'');clearTimeout(window._t);window._t=setTimeout(function(){e.className='toast'},3200)}
function api(m,u,b){return fetch(u,{method:m,headers:{'Content-Type':'application/json','x-panel-key':K},body:b?JSON.stringify(b):undefined}).then(function(r){return r.json().catch(function(){return {}}).then(function(j){if(r.status==401){logout(true)}if(!r.ok)throw new Error(j.error||'Có lỗi xảy ra');return j})})}
function view(login){$('login').style.display=login?'block':'none';$('app').style.display=login?'none':'block'}
function logout(bad){K='';sessionStorage.removeItem('k');view(true);if(bad)toast('Sai mật khẩu, thử lại',true)}
function doLogin(){K=$('pw').value;sessionStorage.setItem('k',K);load()}
$('pw').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin()});
function row(b){
 var d=document.createElement('div');d.className='bot'+(b.online?' on':'');
 var av=document.createElement('div');av.className='av';av.textContent=(b.name||'?').charAt(0).toUpperCase();
 var info=document.createElement('div');info.className='info';
 var n=document.createElement('div');n.className='name';n.textContent=b.name;
 var s=document.createElement('div');s.className='sub';
 var dot=document.createElement('span');dot.className='dot';
 var st=document.createElement('span');st.className='st';st.textContent=b.online?'Đang chạy':'Đã tắt';
 var tl=document.createElement('span');tl.textContent='Token '+b.tail;
 s.appendChild(dot);s.appendChild(st);s.appendChild(tl);
 info.appendChild(n);info.appendChild(s);
 if(b.id!=='main'){var x=document.createElement('button');x.className='del';x.textContent='Xóa bot';
  x.onclick=function(){if(confirm('Xóa bot '+b.name+'?')){d.classList.add('busy');api('DELETE','/panel/api/bots/'+b.id).then(function(){toast('Đã xóa bot');load()}).catch(function(e){toast(e.message,true);load()})}};
  info.appendChild(x)}
 var sw=document.createElement('label');sw.className='sw';
 var cb=document.createElement('input');cb.type='checkbox';cb.checked=b.enabled;cb.setAttribute('aria-label',(b.enabled?'Tắt ':'Bật ')+b.name);
 cb.onchange=function(){d.classList.add('busy');api('POST','/panel/api/bots/'+b.id+'/toggle').then(function(){toast(cb.checked?'Đã bật bot':'Đã tắt bot');load()}).catch(function(e){toast(e.message,true);load()})};
 var tr=document.createElement('i');sw.appendChild(cb);sw.appendChild(tr);
 d.appendChild(av);d.appendChild(info);d.appendChild(sw);return d}
function load(){
 if(!K){view(true);return}
 api('GET','/panel/api/bots').then(function(bots){
  view(false);if(!window._ip){window._ip=1;getIp()}var l=$('list');l.innerHTML='';
  bots.forEach(function(b){l.appendChild(row(b))});
  var on=bots.filter(function(b){return b.online}).length;
  $('sum').innerHTML='<b>'+on+' đang chạy</b>, '+bots.length+' bot tất cả';
 }).catch(function(e){toast(e.message,true)})}
function add(){var i=$('tk'),b=$('addb');if(!i.value.trim()){toast('Hãy dán token bot trước',true);return}
 b.disabled=true;b.textContent='Đang đăng nhập bot...';
 api('POST','/panel/api/bots',{token:i.value}).then(function(){i.value='';toast('Đã thêm bot và đang chạy');load()}).catch(function(e){toast(e.message,true)}).then(function(){b.disabled=false;b.textContent='Thêm và chạy'})}
function getIp(){$('ipv').textContent='Đang kiểm tra...';api('GET','/panel/api/ip').then(function(j){$('ipv').textContent=j.ip||'Không lấy được IP'}).catch(function(e){$('ipv').textContent='Lỗi';toast(e.message,true)})}
function copyIp(){var t=$('ipv').textContent;if(!/^[0-9a-f.:]{3,45}$/i.test(t)){toast('Hãy bấm Kiểm tra IP trước',true);return}(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){toast('Đã sao chép IP')}).catch(function(){toast('Không sao chép được, hãy tự chọn và copy',true)})}
function waitBack(){var n=0;(function t(){fetch('/panel/api/bots',{headers:{'x-panel-key':K}}).then(function(r){if(r.ok){toast('Bot đã chạy lại');load()}else throw 0}).catch(function(){if(++n<40)setTimeout(t,3000);else toast('Chưa thấy bot chạy lại, hãy xem Logs trên Render',true)})})()}
function chk(r){return r.json().catch(function(){return {}}).then(function(j){if(!r.ok)throw new Error(j.error||'Có lỗi xảy ra');return j})}
function upd(){var f=$('sf').files[0];if(!f){toast('Hãy chọn file server.js',true);return}if(!$('dk').value){toast('Nhập mã cập nhật',true);return}
 var b=$('updb');b.disabled=true;b.textContent='Đang gửi...';
 f.text().then(function(code){return fetch('/panel/api/update',{method:'POST',headers:{'Content-Type':'application/json','x-panel-key':K,'x-deploy-key':$('dk').value},body:JSON.stringify({code:code})})}).then(chk).then(function(){toast('Đã lưu, bot đang khởi động lại...');waitBack()}).catch(function(e){toast(e.message,true)}).then(function(){b.disabled=false;b.textContent='Lưu và khởi động lại'})}
function resetUpd(){if(!$('dk').value){toast('Nhập mã cập nhật',true);return}if(!confirm('Quay về bản server.js trên GitHub?'))return;
 fetch('/panel/api/update',{method:'DELETE',headers:{'x-panel-key':K,'x-deploy-key':$('dk').value}}).then(chk).then(function(){toast('Đang quay về bản GitHub...');waitBack()}).catch(function(e){toast(e.message,true)})}
load();
// ===== DEPLOY PANEL =====
(function(){
  try{var rk=localStorage.getItem('nig_rk')||'';var rw=localStorage.getItem('nig_rw')||'';if(rk)document.getElementById('rKey').value=rk;if(rw)document.getElementById('rwKey').value=rw;if(rk)loadRender();if(rw)loadRailway();}catch(e){}
})();
function saveDpKeys(){
  var rk=document.getElementById('rKey').value.trim();
  var rw=document.getElementById('rwKey').value.trim();
  try{if(rk)localStorage.setItem('nig_rk',rk);if(rw)localStorage.setItem('nig_rw',rw);}catch(e){}
  if(rk)loadRender();if(rw)loadRailway();
}
function dpStatus(s){
  var map={live:'dp-live',active:'dp-live',success:'dp-live',SUCCESS:'dp-live',building:'dp-build',BUILDING:'dp-build',deploying:'dp-build',DEPLOYING:'dp-build',update_failed:'dp-fail',create_failed:'dp-fail',FAILED:'dp-fail',failed:'dp-fail',suspended:'dp-off'};
  var lbl={live:'LIVE',active:'LIVE',success:'LIVE',SUCCESS:'LIVE',building:'BUILD',BUILDING:'BUILD',deploying:'DEPLOY',DEPLOYING:'DEPLOY',update_failed:'FAIL',create_failed:'FAIL',FAILED:'FAIL',failed:'FAIL',suspended:'OFF'};
  return '<span class="dp-badge '+(map[s]||'dp-off')+'">'+(lbl[s]||'?')+'</span>';
}
function loadRender(){
  var key=document.getElementById('rKey').value.trim()||localStorage.getItem('nig_rk')||'';
  var el=document.getElementById('rList');
  if(!key){el.innerHTML='<div style="color:var(--mut);font-size:13px">Chưa có Render key</div>';return;}
  el.innerHTML='<div style="color:var(--mut);font-size:12px">Đang tải...</div>';
  fetch('https://api.render.com/v1/services?limit=20',{headers:{Authorization:'Bearer '+key,Accept:'application/json'}})
  .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
  .then(function(data){
    if(!data.length){el.innerHTML='<div style="color:var(--mut);font-size:13px">Không có service</div>';return;}
    el.innerHTML=data.map(function(item){
      var s=item.service||item;
      var st=s.suspended==='suspended'?'suspended':(s.state||'unknown');
      var url=s.serviceDetails&&s.serviceDetails.url?s.serviceDetails.url:'';
      return '<div class="dp-svc"><div class="dp-name">'+s.name+'</div>'+dpStatus(st)+(url?'<a class="dp-url" href="https://'+url+'" target="_blank">'+url+'</a>':'')+'<div class="dp-row"><button class="dp-btn" onclick="deployRender(\''+s.id+'\',\''+s.name+'\',this)">▶ Deploy</button><button class="dp-log" onclick="window.open(\'https://dashboard.render.com/web/'+s.id+'/logs\',\'_blank\')">Log</button></div></div>';
    }).join('');
  })
  .catch(function(e){el.innerHTML='<div style="color:var(--bad);font-size:12px">Lỗi: '+e.message+'</div>';});
}
function deployRender(id,name,btn){
  var key=document.getElementById('rKey').value.trim()||localStorage.getItem('nig_rk')||'';
  btn.disabled=true;btn.textContent='...';
  fetch('https://api.render.com/v1/services/'+id+'/deploys',{method:'POST',headers:{Authorization:'Bearer '+key,Accept:'application/json','Content-Type':'application/json'},body:'{}'})
  .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
  .then(function(){toast('Deploy '+name+' thành công');btn.textContent='✓';setTimeout(function(){btn.textContent='▶ Deploy';btn.disabled=false;loadRender();},3000);})
  .catch(function(e){toast(e.message,true);btn.textContent='▶ Deploy';btn.disabled=false;});
}
function loadRailway(){
  var key=document.getElementById('rwKey').value.trim()||localStorage.getItem('nig_rw')||'';
  var el=document.getElementById('rwList');
  if(!key){el.innerHTML='<div style="color:var(--mut);font-size:13px">Chưa có Railway token</div>';return;}
  el.innerHTML='<div style="color:var(--mut);font-size:12px">Đang tải...</div>';
  var q='{"query":"{me{projects{edges{node{id name services{edges{node{id name serviceInstances{edges{node{buildStatus domains{edges{node{domain}}}}}}}}}}}}}}"}';
  fetch('https://backboard.railway.app/graphql/v2',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:q})
  .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
  .then(function(json){
    if(json.errors)throw new Error(json.errors[0].message||'GraphQL error');
    var projs=(json.data&&json.data.me&&json.data.me.projects&&json.data.me.projects.edges)||[];
    var html='';
    projs.forEach(function(pe){
      var proj=pe.node;
      (proj.services&&proj.services.edges||[]).forEach(function(se){
        var svc=se.node;
        var inst=svc.serviceInstances&&svc.serviceInstances.edges&&svc.serviceInstances.edges[0]&&svc.serviceInstances.edges[0].node;
        var st=(inst&&inst.buildStatus)||'unknown';
        var domains=(inst&&inst.domains&&inst.domains.edges||[]).map(function(d){return d.node.domain;});
        var url=domains[0]||'';
        html+='<div class="dp-svc"><div class="dp-name">'+svc.name+'</div>'+dpStatus(st)+(url?'<a class="dp-url" href="https://'+url+'" target="_blank">'+url+'</a>':'')+'<div class="dp-row"><button class="dp-btn" onclick="redeployRailway(\''+svc.id+'\',\''+svc.name+'\',this)">▶ Redeploy</button><button class="dp-log" onclick="window.open(\'https://railway.app/project/'+proj.id+'/service/'+svc.id+'\',\'_blank\')">Log</button></div></div>';
      });
    });
    el.innerHTML=html||'<div style="color:var(--mut);font-size:13px">Không có service</div>';
  })
  .catch(function(e){el.innerHTML='<div style="color:var(--bad);font-size:12px">Lỗi: '+e.message+'</div>';});
}
function redeployRailway(id,name,btn){
  var key=document.getElementById('rwKey').value.trim()||localStorage.getItem('nig_rw')||'';
  btn.disabled=true;btn.textContent='...';
  var q='{"query":"mutation{serviceInstanceRedeploy(serviceId:\\"'+id+'\\")}"}';
  fetch('https://backboard.railway.app/graphql/v2',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:q})
  .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
  .then(function(json){if(json.errors)throw new Error(json.errors[0].message||'Lỗi');toast('Redeploy '+name+' thành công');btn.textContent='✓';setTimeout(function(){btn.textContent='▶ Redeploy';btn.disabled=false;loadRailway();},3000);})
  .catch(function(e){toast(e.message,true);btn.textContent='▶ Redeploy';btn.disabled=false;});
}
</script></body></html>`;
const running = new Map(); // id -> Client đang chạy
const BOTS_KEY = 'panel_bots'; // hash trong Redis: id -> JSON {name, token?, enabled}

// ===== CHÀO MỪNG THÀNH VIÊN MỚI =====
// Gửi lời chào vào kênh có tên chứa "welcome" / "wellcom" / "chao-mung" (hoặc kênh có ID trong biến WELCOME_CHANNEL_ID)
const normName = c => String((c && c.name) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function findChannel(guild, envId, pattern) {
    const byId = envId ? guild.channels.cache.get(envId) : null;
    if (byId && byId.type === ChannelType.GuildText) return byId;
    return guild.channels.cache.find(c => c.type === ChannelType.GuildText && pattern.test(normName(c))) || null;
}
// Bài hướng dẫn gửi vào kênh help (tự tag người mới)
function helpEmbed(guild, missionCh) {
    const mission = missionCh ? `<#${missionCh.id}>` : 'kênh nhiệm vụ';
    return new EmbedBuilder().setColor(0x2ecc71).setTitle('📖 HƯỚNG DẪN SỬ DỤNG BOT')
        .setDescription('Bot cho bạn **kiếm xu** bằng nhiệm vụ rồi **đổi xu** lấy tài khoản cloud phone.')
        .addFields(
            { name: '💰 1. Cách kiếm xu', value:
                `• Vào ${mission} bấm nút nhiệm vụ **Link4M** hoặc **LayMa** (vượt link nhận **50 xu**, 2 lần/ngày) hoặc **YouTube** (đăng ký kênh nhận **${ytReward()} xu**, mỗi ngày 1 lần).\n` +
                '• Gõ `/daily` để điểm danh nhận **20 xu** mỗi ngày.\n• Gõ `/code` để nhập Gift Code.' },
            { name: '☁️ 2. Cách dùng xu', value:
                '• `/reg`: chọn loại cloud để lấy tài khoản (**10 xu** mỗi lần), gõ trong các kênh cloud phone.\n• `/buycloud`: mua máy bằng tài khoản của bạn, nhập theo mẫu `email|matkhau`.' },
            { name: '📌 3. Lệnh khác', value:
                '• `/vi`: xem số xu của bạn.\n• `/top`: bảng xếp hạng tổng.\n• `/top-tuan`: xem BXH xu tuần (top 1–6), kênh BXH tự cập nhật.\n• `/transfer`: chuyển xu cho bạn bè (phí 5%).' }
        )
        .setFooter({ text: 'Cần hỗ trợ thì nhắn admin trong kênh này nhé!' });
}
async function sendWelcome(member) {
    const guild = member.guild;
    const welcomeCh = findChannel(guild, process.env.WELCOME_CHANNEL_ID, /welcome|wellcom|chaomung/);
    const helpCh = findChannel(guild, process.env.HELP_CHANNEL_ID, /help|huongdan/);
    const missionCh = guild.channels.cache.find(c => c.type === ChannelType.GuildText && normName(c).includes('nhiemvunhanxu'));
    // Chỉ đếm người thật (không tính bot): tải danh sách thành viên rồi lọc bỏ bot
    let humans = guild.memberCount;
    try { humans = (await guild.members.fetch()).filter(m => !m.user.bot).size; } catch {}
    const brand = guild.name.replace(/_/g, ' ');
    let welcomeSent = null, helpSent = null;
    if (welcomeCh) {
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`👋 Chào mừng bạn đến với ${brand}!`)
            .setDescription(`Xin chào <@${member.id}>, bạn là thành viên thứ **${humans}** của server.` +
                (helpCh ? `\n📖 Hãy vào <#${helpCh.id}> để xem hướng dẫn sử dụng.` : '') +
                (missionCh ? `\n🎯 Làm nhiệm vụ nhận xu ở <#${missionCh.id}>.` : ''))
            .setThumbnail(member.user.displayAvatarURL({ size: 256 }));
        await welcomeCh.send({ content: `<@${member.id}>`, embeds: [embed] });
        welcomeSent = welcomeCh;
    }
    if (helpCh) {
        await helpCh.send({ content: `<@${member.id}> 👋 Chào mừng bạn đến với **${brand}**! Đây là cách dùng bot:`, embeds: [helpEmbed(guild, missionCh)] });
        helpSent = helpCh;
    }
    return { welcome: welcomeSent, help: helpSent };
}
async function onMemberAdd(member) {
    try {
        if (member.user.bot) return;
        console.log('[welcome] thành viên mới vào:', member.user.tag);
        const r = await sendWelcome(member);
        if (!r.welcome) console.log('[welcome] không tìm thấy kênh welcome (tên kênh cần chứa "welcome" hoặc đặt WELCOME_CHANNEL_ID)');
        if (!r.help) console.log('[welcome] không tìm thấy kênh help (tên kênh cần chứa "help" hoặc đặt HELP_CHANNEL_ID)');
    } catch (e) { console.error('[welcome]', e.message); }
}

function startBot(id, token, withMembers = id === 'main') {
    return new Promise((resolve, reject) => {
        if (running.has(id)) return resolve(running.get(id));
        // GuildMembers là quyền riêng, phải bật "Server Members Intent" trong Discord Developer Portal; chưa bật thì bot vẫn chạy nhưng không có lời chào
        const c = new Client({ intents: withMembers ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] : [GatewayIntentBits.Guilds] });
        const timer = setTimeout(() => { c.destroy(); reject(new Error('Quá thời gian chờ đăng nhập')); }, 30000);
        c.on('error', err => console.error(`[bot ${id}]`, err.message));
        c.on('interactionCreate', onInteraction);
        if (withMembers) c.on(Events.GuildMemberAdd, onMemberAdd);
        c.once(Events.ClientReady, async () => {
            clearTimeout(timer);
            running.set(id, c);
            try {
                await onReady(c, token, id);
                console.log(withMembers ? '✅ Chào mừng thành viên mới: ĐANG BẬT (bot chính)' : '⚠️ Chào mừng thành viên mới: TẮT cho bot này');
            } catch (e) {
                console.error(`[bot ${id}] Lỗi xử lý sau khi đăng nhập:`, e.message);
            }
            resolve(c);
        });
        c.login(token).catch(e => {
            clearTimeout(timer); c.destroy();
            if (withMembers && /disallowed ?intents|intent.*not enabled/i.test(`${e && e.code} ${e && e.message}`)) {
                console.error('⚠️ Chưa bật "Server Members Intent" trong Developer Portal: bot vẫn chạy nhưng chưa có tính năng chào mừng.');
                return startBot(id, token, false).then(resolve, reject);
            }
            reject(e);
        });
    });
}
async function stopBot(id) {
    const c = running.get(id);
    if (!c) return;
    running.delete(id);
    if (c._weeklyLeaderboardTimer) clearInterval(c._weeklyLeaderboardTimer);
    await c.destroy();
}
async function getBots() {
    const raw = await redis.hgetall(BOTS_KEY);
    const list = Object.entries(raw).map(([id, v]) => ({ id, ...JSON.parse(v) }));
    if (!list.some(b => b.id === 'main')) list.unshift({ id: 'main', name: 'Bot chính', enabled: true });
    return list;
}
const tokenOf = b => (b.id === 'main' ? process.env.DISCORD_TOKEN : b.token);
async function saveBot(b) { const { id, ...rest } = b; await redis.hset(BOTS_KEY, id, JSON.stringify(rest)); }

function panelAuth(req, res, next) {
    const pw = process.env.PANEL_PASSWORD;
    if (!pw) return res.status(503).json({ error: 'Chưa đặt PANEL_PASSWORD trong .env' });
    const given = Buffer.from(String(req.headers['x-panel-key'] || ''));
    const want = Buffer.from(pw);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        return setTimeout(() => res.status(401).json({ error: 'Sai mật khẩu' }), 800);
    }
    next();
}
const botView = b => ({ id: b.id, name: b.name, enabled: !!b.enabled, online: running.has(b.id), tail: b.id === 'main' ? 'trong .env' : '...' + String(b.token).slice(-4) });

app.get('/panel', (req, res) => res.type('html').send(PANEL_HTML));
app.get('/panel/api/ip', panelAuth, async (req, res) => res.json({ ip: await getPublicIp() }));
app.get('/panel/api/bots', panelAuth, async (req, res) => res.json((await getBots()).map(botView)));
app.post('/panel/api/bots', panelAuth, async (req, res) => {
    const token = String((req.body && req.body.token) || '').trim();
    if (!token) return res.status(400).json({ error: 'Thiếu token' });
    if ((await getBots()).some(b => tokenOf(b) === token)) return res.status(400).json({ error: 'Token này đã có rồi' });
    const id = crypto.randomBytes(4).toString('hex');
    let started = false;
    try {
        const c = await startBot(id, token);
        started = true;
        await saveBot({ id, name: c.user.tag, token, enabled: true });
        res.json({ ok: true });
    } catch (e) {
        if (started) await stopBot(id).catch(() => {});
        res.status(400).json({ error: 'Token sai hoặc không đăng nhập được: ' + e.message });
    }
});
app.post('/panel/api/bots/:id/toggle', panelAuth, async (req, res) => {
    const b = (await getBots()).find(x => x.id === req.params.id);
    if (!b) return res.status(404).json({ error: 'Không thấy bot' });
    try {
        if (b.enabled) { await stopBot(b.id); b.enabled = false; }
        else {
            if (!tokenOf(b)) throw new Error('Bot này chưa có token');
            await startBot(b.id, tokenOf(b)); b.enabled = true;
        }
        await saveBot(b);
        res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/panel/api/bots/:id', panelAuth, async (req, res) => {
    if (req.params.id === 'main') return res.status(400).json({ error: 'Không xóa được bot chính' });
    await stopBot(req.params.id);
    await redis.hdel(BOTS_KEY, req.params.id);
    res.json({ ok: true });
});


function deployAuth(req, res, next) {
    const key = process.env.DEPLOY_KEY;
    if (!key) return res.status(503).json({ error: 'Chưa đặt DEPLOY_KEY trong Environment' });
    const given = Buffer.from(String(req.headers['x-deploy-key'] || ''));
    const want = Buffer.from(key);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        return setTimeout(() => res.status(401).json({ error: 'Sai mã cập nhật' }), 800);
    }
    next();
}
// Lưu server.js mới vào Redis, index.js sẽ nạp bản này khi khởi động
app.post('/panel/api/update', panelAuth, deployAuth, async (req, res) => {
    const code = String((req.body && req.body.code) || '');
    if (code.length < 1000 || code.length > 2500000) return res.status(400).json({ error: 'File không hợp lệ (quá ngắn hoặc quá lớn)' });
    try { new vm.Script(code, { filename: 'server_override.js' }); }
    catch (e) { return res.status(400).json({ error: 'Lỗi cú pháp trong file: ' + e.message }); }
    await redis.set('server_override', code);
    await redis.set('override_boot', '0');
    console.log('[update] Đã lưu server.js mới, khởi động lại...');
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 700);
});
app.delete('/panel/api/update', panelAuth, deployAuth, async (req, res) => {
    await redis.del('server_override', 'override_boot');
    console.log('[update] Quay về server.js trên GitHub, khởi động lại...');
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 700);
});
// Chạy ổn 60 giây thì coi như bản cập nhật tốt (index.js dùng số này để tự quay về bản gốc nếu lỗi)
setTimeout(() => redis.set('override_boot', '0').catch(() => {}), 60000);

getPublicIp().then(ip => console.log('[IP] Địa chỉ IP máy chủ gọi ra ngoài:', ip || 'không lấy được'));

require('./dashboard')(app, panelAuth, { redis, getBots, startBot, stopBot, saveBot, tokenOf, botView, running });

(async () => {
    try {
        for (const b of await getBots()) {
            if (!b.enabled || !tokenOf(b)) continue;
            startBot(b.id, tokenOf(b)).catch(e => console.error(`❌ Bot "${b.name}" lỗi:`, e.message));
        }
    } catch (e) {
        console.error('[startup] Không đọc được danh sách bot từ Redis:', e.message);
    }
})();
