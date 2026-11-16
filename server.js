require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const db = require('./database');
const HANAMI_URL = 'https://hanaminikata.com/dev/buy_device_cloud';
const CLOUD_NAMES = { UG: 'UGPhone', VM: 'VMOS', VS: 'VSPhone' };
const PAY_MIN = 10;          // số xu tối thiểu mỗi lần /pay
const PAY_FEE_RATE = 0.05;   // phí chuyển 5%
const LEADERBOARD_INTERVAL_MS = 10 * 60 * 1000; // cập nhật bảng xếp hạng mỗi 10 phút
const busyUsers = new Set();
const pendingStarUsers = new Set(); // userId đang chờ admin duyệt nhiệm vụ /star
const STAR_REWARD = 10;
const STAR_DAILY_MAX = 3;
 // chặn bấm lệnh đồng thời (tránh nhận/chuyển xu 2 lần)

const app = express();
const PORT = process.env.PORT || 3000;
// Base URL của web server (Render cung cấp dạng https://ten-service.onrender.com)
// Bot tự lấy domain từ biến môi trường RENDER_EXTERNAL_URL (Render set sẵn) hoặc BASE_URL bạn tự cấu hình
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

// Hàm sinh Gift Code (8 ký tự bao gồm ký tự đặc biệt)
function generateGiftCode() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let result = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) {
        result += chars[bytes[i] % chars.length];
    }
    return result;
}

// Lấy danh sách Admin từ .env
function getAdminIds() {
    return (process.env.ADMIN_DISCORD_ID || '').split(',').map(id => id.trim()).filter(id => id);
}

// Lấy ngày hiện tại (UTC+7)
function getTodayString() {
    const now = new Date();
    const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    return vnTime.toISOString().split('T')[0];
}

// ==========================================
// PHẦN 1: WEB SERVER (NHẬN XU)
// ==========================================
// Route gốc + healthcheck: Render dùng để kiểm tra service còn sống (không có route này bot sẽ bị restart liên tục)
app.get('/', (req, res) => res.status(200).send('Bot Cloud Phone đang chạy ✅'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));

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
        const sessionData = await db.getAndDeleteSession(sid);
        if (!sessionData) return renderError("Link này đã được sử dụng hoặc đã hết hạn.");

        const { user_id, provider } = sessionData;
        const newBalance = await db.updateCoins(user_id, 50);

        console.log(`[WEB] User ${user_id} vượt link ${provider}. +50 xu. Số dư: ${newBalance}`);

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

app.listen(PORT, '0.0.0.0', () => console.log(`\n✅ Web Server đang chạy: ${BASE_URL} (port ${PORT})`));

// In IP outbound mỗi lần khởi động (để đưa vào whitelist) + thử xem KingDev có bị Cloudflare chặn không
(async () => {
    try {
        const ip = await (await fetch('https://api.ipify.org?format=json')).json();
        console.log(`[IP] IP outbound hiện tại: ${ip.ip}`);
    } catch (e) { console.log('[IP] Không lấy được IP:', e.message); }
    try {
        const r = await fetch(HANAMI_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            body: JSON.stringify({ token: 'probe', cloud_id: 'VM', input_data: 'probe' })
        });
        const t = await r.text();
        console.log(`[IP] Thử Hanami: HTTP ${r.status} - ${t.trim().startsWith('{') ? 'JSON (không bị chặn)' : 'HTML (bị Cloudflare chặn)'}`);
    } catch (e) { console.log('[IP] Thử Hanami lỗi:', e.message); }
})();

// ==========================================
// PHẦN 2: DISCORD BOT
// ==========================================
// ===== ADMIN: Owner (env ADMIN_DISCORD_ID) + admin cấp bằng /op (bảng admins) =====
async function isAdmin(userId) {
    if (getAdminIds().includes(userId)) return true;
    try { return await db.isAdmin(userId); } catch (e) { console.error('[admin] không đọc được bảng admins:', e.message); return false; }
}

