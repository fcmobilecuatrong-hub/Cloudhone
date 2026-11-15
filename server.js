require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const Redis = require('ioredis');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags, Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

if (!process.env.DISCORD_TOKEN) console.warn('⚠️ Không có DISCORD_TOKEN trong .env: bot chính sẽ không chạy, chỉ chạy các bot thêm từ bảng điều khiển.');
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
process.on('uncaughtException', err => console.error('[uncaughtException]', err));

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

function generateGiftCode() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let result = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) result += chars[bytes[i] % chars.length];
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

// WEB SERVER
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
    try {
        const sessionData = await redis.getdel(`session_${sid}`);
        if (!sessionData) return renderError("Link này đã được sử dụng hoặc đã hết hạn.");
        const { userId, provider } = JSON.parse(sessionData);
        await redis.incrby(`coins_${userId}`, 50);
        await redis.zincrby('leaderboard', 50, userId);
        const newBalance = await redis.get(`coins_${userId}`);
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
app.get('/', (req, res) => res.send('Bot đang chạy ✅'));

// Tự truy cập web của chính mình mỗi 5 phút để Render không cho ngủ
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_DOMAIN;
if (SELF_URL && SELF_URL.startsWith('https://')) {
    setInterval(() => {
        fetch(SELF_URL, { signal: AbortSignal.timeout(15000) }).catch(e => console.error('[keep-alive]', e.message));
    }, 5 * 60 * 1000);
}

app.listen(PORT, () => console.log(`\n✅ Web Server: http://localhost:${PORT}`));

// DISCORD BOT
async function onReady(client, token) {
    const commands = [
        new SlashCommandBuilder().setName('getlink').setDescription('Lấy link nhiệm vụ nhận 50 xu (2 lần/ngày)').addStringOption(opt => opt.setName('provider').setDescription('Dịch vụ').addChoices({ name: 'Link4M', value: 'link4m' }, { name: 'LayMa', value: 'layma' }).setRequired(false)),
        new SlashCommandBuilder().setName('vi').setDescription('Xem số dư xu'),
        new SlashCommandBuilder().setName('reg').setDescription('Lấy mail|pass|mã mời (10 xu)'),
        new SlashCommandBuilder().setName('buycloud').setDescription('Mua cloud phone: nhập tài khoản/mật khẩu'),
        new SlashCommandBuilder().setName('daily').setDescription('Điểm danh nhận 20 xu'),
        new SlashCommandBuilder().setName('top').setDescription('BXH kiếm xu').addIntegerOption(o => o.setName('limit').setDescription('Số người').setRequired(false)),
        new SlashCommandBuilder().setName('transfer').setDescription('Chuyển xu (phí 5%)').addUserOption(o => o.setName('target').setDescription('Người nhận').setRequired(true)).addIntegerOption(o => o.setName('amount').setDescription('Số xu').setRequired(true).setMinValue(10)),
        new SlashCommandBuilder().setName('code').setDescription('Nhập Gift Code').addStringOption(o => o.setName('gift_code').setDescription('Mã').setRequired(true)),
        new SlashCommandBuilder().setName('gen').setDescription('Tạo Gift Code (Admin)').addIntegerOption(o => o.setName('soluong').setDescription('Số lượng').setRequired(true)).addIntegerOption(o => o.setName('xuthuong').setDescription('Số xu').setRequired(true)),
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

async function handleBuyCloud(interaction) {
    const raw = interaction.fields.getTextInputValue('info').trim();
    const i = raw.indexOf('/');
    const account = i > 0 ? raw.slice(0, i).trim() : '';
    const password = i > 0 ? raw.slice(i + 1).trim() : '';
    if (!account || !password || raw.length > 300) {
        return interaction.reply({ content: '❌ Sai định dạng. Nhập theo mẫu: `taikhoan/matkhau` (ngăn cách bằng dấu `/`).', flags: MessageFlags.Ephemeral });
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: process.env.HANAMI_TOKEN, cloud_id: 'VM', input_data: `${account}|${password}` }),
            signal: AbortSignal.timeout(30000)
        });
        const text = await res.text();
        console.log('[buycloud]', userId, account, res.status, text.slice(0, 300));
        try { result = JSON.parse(text); }
        catch { result = { code: -1, message: `Máy chủ mua cloud trả về lỗi (HTTP ${res.status}).` }; }
    } catch (e) {
        console.error('[buycloud]', e.message);
        result = { code: -1, message: 'Không kết nối được tới máy chủ mua cloud.' };
    }
    const ok = !!result && result.code === 0;
    const message = String((result && result.message) || 'Có lỗi xảy ra.');
    if (!ok && cost > 0) await redis.incrby(`coins_${userId}`, cost); // hoàn xu
    await redis.rpush('buycloud_orders', JSON.stringify({ userId, account, ok, message, at: Date.now() }));
    for (const id of await getAdminIds()) {
        try {
            const admin = await interaction.client.users.fetch(id);
            await admin.send(`🛒 Buycloud: <@${userId}> | \`${account}\` | ${ok ? 'thành công' : 'lỗi'}: ${message}`);
        } catch {}
    }
    await interaction.editReply({ content: ok ? message : `❌ ${message}` });
}

