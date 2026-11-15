require('dotenv').config();
const vm = require('vm');
const express = require('express');
const crypto = require('crypto');
const Redis = require('ioredis');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags, Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

if (!process.env.DISCORD_TOKEN) console.warn('⚠️ Không có DISCORD_TOKEN trong .env: bot chính sẽ không chạy, chỉ chạy các bot thêm từ bảng điều khiển.');
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
process.on('uncaughtException', err => console.error('[uncaughtException]', err));

const app = express();
app.use(express.json({ limit: '3mb' }));
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
        new SlashCommandBuilder().setName('reg').setDescription('Chọn loại cloud và lấy tài khoản (10 xu)'),
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

// ===== /reg: CHỌN HÃNG CLOUD =====
// Avatar mỗi hãng: đặt link ảnh vào biến ICON_VMOS, ICON_VSPHONE, ICON_UGPHONE (Render > Environment)
const CLOUD_PROVIDERS = {
    vmos:    { name: 'VMOS Cloud', emoji: '☁️', color: 0x2f6bff, icon: process.env.ICON_VMOS,    ready: true },
    vsphone: { name: 'VSPhone',    emoji: '📱', color: 0x7b4dff, icon: process.env.ICON_VSPHONE, ready: false },
    ugphone: { name: 'UGPhone',    emoji: '🟢', color: 0x18c27a, icon: process.env.ICON_UGPHONE, ready: false },
};
const hasIcon = p => typeof p.icon === 'string' && p.icon.startsWith('http');
function providerAuthor(p) { return hasIcon(p) ? { name: p.name, iconURL: p.icon } : { name: `${p.emoji} ${p.name}` }; }
function inRegChannel(interaction) {
    const chName = (interaction.channel?.name || '').toLowerCase();
    return chName.replace(/-/g, '_') === 'reg_cloud_phone';
}
function regEmbeds() {
    return Object.values(CLOUD_PROVIDERS).map(p => new EmbedBuilder().setColor(p.color).setAuthor(providerAuthor(p)).setDescription(p.ready ? 'Sẵn sàng, 10 xu mỗi lần lấy.' : 'Sắp có.'));
}
function regMenu() {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('reg_select').setPlaceholder('Chọn loại cloud').addOptions(
            Object.entries(CLOUD_PROVIDERS).map(([key, p]) => ({ label: p.name, value: key, emoji: p.emoji, description: p.ready ? '10 xu mỗi lần' : 'Sắp có' }))
        )
    );
}
async function handleRegSelect(interaction) {
    if (!inRegChannel(interaction)) return interaction.update({ content: '❌ Lệnh `/reg` chỉ dùng được trong kênh **#reg_cloud_phone**.', embeds: [], components: [] });
    const prov = CLOUD_PROVIDERS[interaction.values[0]];
    if (!prov) return interaction.update({ content: '❌ Lựa chọn không hợp lệ.', embeds: regEmbeds(), components: [regMenu()] });
    if (!prov.ready) return interaction.update({ content: `⏳ ${prov.name} sắp có, bạn chọn loại khác nhé.`, embeds: regEmbeds(), components: [regMenu()] });
    await interaction.deferUpdate();
    const userId = interaction.user.id;
    try {
        const remaining = await redis.decrby(`coins_${userId}`, 10);
        if (remaining < 0) {
            await redis.incrby(`coins_${userId}`, 10);
            return interaction.editReply({ content: '❌ Không đủ 10 xu.', embeds: regEmbeds(), components: [regMenu()] });
        }
        let data;
        try {
            const response = await fetch('https://wxygtmfttyidwnhjdwdw.supabase.co/functions/v1/get-key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': process.env.APIKEY }, body: JSON.stringify({ clientId: crypto.randomUUID() }), signal: AbortSignal.timeout(15000) });
            data = await response.json();
            if (!data.content) throw new Error('Lỗi lấy dữ liệu.');
        } catch (err) {
            await redis.incrby(`coins_${userId}`, 10); // hoàn xu
            throw new Error(err.message || 'Lỗi lấy dữ liệu.');
        }
        const [mail = 'Không có', pass = 'Không có', code = 'Không có'] = data.content.split('|');
        const embed = new EmbedBuilder().setColor(prov.color).setAuthor(providerAuthor(prov)).setTitle('Lấy tài khoản thành công')
            .addFields(
                { name: '📧 Tài khoản', value: `\`${mail}\`` },
                { name: '🔑 Mật khẩu', value: `\`${pass}\`` },
                { name: '🎁 Mã mời', value: `\`${code}\`` }
            ).setFooter({ text: `Đã trừ 10 xu, số dư còn lại ${remaining} xu` });
        if (hasIcon(prov)) embed.setThumbnail(prov.icon);
        await interaction.editReply({ content: null, embeds: [embed], components: [] });
    } catch (error) {
        await interaction.editReply({ content: `❌ ${error.message}`, embeds: regEmbeds(), components: [regMenu()] });
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
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' },
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
    if (interaction.isStringSelectMenu() && interaction.customId === 'reg_select') return handleRegSelect(interaction);
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
        if (!inRegChannel(interaction)) {
            return interaction.reply({ content: '❌ Lệnh `/reg` chỉ dùng được trong kênh **#reg_cloud_phone**.', flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ content: '**Chọn loại cloud bạn muốn lấy:**', embeds: regEmbeds(), components: [regMenu()], flags: MessageFlags.Ephemeral });
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
<button class="ghost" style="margin-top:10px;width:100%" onclick="resetUpd()">Quay về bản trên GitHub</button></div>
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
  view(false);var l=$('list');l.innerHTML='';
  bots.forEach(function(b){l.appendChild(row(b))});
  var on=bots.filter(function(b){return b.online}).length;
  $('sum').innerHTML='<b>'+on+' đang chạy</b>, '+bots.length+' bot tất cả';
 }).catch(function(e){toast(e.message,true)})}