// ===== BẢNG XẾP HẠNG COIN QUA WEBHOOK =====
async function updateLeaderboard() {
    const url = process.env.LEADERBOARD_WEBHOOK_URL;
    if (!url) return;
    try {
        const top = await db.getTopCoins(10);
        const medals = ['🥇', '🥈', '🥉'];
        const lines = top.length
            ? top.map((u, i) => `${medals[i] || `**${i + 1}.**`} <@${u.user_id}> — **${Number(u.balance).toLocaleString('en-US')}** xu`)
            : ['Chưa có ai trong bảng xếp hạng.'];
        const payload = {
            allowed_mentions: { parse: [] },
            embeds: [{
                title: '🏆 Bảng xếp hạng Coin',
                description: lines.join('\n'),
                color: 0xF1C40F,
                footer: { text: 'Cập nhật mỗi 10 phút' },
                timestamp: new Date().toISOString()
            }]
        };
        const headers = { 'Content-Type': 'application/json' };
        let msgId = null;
        try { msgId = await db.getKv('leaderboard_message_id'); } catch (e) { console.error('[BXH] không đọc được bảng kv:', e.message); }

        if (msgId) {
            const res = await fetch(`${url}/messages/${msgId}`, { method: 'PATCH', headers, body: JSON.stringify(payload) });
            if (res.ok) return;
            if (res.status !== 404) return console.error(`[BXH] sửa tin nhắn lỗi HTTP ${res.status}`);
        }
        const res = await fetch(`${url}?wait=true`, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!res.ok) return console.error(`[BXH] gửi webhook lỗi HTTP ${res.status}`);
        const msg = await res.json();
        try { await db.setKv('leaderboard_message_id', msg.id); } catch (e) { console.error('[BXH] không lưu được message id (bảng kv):', e.message); }
    } catch (e) {
        console.error('[BXH] lỗi cập nhật bảng xếp hạng:', e.message);
    }
}