async function handleInteraction(interaction) {
    if (interaction.isModalSubmit() && interaction.customId === 'buycloud_modal') return handleBuyCloud(interaction);
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'buycloud') {
        const modal = new ModalBuilder().setCustomId('buycloud_modal').setTitle('Mua Cloud Phone');
        const input = new TextInputBuilder().setCustomId('info').setLabel('Nhập: taikhoan/matkhau').setPlaceholder('gggggggg@##/mkvfjjf').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(300);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
    }
    const adminIds = await getAdminIds();
    const userId = interaction.user.id;

    if (interaction.commandName === 'getlink') {
        const provider = interaction.options.getString('provider') || 'link4m';
        const limitKey = `limit_${userId}_${provider}_${getTodayString()}`;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const used = await redis.incr(limitKey);
            await redis.expire(limitKey, secondsUntilVnMidnight());
            if (used > 2) {
                await redis.decr(limitKey);
                return interaction.editReply({ content: `❌ Đã đạt giới hạn 2 lần/ngày cho ${provider}.` });
            }
            const currentCount = used - 1;
            const sessionId = crypto.randomBytes(16).toString('hex');
            await redis.set(`session_${sessionId}`, JSON.stringify({ userId, provider }), 'EX', 300);
            const targetUrl = `${process.env.RENDER_DOMAIN}/redeem?sid=${sessionId}`;
            let finalUrl = '';
            if (provider === 'link4m') {
                const res = await fetch(`https://link4m.co/api-shorten/v2?api=${process.env.LINK4M_API_KEY}&url=${encodeURIComponent(targetUrl)}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
                const data = await res.json();
                if (data.status === "success" && data.shortenedUrl) finalUrl = data.shortenedUrl;
                else throw new Error("Lỗi từ Link4M");
            } else {
                const res = await fetch(`https://api.layma.net/api/admin/shortlink/quicklink?tokenUser=${process.env.LAYMA_TOKEN}&format=json&url=${encodeURIComponent(targetUrl)}`, { signal: AbortSignal.timeout(15000) });
                const data = await res.json();
                if (data.success === true && data.html) finalUrl = data.html;
                else throw new Error("Lỗi từ LayMa");
            }
            const embed = new EmbedBuilder().setColor(provider === 'link4m' ? 0xffc107 : 0x8b5cf6).setTitle(`🔗 LINK NHẬN XU (${provider.toUpperCase()})`).setDescription(`Bấm link nhận **50 xu**. Còn **${2 - (parseInt(currentCount) + 1)}** lượt.`).addFields({ name: 'Link', value: finalUrl });
            await interaction.editReply({ embeds: [embed] });
        } catch (e) {
            // lỗi lấy link -> trả lại lượt
            await redis.decr(limitKey).catch(() => {});
            await interaction.editReply({ content: `❌ ${e.message}` });
        }
    }

    if (interaction.commandName === 'vi') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const coins = await redis.get(`coins_${userId}`) || 0;
        await interaction.editReply({ content: `💰 Số dư: **${coins} xu**` });
    }

    if (interaction.commandName === 'reg') {
        const chName = (interaction.channel?.name || '').toLowerCase();
        if (chName.replace(/-/g, '_') !== 'reg_cloud_phone') {
            return interaction.reply({ content: '❌ Lệnh `/reg` chỉ dùng được trong kênh **#reg_cloud_phone**.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const remaining = await redis.decrby(`coins_${userId}`, 10);
            if (remaining < 0) {
                await redis.incrby(`coins_${userId}`, 10);
                return interaction.editReply({ content: `❌ Không đủ 10 xu.` });
            }
            let data;
            try {
                const response = await fetch('https://wxygtmfttyidwnhjdwdw.supabase.co/functions/v1/get-key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': process.env.APIKEY }, body: JSON.stringify({ clientId: crypto.randomUUID() }), signal: AbortSignal.timeout(15000) });
                data = await response.json();
                if (!data.content) throw new Error("Lỗi lấy dữ liệu.");
            } catch (err) {
                await redis.incrby(`coins_${userId}`, 10); // hoàn xu
                throw new Error(err.message || "Lỗi lấy dữ liệu.");
            }
            const currentCoins = remaining + 10;
            
            const parts = data.content.split('|');
            const mail = parts[0] || 'Không có';
            const pass = parts[1] || 'Không có';
            const maMoiTk = parts[2] || 'Không có';
            
            await interaction.editReply({ 
                content: `✅ Mua thành công! (Đã trừ 10 xu)\n\n📧 **Tài khoản:** \`${mail}\`\n🔑 **Mật khẩu:** \`${pass}\`\n🎁 **Mã mời:** \`${maMoiTk}\`\n\n💰 Số dư còn lại: **${currentCoins - 10} xu**` 
            });
        } catch (error) { await interaction.editReply({ content: `❌ ${error.message}` }); }
    }

    if (interaction.commandName === 'daily') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const dailyKey = `daily_${userId}_${getTodayString()}`;
        const ttl = secondsUntilVnMidnight();
        const ok = await redis.set(dailyKey, '1', 'EX', ttl, 'NX');
        if (!ok) {
            const left = await redis.ttl(dailyKey);
            return interaction.editReply({ content: `⏳ Đã điểm danh. Thử lại sau ${Math.floor(left/3600)}h ${Math.floor((left%3600)/60)}m.` });
        }
        await redis.incrby(`coins_${userId}`, 20);
        await redis.zincrby('leaderboard', 20, userId);
        await interaction.editReply({ content: `✅ Điểm danh thành công! **+20 xu**.` });
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

    if (interaction.commandName === 'transfer') {
        const target = interaction.options.getUser('target');
        const amount = interaction.options.getInteger('amount');
        if (target.id === userId || target.bot) return interaction.reply({ content: '❌ Không hợp lệ.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply();
        const left = await redis.decrby(`coins_${userId}`, amount);
        if (left < 0) {
            await redis.incrby(`coins_${userId}`, amount);
            return interaction.editReply({ content: `❌ Không đủ xu (Có ${left + amount}).` });
        }
        const fee = Math.max(1, Math.floor(amount * 0.05));
        const net = amount - fee;
        await redis.multi().incrby(`coins_${target.id}`, net).zincrby('leaderboard', net, target.id).exec();
        await interaction.editReply({ content: `✅ Đã chuyển **${net} xu** cho <@${target.id}> (Phí: ${fee} xu).` });
    }

    if (interaction.commandName === 'code') {
        const giftCode = interaction.options.getString('gift_code').trim();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const codeData = await redis.getdel(`gift_${giftCode}`);
        if (!codeData) return interaction.editReply({ content: `❌ Code sai hoặc đã dùng.` });
        await redis.incrby(`coins_${userId}`, parseInt(codeData));
        await redis.zincrby('leaderboard', parseInt(codeData), userId);
        await interaction.editReply({ content: `✅ Nhận **${codeData} xu**.` });
    }

    if (interaction.commandName === 'gen') {
        if (!adminIds.includes(userId)) return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        const count = interaction.options.getInteger('soluong');
        const coinAmount = interaction.options.getInteger('xuthuong');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let giftCodes = [];
        for (let i = 0; i < count; i++) {
            const code = generateGiftCode();
            giftCodes.push(`${code} (${coinAmount} xu)`);
            await redis.set(`gift_${code}`, coinAmount.toString(), 'EX', 30 * 24 * 60 * 60);
        }
        await interaction.editReply({ content: `✅ Đã tạo **${count}** code:`, files: [{ attachment: Buffer.from(giftCodes.join('\n')), name: `codes.txt` }] });
    }

    if (interaction.commandName === 'clear') {
        if (!adminIds.includes(userId)) return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const messages = await interaction.channel.messages.fetch({ limit: 100 });
        const toDelete = messages.filter(msg => msg.author.id === interaction.client.user.id && msg.createdTimestamp < Date.now() - 2*60*60*1000);
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
        await interaction.editReply({ content: `✅ Đã xóa data của <@${target.id}>.` });
    }
}

// ===== QUẢN LÝ NHIỀU BOT + BẢNG ĐIỀU KHIỂN =====
const PANEL_HTML = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bảng điều khiển bot</title>
<style>
body{margin:0;background:#080d0b;color:#fff;font-family:sans-serif;padding:16px}
.card{background:#101a14;border:1px solid #1f3a2b;border-radius:12px;padding:14px;margin-bottom:12px}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
button{border:0;border-radius:8px;padding:8px 14px;font-weight:bold;cursor:pointer}
.on{background:#39f58a;color:#000}.off{background:#ff6b81;color:#000}.del{background:#2a2f2c;color:#fff}
input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #1f3a2b;background:#0b120e;color:#fff;margin-bottom:8px}
small{color:#91a096}#msg{color:#ffc107;margin-bottom:10px}
</style></head><body>
<h2>🤖 Bảng điều khiển bot</h2>
<div id="msg"></div><div id="list"></div>
<div class="card"><b>Thêm bot mới</b><br><small>Dán token bot Discord, bot sẽ tự chạy ngay.</small><br><br><input id="tk" type="password" placeholder="Token bot"><button class="on" onclick="add()">Thêm &amp; bật</button></div>
<script>
var K=sessionStorage.getItem('k')||'';
function api(m,u,b){return fetch(u,{method:m,headers:{'Content-Type':'application/json','x-panel-key':K},body:b?JSON.stringify(b):undefined}).then(function(r){return r.json().then(function(j){if(r.status==401){K='';sessionStorage.removeItem('k');}if(!r.ok)throw new Error(j.error||'Lỗi');return j;});});}
function say(t){document.getElementById('msg').textContent=t;}
function load(){
 if(!K){K=prompt('Mật khẩu bảng điều khiển:')||'';sessionStorage.setItem('k',K);}
 api('GET','/panel/api/bots').then(function(bots){
  var l=document.getElementById('list');l.innerHTML='';
  bots.forEach(function(b){
   var d=document.createElement('div');d.className='card';
   var r=document.createElement('div');r.className='row';
   var t=document.createElement('div');t.innerHTML='<b></b><br><small></small>';
   t.querySelector('b').textContent=(b.online?'🟢 ':'⚫ ')+b.name;
   t.querySelector('small').textContent='Token: '+b.tail;
   var a=document.createElement('div');
   var bt=document.createElement('button');bt.className=b.enabled?'off':'on';bt.textContent=b.enabled?'Tắt':'Bật';
   bt.onclick=function(){say('Đang xử lý...');api('POST','/panel/api/bots/'+b.id+'/toggle').then(load).catch(function(e){say(e.message);load();});};
   a.appendChild(bt);
   if(b.id!=='main'){var x=document.createElement('button');x.className='del';x.textContent='Xóa';x.style.marginLeft='6px';x.onclick=function(){if(confirm('Xóa bot này?'))api('DELETE','/panel/api/bots/'+b.id).then(load).catch(function(e){say(e.message);});};a.appendChild(x);}
   r.appendChild(t);r.appendChild(a);d.appendChild(r);l.appendChild(d);
  });say('');
 }).catch(function(e){say(e.message);});
}
function add(){var i=document.getElementById('tk');say('Đang thêm bot...');api('POST','/panel/api/bots',{token:i.value}).then(function(){i.value='';load();}).catch(function(e){say(e.message);});}
load();
</script></body></html>`;
const running = new Map(); // id -> Client đang chạy
const BOTS_KEY = 'panel_bots'; // hash trong Redis: id -> JSON {name, token?, enabled}

function startBot(id, token) {
    return new Promise((resolve, reject) => {
        if (running.has(id)) return resolve(running.get(id));
        const c = new Client({ intents: [GatewayIntentBits.Guilds] });
        const timer = setTimeout(() => { c.destroy(); reject(new Error('Quá thời gian chờ đăng nhập')); }, 30000);
        c.on('error', err => console.error(`[bot ${id}]`, err.message));
        c.on('interactionCreate', onInteraction);
        c.once(Events.ClientReady, async () => {
            clearTimeout(timer);
            running.set(id, c);
            await onReady(c, token);
            resolve(c);
        });
        c.login(token).catch(e => { clearTimeout(timer); c.destroy(); reject(e); });
    });
}
async function stopBot(id) {
    const c = running.get(id);
    if (!c) return;
    running.delete(id);
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
app.get('/panel/api/bots', panelAuth, async (req, res) => res.json((await getBots()).map(botView)));
app.post('/panel/api/bots', panelAuth, async (req, res) => {
    const token = String((req.body && req.body.token) || '').trim();
    if (!token) return res.status(400).json({ error: 'Thiếu token' });
    if ((await getBots()).some(b => tokenOf(b) === token)) return res.status(400).json({ error: 'Token này đã có rồi' });
    const id = crypto.randomBytes(4).toString('hex');
    try {
        const c = await startBot(id, token);
        await saveBot({ id, name: c.user.tag, token, enabled: true });
        res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: 'Token sai hoặc không đăng nhập được: ' + e.message }); }
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

(async () => {
    for (const b of await getBots()) {
        if (!b.enabled || !tokenOf(b)) continue;
        startBot(b.id, tokenOf(b)).catch(e => console.error(`❌ Bot "${b.name}" lỗi:`, e.message));
    }
})();