function add(){var i=$('tk'),b=$('addb');if(!i.value.trim()){toast('Hãy dán token bot trước',true);return}
 b.disabled=true;b.textContent='Đang đăng nhập bot...';
 api('POST','/panel/api/bots',{token:i.value}).then(function(){i.value='';toast('Đã thêm bot và đang chạy');load()}).catch(function(e){toast(e.message,true)}).then(function(){b.disabled=false;b.textContent='Thêm và chạy'})}
function waitBack(){var n=0;(function t(){fetch('/panel/api/bots',{headers:{'x-panel-key':K}}).then(function(r){if(r.ok){toast('Bot đã chạy lại');load()}else throw 0}).catch(function(){if(++n<40)setTimeout(t,3000);else toast('Chưa thấy bot chạy lại, hãy xem Logs trên Render',true)})})()}
function chk(r){return r.json().catch(function(){return {}}).then(function(j){if(!r.ok)throw new Error(j.error||'Có lỗi xảy ra');return j})}
function upd(){var f=$('sf').files[0];if(!f){toast('Hãy chọn file server.js',true);return}if(!$('dk').value){toast('Nhập mã cập nhật',true);return}
 var b=$('updb');b.disabled=true;b.textContent='Đang gửi...';
 f.text().then(function(code){return fetch('/panel/api/update',{method:'POST',headers:{'Content-Type':'application/json','x-panel-key':K,'x-deploy-key':$('dk').value},body:JSON.stringify({code:code})})}).then(chk).then(function(){toast('Đã lưu, bot đang khởi động lại...');waitBack()}).catch(function(e){toast(e.message,true)}).then(function(){b.disabled=false;b.textContent='Lưu và khởi động lại'})}
function resetUpd(){if(!$('dk').value){toast('Nhập mã cập nhật',true);return}if(!confirm('Quay về bản server.js trên GitHub?'))return;
 fetch('/panel/api/update',{method:'DELETE',headers:{'x-panel-key':K,'x-deploy-key':$('dk').value}}).then(chk).then(function(){toast('Đang quay về bản GitHub...');waitBack()}).catch(function(e){toast(e.message,true)})}
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

(async () => {
    for (const b of await getBots()) {
        if (!b.enabled || !tokenOf(b)) continue;
        startBot(b.id, tokenOf(b)).catch(e => console.error(`❌ Bot "${b.name}" lỗi:`, e.message));
    }
})();