client.once('ready', async () => {
    const commands = [
        new SlashCommandBuilder().setName('getlink').setDescription('Lấy link nhiệm vụ để nhận 50 xu (Tối đa 2 lần/ngày)')
            .addStringOption(opt => opt.setName('provider').setDescription('Chọn dịch vụ rút gọn link').addChoices(
                { name: 'Link4M', value: 'link4m' },
                { name: 'LayMa', value: 'layma' }
            ).setRequired(false)),
        new SlashCommandBuilder().setName('reg').setDescription('Lấy mail|pass (Tốn 10 xu)'),
        new SlashCommandBuilder().setName('vi').setDescription('Xem số dư xu của bạn'),
        new SlashCommandBuilder().setName('code').setDescription('Nhập Gift Code để nhận xu')
            .addStringOption(o => o.setName('gift_code').setDescription('Mã quà tặng').setRequired(true)),
        new SlashCommandBuilder().setName('buycloud').setDescription('Mua máy Cloud (Miễn phí)')
            .addStringOption(o => o.setName('provider').setDescription('Loại cloud').setRequired(true)
                .addChoices({ name: 'UGPhone', value: 'UG' }, { name: 'VMOS', value: 'VM' }, { name: 'VSPhone', value: 'VS' }))
            .addStringOption(o => o.setName('server').setDescription('Khu vực (bắt buộc với UGPhone)').setRequired(false)
                .addChoices({ name: 'Singapore', value: 'SG' }, { name: 'Hong Kong', value: 'HK' }, { name: 'Japan', value: 'JP' }, { name: 'Germany', value: 'DE' }, { name: 'US', value: 'US' })),
        new SlashCommandBuilder().setName('star').setDescription('Nhận nhiệm vụ đăng ký kênh YouTube để nhận xu'),
        new SlashCommandBuilder().setName('sdone').setDescription('(Admin) Xác nhận user hoàn thành nhiệm vụ /star')
            .addUserOption(o => o.setName('user').setDescription('Chọn người dùng').setRequired(false))
            .addStringOption(o => o.setName('id').setDescription('Hoặc nhập ID Discord').setRequired(false)),
        new SlashCommandBuilder().setName('adcoin').setDescription('Chỉnh số xu của người dùng (Admin)')
            .addStringOption(o => o.setName('hanhdong').setDescription('Hành động').setRequired(true)
                .addChoices({ name: 'set (đặt bằng)', value: 'set' }, { name: 'cộng', value: 'cong' }, { name: 'trừ', value: 'tru' }))
            .addIntegerOption(o => o.setName('sotien').setDescription('Số xu').setRequired(true).setMinValue(0))
            .addUserOption(o => o.setName('user').setDescription('Chọn người dùng').setRequired(false))
            .addStringOption(o => o.setName('id').setDescription('Hoặc nhập ID Discord').setRequired(false)),
        new SlashCommandBuilder().setName('daily').setDescription('Nhận quà hàng ngày (ngẫu nhiên 1-20 xu)'),
        new SlashCommandBuilder().setName('pay').setDescription('Chuyển xu cho người khác (phí 5%)')
            .addUserOption(o => o.setName('nguoinhan').setDescription('Người nhận').setRequired(true))
            .addIntegerOption(o => o.setName('sotien').setDescription(`Số xu muốn chuyển (tối thiểu ${PAY_MIN})`).setRequired(true).setMinValue(PAY_MIN)),
        new SlashCommandBuilder().setName('op').setDescription('Cấp quyền admin (Owner)')
            .addUserOption(o => o.setName('user').setDescription('Chọn người dùng').setRequired(false))
            .addStringOption(o => o.setName('id').setDescription('Hoặc nhập ID Discord').setRequired(false)),
        new SlashCommandBuilder().setName('unop').setDescription('Thu hồi quyền admin (Owner)')
            .addUserOption(o => o.setName('user').setDescription('Chọn người dùng').setRequired(false))
            .addStringOption(o => o.setName('id').setDescription('Hoặc nhập ID Discord').setRequired(false)),
        new SlashCommandBuilder().setName('gen').setDescription('Tạo Gift Code (Admin)')
            .addIntegerOption(o => o.setName('soluong').setDescription('Số lượng code').setRequired(true))
            .addIntegerOption(o => o.setName('xuthuong').setDescription('Số xu mỗi code').setRequired(true)),
        new SlashCommandBuilder().setName('clear').setDescription('Xóa tin nhắn của Bot cũ hơn 2 giờ (Admin)')
    ].map(c => c.toJSON());

    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log(`✅ Bot online: ${client.user.tag}`);
        console.log(`✅ Đã đăng ký lệnh Slash!`);
    } catch (error) {
        console.error('Lỗi đăng ký lệnh:', error);
    }

    if (process.env.LEADERBOARD_WEBHOOK_URL) {
        updateLeaderboard();
        setInterval(updateLeaderboard, LEADERBOARD_INTERVAL_MS);
    }
});

// ===== MUA CLOUD QUA HANAMI =====

