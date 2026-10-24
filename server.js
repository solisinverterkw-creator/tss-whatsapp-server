/**
 * THE SMART SCHOOL — 100% FREE UNLIMITED WHATSAPP GATEWAY (1000+ PARENTS)
 * Sends Official Result Card Images (.png) & PDFs (.pdf) + Captions directly to Parents
 * Zero Monthly Fee • Unlimited Chats • No Links • No Copy-Paste
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const PORT = parseInt(process.env.PORT || '3850', 10);
const BIND_HOST = '0.0.0.0';
const AUTH_DIR = path.join(__dirname, 'wa_session_auth');
const PORTAL_SYNC_URL = process.env.PORTAL_SYNC_URL || 'https://thesmartschool.online/ajax/whatsapp_ai.php';
const RENDER_SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://tss-whatsapp-server.onrender.com';
const SYNC_KEY = 'tss_wa_sync_2026';

let sock = null;
let connectionState = 'connecting'; // 'connecting' | 'qr_ready' | 'authorized' | 'disconnected'
let latestQrDataUrl = '';
let connectedNumber = '';
let isReconnecting = false;
let backupTimer = null;

function httpsRequestJson(urlStr, method = 'GET', bodyObj = null) {
    return new Promise((resolve) => {
        try {
            const u = new URL(urlStr);
            const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
            const opts = {
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                method,
                headers: payload ? {
                    'Content-Type': 'application/json',
                    'Content-Length': payload.length
                } : {},
                timeout: 12000
            };
            const client = u.protocol === 'https:' ? https : http;
            const req = client.request(opts, (res) => {
                let chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch (e) {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            if (payload) req.write(payload);
            req.end();
        } catch (e) {
            resolve(null);
        }
    });
}

async function restoreSessionFromHostinger() {
    try {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }
        const credsPath = path.join(AUTH_DIR, 'creds.json');
        if (fs.existsSync(credsPath)) {
            return; // Already present on disk
        }
        console.log('🔄 Checking Hostinger Cloud Backup for saved WhatsApp session...');
        const res = await httpsRequestJson(`${PORTAL_SYNC_URL}?action=wa_session_restore&sync_key=${SYNC_KEY}`, 'GET');
        if (res && res.ok && res.files && typeof res.files === 'object') {
            let count = 0;
            for (const [fname, b64] of Object.entries(res.files)) {
                const safeName = path.basename(fname);
                fs.writeFileSync(path.join(AUTH_DIR, safeName), Buffer.from(b64, 'base64'));
                count++;
            }
            if (count > 0) {
                console.log(`✅ Restored ${count} WhatsApp session file(s) from Hostinger! Auto-reconnecting without QR...`);
            }
        }
    } catch (e) {
        console.error('Session restore warning:', e.message);
    }
}

function scheduleSessionBackupToHostinger() {
    if (backupTimer) clearTimeout(backupTimer);
    backupTimer = setTimeout(async () => {
        try {
            if (!fs.existsSync(AUTH_DIR)) return;
            const credsPath = path.join(AUTH_DIR, 'creds.json');
            if (!fs.existsSync(credsPath)) return;
            const allFiles = fs.readdirSync(AUTH_DIR);
            const filesMap = {};
            for (const f of allFiles) {
                const full = path.join(AUTH_DIR, f);
                if (fs.statSync(full).isFile()) {
                    filesMap[f] = fs.readFileSync(full).toString('base64');
                }
            }
            await httpsRequestJson(`${PORTAL_SYNC_URL}?action=wa_session_backup&sync_key=${SYNC_KEY}`, 'POST', { files: filesMap });
        } catch (e) {}
    }, 2500);
}

async function clearSessionOnHostinger() {
    try {
        await httpsRequestJson(`${PORTAL_SYNC_URL}?action=wa_session_clear&sync_key=${SYNC_KEY}`, 'POST', {});
    } catch (e) {}
}

// 24/7 Keep-Alive Ping every 4 minutes so Render Free Tier never spins down
setInterval(() => {
    httpsRequestJson(`${PORTAL_SYNC_URL}?action=wa_keepalive`, 'GET');
    httpsRequestJson(`${RENDER_SELF_URL}/status?keepalive=1`, 'GET');
}, 4 * 60 * 1000);

async function startWhatsAppConnection() {
    if (isReconnecting) return;
    isReconnecting = true;
    try {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }
        await restoreSessionFromHostinger();

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        let version = [2, 3000, 1015901307];
        try {
            const vInfo = await fetchLatestBaileysVersion();
            if (vInfo && vInfo.version) version = vInfo.version;
        } catch (e) {}

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            browser: ['The Smart School Portal', 'Chrome', '120.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false,
            keepAliveIntervalMs: 25000
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            scheduleSessionBackupToHostinger();
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                connectionState = 'qr_ready';
                try {
                    latestQrDataUrl = await QRCode.toDataURL(qr, { width: 260, margin: 1 });
                    console.log('📱 [QR READY] Scan the QR Code inside your School Portal (or in this terminal)!');
                } catch (err) {}
            }

            if (connection === 'open') {
                connectionState = 'authorized';
                latestQrDataUrl = '';
                connectedNumber = (sock.user && sock.user.id) ? sock.user.id.split(':')[0] : 'Connected';
                console.log('✅ [WHATSAPP CONNECTED] Number:', connectedNumber, '— Ready to send Unlimited Result Cards (Image/PDF) for FREE!');
                scheduleSessionBackupToHostinger();
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log('⚠️ Connection closed. Status:', statusCode, 'Reconnecting:', shouldReconnect);
                connectionState = 'disconnected';
                latestQrDataUrl = '';

                if (!shouldReconnect) {
                    try {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    } catch (e) {}
                    await clearSessionOnHostinger();
                }
                setTimeout(() => {
                    isReconnecting = false;
                    startWhatsAppConnection();
                }, 2500);
            }
        });
    } catch (err) {
        console.error('Error starting WhatsApp socket:', err.message);
        setTimeout(() => {
            isReconnecting = false;
            startWhatsAppConnection();
        }, 4000);
    } finally {
        isReconnecting = false;
    }
}

function formatJid(rawPhone) {
    let digits = String(rawPhone || '').replace(/\D+/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('03') && digits.length === 11) {
        digits = '92' + digits.slice(1);
    } else if (digits.length === 10 && digits.startsWith('3')) {
        digits = '92' + digits;
    }
    return digits + '@s.whatsapp.net';
}

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(res, status, obj) {
    setCorsHeaders(res);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = urlObj.pathname;

    if (pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const statusHtml = connectionState === 'authorized'
            ? `<h2 style="color:#16a34a;">✅ WhatsApp Connected (${connectedNumber}) — 24/7 Cloud Auto-Send Ready!</h2>`
            : (latestQrDataUrl
                ? `<h3>📱 Scan this QR Code from your Phone WhatsApp (Linked Devices &rarr; Link a Device):</h3><img src="${latestQrDataUrl}" style="border:2px solid #16a34a;padding:8px;border-radius:12px;"/><p><a href="/" style="padding:8px 16px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;">Refresh Status</a></p>`
                : `<h3>⏳ Generating QR Code... Please refresh in 3 seconds.</h3><script>setTimeout(()=>location.reload(),3000);</script>`);
        return res.end(`<!DOCTYPE html><html><head><title>TSS 24/7 Free WhatsApp Cloud Server</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;text-align:center;padding:30px;"><h1>🏫 The Smart School — 24/7 Free WhatsApp Server</h1>${statusHtml}</body></html>`);
    }

    if (pathname === '/status' && req.method === 'GET') {
        return sendJson(res, 200, {
            ok: true,
            connected: connectionState === 'authorized',
            state: connectionState,
            phone: connectedNumber,
            qr_image: latestQrDataUrl,
            status_msg: connectionState === 'authorized'
                ? `✅ Free Unlimited WhatsApp Connected (${connectedNumber})! Ready to send 1000+ Result Cards (Image/PDF) 24/7!`
                : (latestQrDataUrl
                    ? '📱 Scan this QR Code from your Phone WhatsApp (Linked Devices -> Link a Device)!'
                    : '⏳ Generating WhatsApp QR Code, please wait 2 seconds and click Refresh...')
        });
    }

    if (pathname === '/logout' && req.method === 'POST') {
        try {
            if (sock) await sock.logout();
        } catch (e) {}
        try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (e) {}
        await clearSessionOnHostinger();
        connectionState = 'connecting';
        latestQrDataUrl = '';
        connectedNumber = '';
        startWhatsAppConnection();
        return sendJson(res, 200, { ok: true, message: 'Session reset. Generating new QR code...' });
    }

    if (pathname === '/send' && req.method === 'POST') {
        let bodyChunks = [];
        req.on('data', (chunk) => bodyChunks.push(chunk));
        req.on('end', async () => {
            try {
                const rawBody = Buffer.concat(bodyChunks).toString('utf8');
                const data = JSON.parse(rawBody || '{}');

                if (connectionState !== 'authorized' || !sock) {
                    return sendJson(res, 400, {
                        ok: false,
                        error: 'WhatsApp QR Code is not scanned yet. Click "Auto-Send API & QR Setup" to scan the QR code first.'
                    });
                }

                const phone = data.phone || '';
                const message = data.message || '';
                const mediaFormat = (data.media_format || 'image').toLowerCase();
                const mediaBase64 = data.media_base64 || '';
                const fileName = data.filename || data.media_filename || (mediaFormat === 'pdf' ? 'ResultCard.pdf' : 'ResultCard.png');

                if (!phone) {
                    return sendJson(res, 400, { ok: false, error: 'Recipient phone number is required.' });
                }

                const jid = formatJid(phone);

                if (mediaBase64) {
                    const cleanB64 = mediaBase64.replace(/^data:[^;]+;base64,/, '');
                    const fileBuffer = Buffer.from(cleanB64, 'base64');

                    if (mediaFormat === 'pdf') {
                        await sock.sendMessage(jid, {
                            document: fileBuffer,
                            mimetype: 'application/pdf',
                            fileName: fileName.endsWith('.pdf') ? fileName : (fileName + '.pdf'),
                            caption: message
                        });
                    } else {
                        await sock.sendMessage(jid, {
                            image: fileBuffer,
                            caption: message
                        });
                    }
                } else {
                    await sock.sendMessage(jid, { text: message });
                }

                console.log(`📤 Sent ${mediaBase64 ? mediaFormat.toUpperCase() : 'TEXT'} to ${jid}`);
                return sendJson(res, 200, {
                    ok: true,
                    api_sent: true,
                    mode: 'api_sent',
                    phone: jid.split('@')[0]
                });
            } catch (err) {
                console.error('Send error:', err.message);
                return sendJson(res, 500, { ok: false, error: err.message });
            }
        });
        return;
    }

    sendJson(res, 404, { ok: false, error: 'Endpoint not found' });
});

server.listen(PORT, BIND_HOST, () => {
    console.log('======================================================================');
    console.log(` 🏫 THE SMART SCHOOL — FREE UNLIMITED WHATSAPP SERVER (PORT ${PORT})`);
    console.log(' ✅ 100% Free • Unlimited Parents (1000+) • Direct Image & PDF Cards');
    console.log('======================================================================');
    startWhatsAppConnection();
});