async function buyHanami(cloudId, server, inputData) {
    const body = { token: process.env.HANAMI_TOKEN, cloud_id: cloudId, input_data: inputData };
    if (server) body.server = server;
    const response = await fetch(HANAMI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify(body)
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch (e) {
        console.error(`[buycloud] Hanami trả về không phải JSON (HTTP ${response.status}):`, raw.slice(0, 300));
        const snippet = raw.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
        return { ok: false, message: `Hanami trả về HTML thay vì JSON (HTTP ${response.status}): ${snippet.replace(/`/g, "'")}` };
    }
    return { ok: data.code === 0, message: data.message || 'Không rõ' };
}

async function handleBuycloudModal(interaction) {
    const [, cloudId, serverRaw] = interaction.customId.split(':');
    const server = serverRaw === '-' ? null : serverRaw;
    const inputData = interaction.fields.getTextInputValue('input_data').trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        if (!process.env.HANAMI_TOKEN) return await interaction.editReply({ content: '❌ Bot chưa cấu hình HANAMI_TOKEN.' });
        if (cloudId !== 'UG' && !inputData.includes('|')) {
            return await interaction.editReply({ content: '❌ Sai định dạng. Nhập theo dạng: `tài khoản|mật khẩu`' });
        }
        const result = await buyHanami(cloudId, server, inputData);
        if (result.ok) {
            await interaction.editReply({ content: `✅ **Mua ${CLOUD_NAMES[cloudId]} thành công!**${server ? ` (${server})` : ''}\n${result.message}` });
        } else {
            await interaction.editReply({ content: `❌ Lỗi từ Hanami: ${result.message}`.slice(0, 1900) });
        }
    } catch (error) {
        console.error('[buycloud] lỗi:', error, error.cause);
        await interaction.editReply({ content: `❌ Lỗi kết nối: ${error.message}${error.cause ? ' - ' + (error.cause.code || error.cause.message) : ''}` });
    }
}

client.on('interactionCreate', async interaction => {
    if (interaction.isModalSubmit() && interaction.customId.startsWith('buycloud:')) return handleBuycloudModal(interaction);
    if (!interaction.isChatInputCommand()) return;
    const adminIds = getAdminIds();
    const userId = interaction.user.id;

    // LỆNH /getlink
    if (interaction.commandName === 'getlink') {
        const provider = interaction.options.getString('provider') || 'link4m';
        const today = getTodayString();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const currentCount = await db.checkDailyLimit(userId, provider, today);
            if (currentCount >= 2) {
                return await interaction.editReply({ content: `❌ Bạn đã đạt giới hạn **2 lần/ngày** cho dịch vụ này.` });
            }

            const sessionId = crypto.randomBytes(16).toString('hex');
            await db.createSession(sessionId, userId, provider);

            const targetUrl = `${BASE_URL}/redeem?sid=${sessionId}`;
            let finalUrl = '';
            let providerName = '';

            if (provider === 'link4m') {
                providerName = 'Link4M';
                const apiUrl = `https://link4m.co/api-shorten/v2?api=${process.env.LINK4M_API_KEY}&url=${encodeURIComponent(targetUrl)}`;
                const res = await fetch(apiUrl, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
                const data = await res.json();
                if (data.status === "success" && data.shortenedUrl) finalUrl = data.shortenedUrl;
                else throw new Error("Lỗi từ Link4M");
            } else if (provider === 'layma') {
                providerName = 'LayMa';
                const apiUrl = `https://api.layma.net/api/admin/shortlink/quicklink?tokenUser=${process.env.LAYMA_TOKEN}&format=json&url=${encodeURIComponent(targetUrl)}`;
                const res = await fetch(apiUrl);
                const data = await res.json();
                if (data.success === true && data.html) finalUrl = data.html;
                else throw new Error("Lỗi từ LayMa");
            }

            await db.increaseDailyLimit(userId, provider, today);

            const embed = new EmbedBuilder()
                .setColor(provider === 'link4m' ? 0xffc107 : 0x8b5cf6)
                .setTitle(`🔗 LINK NHẬN XU (${providerName})`)
                .setDescription(`Bấm vào link để vượt nhiệm vụ và nhận **50 xu**.\nBạn còn **${1 - currentCount}** lượt cho hôm nay.`)
                .addFields({ name: 'Link nhiệm vụ', value: finalUrl });
            await interaction.editReply({ embeds: [embed] });
        } catch (e) {
            await interaction.editReply({ content: `❌ ${e.message}` });
        }
    }

    // LỆNH /vi
    if (interaction.commandName === 'vi') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const coins = await db.getCoins(userId);
            await interaction.editReply({ content: `💰 Số dư của bạn: **${coins} xu**` });
        } catch (error) {
            await interaction.editReply({ content: `❌ Lỗi khi lấy số dư.` });
        }
    }

    // LỆNH /code
    if (interaction.commandName === 'code') {
        const giftCode = interaction.options.getString('gift_code').trim();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const amount = await db.redeemGiftCode(giftCode);
            if (!amount) return await interaction.editReply({ content: `❌ Gift Code không hợp lệ hoặc đã được sử dụng.` });

            const newBalance = await db.updateCoins(userId, amount);
            await interaction.editReply({ content: `✅ Nhập code thành công! Bạn nhận được **${amount} xu**.\n💰 Số dư mới: **${newBalance} xu**` });
        } catch (error) {
            await interaction.editReply({ content: `❌ Lỗi khi nhập code.` });
        }
    }

    // LỆNH /reg
    if (interaction.commandName === 'reg') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const currentCoins = await db.getCoins(userId);
            if (currentCoins < 10) {
                return await interaction.editReply({ content: `❌ Bạn không đủ xu (Cần 10 xu). Số dư: **${currentCoins} xu**.` });
            }

            const response = await fetch(process.env.REG_API_URL || 'https://wxygtmfttyidwnhjdwdw.supabase.co/functions/v1/get-key', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': process.env.APIKEY },
                body: JSON.stringify({ clientId: crypto.randomUUID() })
            });
            const data = await response.json();
            if (!data.content) throw new Error("Không lấy được dữ liệu.");

            const newBalance = await db.updateCoins(userId, -10);
            const [mail, ...passParts] = data.content.split('|');
            
            await interaction.editReply({ 
                content: `✅ Mua thành công! (Đã trừ 10 xu)\n📧 \`${mail}\`\n🔑 \`${passParts.join('|')}\`\n💰 Số dư còn lại: **${newBalance} xu**` 
            });
        } catch (error) { 
            console.error('[reg] lỗi:', error, error.cause);
            await interaction.editReply({ content: `❌ ${error.message}${error.cause ? ' - ' + (error.cause.code || error.cause.message) : ''} (Chưa bị trừ xu).` }); 
        }
    }

    // LỆNH /buycloud (mở bảng nhập dữ liệu)
    if (interaction.commandName === 'buycloud') {
        const cloudId = interaction.options.getString('provider');
        const server = interaction.options.getString('server');
        if (cloudId === 'UG' && !server) {
            return interaction.reply({ content: '❌ UGPhone cần chọn thêm **server** (khu vực).', flags: MessageFlags.Ephemeral });
        }
        const isUG = cloudId === 'UG';
        const input = new TextInputBuilder()
            .setCustomId('input_data')
            .setLabel(isUG ? 'Local Storage (cookie) của UGPhone' : 'Tài khoản|Mật khẩu')
            .setStyle(isUG ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setPlaceholder(isUG ? 'Dán chuỗi Local Storage vào đây' : 'mail|matkhau hoặc user|matkhau')
            .setRequired(true)
            .setMaxLength(4000);
        const modal = new ModalBuilder()
            .setCustomId(`buycloud:${cloudId}:${isUG ? server : '-'}`)
            .setTitle(`Mua ${CLOUD_NAMES[cloudId]}${isUG ? ' - ' + server : ''}`)
            .addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
    }

    // LỆNH /daily
    if (interaction.commandName === 'daily') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (busyUsers.has(userId)) return interaction.editReply({ content: '⏳ Bạn đang có thao tác khác, thử lại sau giây lát.' });
        busyUsers.add(userId);
        try {
            const today = getTodayString();
            const claimed = await db.checkDailyLimit(userId, 'daily', today);
            if (claimed > 0) {
                return await interaction.editReply({ content: '⏰ Hôm nay bạn đã nhận quà rồi. Quay lại vào ngày mai (sau 0h giờ VN) nhé!' });
            }
            const reward = crypto.randomInt(1, 21); // 1-20
            await db.increaseDailyLimit(userId, 'daily', today); // đánh dấu đã nhận trước để chống nhận 2 lần
            const newBalance = await db.updateCoins(userId, reward);
            await interaction.editReply({ content: `🎁 Quà hàng ngày: bạn nhận được **${reward} xu**!\n💰 Số dư: **${newBalance} xu**` });
        } catch (error) {
            console.error('[daily] lỗi:', error);
            await interaction.editReply({ content: '❌ Lỗi khi nhận quà hàng ngày.' });
        } finally {
            busyUsers.delete(userId);
        }
    }

    // LỆNH /pay (phí 5%, người gửi bị trừ đủ số xu, người nhận được số xu sau khi trừ phí)
    if (interaction.commandName === 'pay') {
        const target = interaction.options.getUser('nguoinhan');
        const amount = interaction.options.getInteger('sotien');
        if (target.bot) return interaction.reply({ content: '❌ Không thể chuyển xu cho bot.', flags: MessageFlags.Ephemeral });
        if (target.id === userId) return interaction.reply({ content: '❌ Bạn không thể tự chuyển xu cho chính mình.', flags: MessageFlags.Ephemeral });
        if (amount < PAY_MIN) return interaction.reply({ content: `❌ Số xu tối thiểu mỗi lần chuyển là **${PAY_MIN}**.`, flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (busyUsers.has(userId) || busyUsers.has(target.id)) {
            return interaction.editReply({ content: '⏳ Một trong hai người đang có giao dịch khác, thử lại sau giây lát.' });
        }
        busyUsers.add(userId); busyUsers.add(target.id);
        try {
            const balance = await db.getCoins(userId);
            if (balance < amount) {
                return await interaction.editReply({ content: `❌ Bạn không đủ xu. Số dư: **${balance} xu**.` });
            }
            const fee = Math.ceil(amount * PAY_FEE_RATE);
            const received = amount - fee;
            const newBalance = await db.updateCoins(userId, -amount);
            try {
                await db.updateCoins(target.id, received);
            } catch (e) {
                await db.updateCoins(userId, amount).catch(() => {}); // hoàn xu nếu cộng cho người nhận thất bại
                throw e;
            }
            await interaction.editReply({ content: `✅ Đã chuyển **${amount} xu** (phí ${fee} xu).\n💰 Số dư còn lại: **${newBalance} xu**` });
            await interaction.followUp({ content: `💸 <@${userId}> đã chuyển cho <@${target.id}> **${received} xu** (phí 5%: ${fee} xu).` }).catch(() => {});
        } catch (error) {
            console.error('[pay] lỗi:', error);
            await interaction.editReply({ content: '❌ Lỗi khi chuyển xu, giao dịch đã được hủy.' });
        } finally {
            busyUsers.delete(userId); busyUsers.delete(target.id);
        }
    }

    // LỆNH /op và /unop (chỉ Owner trong ADMIN_DISCORD_ID)
    if (interaction.commandName === 'op' || interaction.commandName === 'unop') {
        if (!adminIds.includes(userId)) {
            return interaction.reply({ content: '❌ Chỉ Owner mới dùng được lệnh này.', flags: MessageFlags.Ephemeral });
        }
        const pickedUser = interaction.options.getUser('user');
        const targetId = pickedUser ? pickedUser.id : (interaction.options.getString('id') || '').trim();
        if (!/^\d{15,25}$/.test(targetId)) {
            return interaction.reply({ content: '❌ Hãy chọn user hoặc nhập ID Discord hợp lệ (chỉ gồm số).', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            if (adminIds.includes(targetId)) {
                return await interaction.editReply({ content: `❗ <@${targetId}> là Owner (cấu hình ở ADMIN_DISCORD_ID), không đổi được bằng lệnh này.` });
            }
            const already = await db.isAdmin(targetId);
            if (interaction.commandName === 'op') {
                if (already) return await interaction.editReply({ content: `❗ <@${targetId}> đã là admin rồi.` });
                await db.addAdmin(targetId, userId);
                await interaction.editReply({ content: `✅ Đã cấp quyền admin cho <@${targetId}>.` });
            } else {
                if (!already) return await interaction.editReply({ content: `❗ <@${targetId}> không phải admin.` });
                await db.removeAdmin(targetId);
                await interaction.editReply({ content: `✅ Đã thu hồi quyền admin của <@${targetId}>.` });
            }
        } catch (error) {
            console.error('[op/unop] lỗi:', error);
            await interaction.editReply({ content: `❌ Lỗi: ${error.message}`.slice(0, 1900) });
        }
    }

    // LỆNH /star - nhận nhiệm vụ đăng ký kênh YouTube
    if (interaction.commandName === 'star') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const today = getTodayString();
            const done = await db.checkDailyLimit(userId, 'star', today);
            if (done >= STAR_DAILY_MAX) {
                return await interaction.editReply({ content: `⏰ Hôm nay bạn đã hoàn thành tối đa **${STAR_DAILY_MAX} nhiệm vụ** rồi. Quay lại vào ngày mai nhé!` });
            }
            if (pendingStarUsers.has(userId)) {
                return await interaction.editReply({ content: '⏳ Bạn đang có nhiệm vụ chờ duyệt. Hãy đợi admin xác nhận trước khi nhận thêm.' });
            }
            const ytbUrl = process.env.YTB_CHANNEL_URL || 'https://youtube.com';
            pendingStarUsers.add(userId);
            await interaction.editReply({
                content: [
                    `📋 **NHIỆM VỤ: Đăng ký kênh YouTube**`,
                    ``,
                    `**Bước 1:** Truy cập kênh YouTube: ${ytbUrl}`,
                    `**Bước 2:** Bấm nút **Đăng ký** (Subscribe) 🔔`,
                    `**Bước 3:** Chụp màn hình xác nhận đã đăng ký`,
                    `**Bước 4:** Gửi ảnh chụp vào kênh **#${process.env.STAR_CHANNEL_NAME || 'star'}** để admin duyệt`,
                    ``,
                    `💰 Phần thưởng: **${STAR_REWARD} xu** sau khi admin xác nhận`,
                    `📆 Hạn mức: **${STAR_DAILY_MAX - done} lần** còn lại hôm nay`,
                    ``,
                    `⚠️ **Cảnh báo:** Gian lận (ảnh fake/chỉnh sửa) sẽ bị **trừ 20 xu** và hủy nhiệm vụ.`,
                ].join('\n')
            });
        } catch (error) {
            console.error('[star] lỗi:', error);
            pendingStarUsers.delete(userId);
            await interaction.editReply({ content: '❌ Lỗi khi nhận nhiệm vụ.' });
        }
    }

    // LỆNH /sdone - admin xác nhận hoàn thành nhiệm vụ /star
    if (interaction.commandName === 'sdone') {
        if (!(await isAdmin(userId))) {
            return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        }
        const pickedUser = interaction.options.getUser('user');
        const targetId = pickedUser ? pickedUser.id : (interaction.options.getString('id') || '').trim();
        if (!/^\d{15,25}$/.test(targetId)) {
            return interaction.reply({ content: '❌ Hãy chọn user hoặc nhập ID Discord hợp lệ.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (busyUsers.has(targetId)) {
            return interaction.editReply({ content: '⏳ Người này đang có giao dịch khác, thử lại sau giây lát.' });
        }
        busyUsers.add(targetId);
        try {
            if (!pendingStarUsers.has(targetId)) {
                return await interaction.editReply({ content: `❗ <@${targetId}> không có nhiệm vụ nào đang chờ duyệt.` });
            }
            const today = getTodayString();
            const done = await db.checkDailyLimit(targetId, 'star', today);
            if (done >= STAR_DAILY_MAX) {
                pendingStarUsers.delete(targetId);
                return await interaction.editReply({ content: `❗ <@${targetId}> đã đạt giới hạn **${STAR_DAILY_MAX} nhiệm vụ** hôm nay.` });
            }
            await db.increaseDailyLimit(targetId, 'star', today);
            const newBalance = await db.updateCoins(targetId, STAR_REWARD);
            pendingStarUsers.delete(targetId);
            console.log(`[sdone] ${userId} duyệt ${targetId} (+${STAR_REWARD} xu, hôm nay: ${done + 1}/${STAR_DAILY_MAX})`);
            await interaction.editReply({ content: `✅ Đã xác nhận nhiệm vụ cho <@${targetId}>. Cộng **${STAR_REWARD} xu**. (Hôm nay: ${done + 1}/${STAR_DAILY_MAX})` });
            await interaction.followUp({
                content: `🎉 <@${targetId}> đã hoàn thành nhiệm vụ đăng ký kênh YouTube! Nhận **${STAR_REWARD} xu**. 💰 Số dư: **${newBalance} xu**`
            }).catch(() => {});
        } catch (error) {
            console.error('[sdone] lỗi:', error);
            await interaction.editReply({ content: `❌ Lỗi: ${error.message}`.slice(0, 1900) });
        } finally {
            busyUsers.delete(targetId);
        }
    }

    // LỆNH /adcoin <set|cong|tru> <số> (Admin)
    if (interaction.commandName === 'adcoin') {
        if (!(await isAdmin(userId))) {
            return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        }
        const action = interaction.options.getString('hanhdong');
        const amount = interaction.options.getInteger('sotien');
        const pickedUser = interaction.options.getUser('user');
        const targetId = pickedUser ? pickedUser.id : (interaction.options.getString('id') || '').trim();
        if (!/^\d{15,25}$/.test(targetId)) {
            return interaction.reply({ content: '❌ Hãy chọn user hoặc nhập ID Discord hợp lệ (chỉ gồm số).', flags: MessageFlags.Ephemeral });
        }
        if (action !== 'set' && amount < 1) {
            return interaction.reply({ content: '❌ Số xu phải lớn hơn 0.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (busyUsers.has(targetId)) {
            return interaction.editReply({ content: '⏳ Người này đang có giao dịch khác, thử lại sau giây lát.' });
        }
        busyUsers.add(targetId);
        try {
            const current = await db.getCoins(targetId);
            let delta;
            if (action === 'set') delta = amount - current;
            else if (action === 'cong') delta = amount;
            else delta = -Math.min(amount, current); // trừ không xuống dưới 0
            const newBalance = delta === 0 ? current : await db.updateCoins(targetId, delta);
            console.log(`[ADMIN] ${userId} ${action} ${amount} -> ${targetId} (${current} => ${newBalance})`);
            const verb = action === 'set' ? 'Đặt' : (action === 'cong' ? 'Cộng' : 'Trừ');
            await interaction.editReply({ content: `✅ ${verb} **${action === 'set' ? amount : Math.abs(delta)} xu** cho <@${targetId}>.\n💰 Số dư: **${current} → ${newBalance} xu**` });
        } catch (error) {
            console.error('[adcoin] lỗi:', error);
            await interaction.editReply({ content: `❌ Lỗi: ${error.message}`.slice(0, 1900) });
        } finally {
            busyUsers.delete(targetId);
        }
    }

    // LỆNH /gen
    if (interaction.commandName === 'gen') {
        if (!(await isAdmin(userId))) {
            return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        }
        const count = interaction.options.getInteger('soluong');
        const coinAmount = interaction.options.getInteger('xuthuong');

        if (count <= 0 || count > 50 || coinAmount <= 0) {
            return interaction.reply({ content: '❌ Số lượng từ 1-50, số xu > 0.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const giftCodes = [];
            for (let i = 0; i < count; i++) {
                const code = generateGiftCode();
                giftCodes.push(`${code} (${coinAmount} xu)`);
                await db.createGiftCode(code, coinAmount);
            }
            await interaction.editReply({
                content: `✅ Đã tạo **${count}** Gift Code (Mỗi code ${coinAmount} xu):`,
                files: [{ attachment: Buffer.from(giftCodes.join('\n')), name: `giftcodes_${count}.txt` }]
            });
        } catch (error) {
            console.error('[gen] lỗi:', error, error.cause);
            await interaction.editReply({ content: `❌ Lỗi tạo code: ${error.message}${error.cause ? ' - ' + (error.cause.code || error.cause.message) : ''}`.slice(0, 1800) });
        }
    }

    // LỆNH /clear
    if (interaction.commandName === 'clear') {
        if (!(await isAdmin(userId))) {
            return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const channel = interaction.channel;
            const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
            const messages = await channel.messages.fetch({ limit: 100 });
            const messagesToDelete = messages.filter(msg => msg.author.id === client.user.id && msg.createdTimestamp < twoHoursAgo);

            if (messagesToDelete.size === 0) {
                return await interaction.editReply({ content: 'ℹ️ Không có tin nhắn nào của Bot cũ hơn 2 giờ.' });
            }
            await channel.bulkDelete(messagesToDelete, true);
            await interaction.editReply({ content: `✅ Đã xóa **${messagesToDelete.size}** tin nhắn.` });
        } catch (error) {
            await interaction.editReply({ content: `❌ Lỗi: ${error.message}` });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
