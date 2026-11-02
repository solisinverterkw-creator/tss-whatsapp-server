/**
 * THE SMART SCHOOL — 100% FREE UNLIMITED WHATSAPP GATEWAY v2.3 (1000+ PARENTS)
 * Sends Official Result Card Images (.png) & PDFs (.pdf) + Captions directly to Parents
 * Zero-CPU Image FastPath • Auto Socket Self-Heal • Live ✓✓ Receipt Tracking
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const baileys = require('@whiskeysockets/baileys');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    fetchLatestWaWebVersion,
    jidNormalizedUser
} = baileys;

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

const verifiedSessionJids = new Set();
const msgStore = new Map();
const receiptStore = new Map(); // message_id -> { message_id, phone, status, delivered_at, read_at, updated_at }
const RETENTION_30D_MS = 30 * 24 * 60 * 60 * 1000;

// Auto-purge any in-memory receipt/message entries older than 30 days (1 Month Retention)
setInterval(() => {
    const cutoff = Date.now() - RETENTION_30D_MS;
    for (const [msgId, rec] of Array.from(receiptStore.entries())) {
        const ts = rec && rec.updated_at ? Number(rec.updated_at) : 0;
        if (ts > 0 && ts < cutoff) {
            receiptStore.delete(msgId);
            msgStore.delete(msgId);
        }
    }
}, 3600 * 1000).unref();

/**
 * Ephemeral Signal Double-Ratchet files MUST NOT be backed up/restored across cloud restarts!
 */
function isEphemeralRatchetFile(fileName) {
    const base = path.basename(String(fileName || '')).toLowerCase();
    return (
        base.startsWith('session-') ||
        base.startsWith('sender-key-') ||
        base.startsWith('device-list-')
    );
}

function purgeStaleSessionFiles(onlyDigits = '') {
    let removed = 0;
    try {
        if (!fs.existsSync(AUTH_DIR)) return 0;
        const files = fs.readdirSync(AUTH_DIR);
        for (const f of files) {
            if (!isEphemeralRatchetFile(f)) continue;
            if (onlyDigits && !f.includes(onlyDigits)) continue;
            try {
                fs.unlinkSync(path.join(AUTH_DIR, f));
                removed++;
            } catch (e) {}
        }
    } catch (e) {}
    return removed;
}

/**
 * Read PNG width/height directly from 24-byte IHDR header in 0.001ms (avoids pure-JS Jimp freezing Render 0.1 vCPU!)
 */
function extractPngDimensions(buf) {
    try {
        if (Buffer.isBuffer(buf) && buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
            const width = buf.readUInt32BE(16);
            const height = buf.readUInt32BE(20);
            if (width > 0 && height > 0 && width < 20000 && height < 20000) {
                return { width, height };
            }
        }
    } catch (e) {}
    return null;
}

function withTimeout(promise, ms, label = 'Operation') {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} Timed Out`)), ms);
        promise.then(
            (val) => { clearTimeout(timer); resolve(val); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
}

function httpsRequestJson(urlStr, method = 'GET', bodyObj = null, timeoutMs = 45000, redirectsLeft = 3) {
    return new Promise((resolve) => {
        try {
            const u = new URL(urlStr);
            const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
            const headers = {
                'User-Agent': 'TSS-WhatsApp-Gateway/2.4 (PermanentSession)',
                'Accept': 'application/json'
            };
            if (payload) {
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = payload.length;
            }
            const opts = {
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                method,
                headers,
                timeout: timeoutMs
            };
            const client = u.protocol === 'https:' ? https : http;
            const req = client.request(opts, (res) => {
                if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
                    const nextUrl = new URL(res.headers.location, urlStr).toString();
                    res.resume();
                    return resolve(httpsRequestJson(nextUrl, method, bodyObj, timeoutMs, redirectsLeft - 1));
                }
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

let phoneUnlinkedByUser = false;
let consecutiveLoggedOutCount = 0;

/**
 * Verify that local creds.json actually contains a linked WhatsApp account (me.id),
 * NOT a blank unauthenticated file created before QR scan!
 */
function hasValidLinkedCreds() {
    try {
        const credsPath = path.join(AUTH_DIR, 'creds.json');
        if (!fs.existsSync(credsPath)) return false;
        const parsed = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        return Boolean(parsed && parsed.me && parsed.me.id);
    } catch (e) {
        return false;
    }
}

function writeAuthFilesToDisk(filesObj) {
    if (!filesObj || typeof filesObj !== 'object') return 0;
    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
    let count = 0;
    for (const [fname, b64] of Object.entries(filesObj)) {
        const safeName = path.basename(String(fname || ''));
        if (!safeName || isEphemeralRatchetFile(safeName)) continue;
        fs.writeFileSync(path.join(AUTH_DIR, safeName), Buffer.from(String(b64), 'base64'));
        count++;
    }
    return count;
}

async function restoreSessionFromHostinger() {
    if (phoneUnlinkedByUser) return false;
    try {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }
        if (hasValidLinkedCreds()) {
            return true;
        }
        // Remove any blank/unlinked creds.json so it never blocks restoring real linked credentials
        try {
            const credsPath = path.join(AUTH_DIR, 'creds.json');
            if (fs.existsSync(credsPath)) fs.unlinkSync(credsPath);
        } catch (e) {}

        for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`🔄 [Attempt ${attempt}/3] Restoring permanent WhatsApp QR session from School Portal...`);
            const res = await httpsRequestJson(`${PORTAL_SYNC_URL}?action=wa_session_restore&sync_key=${SYNC_KEY}`, 'GET', null, 45000);
            if (res && res.ok && res.files && typeof res.files === 'object' && res.files['creds.json']) {
                const count = writeAuthFilesToDisk(res.files);
                if (count > 0 && hasValidLinkedCreds()) {
                    console.log(`✅ Permanent WhatsApp QR session restored (${count} files) — NO QR re-scan needed!`);
                    return true;
                }
            }
            if (attempt < 3) {
                await new Promise(r => setTimeout(r, 2500));
            }
        }
    } catch (e) {
        console.error('Session restore warning:', e.message);
    }
    return false;
}

function scheduleSessionBackupToHostinger() {
    if (backupTimer) clearTimeout(backupTimer);
    backupTimer = setTimeout(async () => {
        try {
            // NEVER overwrite portal backup unless local creds.json has a valid linked WhatsApp phone (me.id)!
            if (!hasValidLinkedCreds()) return;

            const allFiles = fs.readdirSync(AUTH_DIR);
            const preKeyFiles = allFiles
                .filter(f => f.toLowerCase().startsWith('pre-key-'))
                .sort((a, b) => {
                    const na = parseInt(a.replace(/\D+/g, '') || '0', 10);
                    const nb = parseInt(b.replace(/\D+/g, '') || '0', 10);
                    return nb - na; // newest pre-keys first
                })
                .slice(0, 35);
            const keepPreKeys = new Set(preKeyFiles);

            const filesMap = {};
            for (const f of allFiles) {
                if (isEphemeralRatchetFile(f)) continue;
                if (f.toLowerCase().startsWith('pre-key-') && !keepPreKeys.has(f)) continue;
                const full = path.join(AUTH_DIR, f);
                if (fs.statSync(full).isFile()) {
                    filesMap[f] = fs.readFileSync(full).toString('base64');
                }
            }
            if (!filesMap['creds.json']) return;
            await httpsRequestJson(`${PORTAL_SYNC_URL}?action=wa_session_backup&sync_key=${SYNC_KEY}`, 'POST', { files: filesMap }, 45000);
        } catch (e) {}
    }, 2500);
}

async function clearSessionOnHostinger(forceLogout = false) {
    if (!forceLogout) return;
    try {
        await httpsRequestJson(`${PORTAL_SYNC_URL}?action=wa_session_clear&sync_key=${SYNC_KEY}&force_logout=1`, 'POST', { force_logout: 1 }, 25000);
    } catch (e) {}
}

// 24/7 Keep-Alive Ping every 4 minutes
setInterval(() => {
    httpsRequestJson(`${PORTAL_SYNC_URL}?action=wa_keepalive`, 'GET');
    httpsRequestJson(`${RENDER_SELF_URL}/status?keepalive=1`, 'GET');
}, 4 * 60 * 1000);

function mapAckStatus(ackNum) {
    if (ackNum >= 4) return 'read';
    if (ackNum === 3) return 'delivered';
    if (ackNum === 2) return 'sent_server';
    if (ackNum === 0) return 'failed';
    return '';
}

function recordAndPushReceipt(msgId, remoteJid, newStatus, errorReason = '') {
    if (!msgId || !newStatus) return;
    const rank = { pending: 0, sent_server: 2, delivered: 3, read: 4, failed: 5, not_on_whatsapp: 5 };
    const isLidJid = String(remoteJid || '').endsWith('@lid');
    const cleanPhone = String(remoteJid || '').split('@')[0].split(':')[0].replace(/\D+/g, '');
    const existing = receiptStore.get(msgId) || {
        message_id: msgId,
        phone: cleanPhone,
        status: 'sent_server',
        delivered_at: null,
        read_at: null,
        updated_at: Date.now()
    };

    if ((rank[newStatus] || 0) < (rank[existing.status] || 0)) {
        return;
    }

    const nowIso = new Date().toISOString();
    existing.status = newStatus;
    // Keep the real 923... phone number if incoming ACK uses an internal WhatsApp @lid JID
    if (cleanPhone && (!isLidJid || !existing.phone)) {
        existing.phone = cleanPhone;
    }
    if ((newStatus === 'delivered' || newStatus === 'read') && !existing.delivered_at) {
        existing.delivered_at = nowIso;
    }
    if (newStatus === 'read' && !existing.read_at) {
        existing.read_at = nowIso;
    }
    if (errorReason) {
        existing.error = errorReason;
    }
    existing.updated_at = Date.now();
    receiptStore.set(msgId, existing);

    if (receiptStore.size > 5000) {
        const oldestKey = receiptStore.keys().next().value;
        receiptStore.delete(oldestKey);
    }

    httpsRequestJson(`${PORTAL_SYNC_URL}?action=wa_delivery_webhook&sync_key=${SYNC_KEY}`, 'POST', {
        sync_key: SYNC_KEY,
        message_id: msgId,
        phone: existing.phone,
        delivery_status: newStatus,
        error_reason: errorReason || ''
    }).catch(() => {});
}

let cachedWaVersion = null;
async function resolveLatestWhatsAppVersion() {
    if (cachedWaVersion) return cachedWaVersion;
    if (typeof fetchLatestWaWebVersion === 'function') {
        try {
            const waWeb = await withTimeout(fetchLatestWaWebVersion({}), 5000, 'fetchWaWebVersion');
            if (waWeb && Array.isArray(waWeb.version) && waWeb.version.length === 3) {
                cachedWaVersion = waWeb.version;
                return cachedWaVersion;
            }
        } catch (e) {}
    }
    if (typeof fetchLatestBaileysVersion === 'function') {
        try {
            const bVer = await withTimeout(fetchLatestBaileysVersion(), 5000, 'fetchBaileysVersion');
            if (bVer && Array.isArray(bVer.version) && bVer.version.length === 3) {
                cachedWaVersion = bVer.version;
                return cachedWaVersion;
            }
        } catch (e) {}
    }
    cachedWaVersion = [2, 3000, 1052519418];
    return cachedWaVersion;
}

let bootClearedRatchets = false;

async function startWhatsAppConnection() {
    if (isReconnecting) return;
    isReconnecting = true;
    try {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }
        await restoreSessionFromHostinger();

        if (!bootClearedRatchets) {
            const purged = purgeStaleSessionFiles();
            bootClearedRatchets = true;
            if (purged > 0) {
                console.log(`🧹 Cleaned ${purged} stale Signal session file(s) on boot.`);
            }
        }
        verifiedSessionJids.clear();

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const version = await resolveLatestWhatsAppVersion();
        console.log('📡 Connecting WhatsApp Multi-Device using Web Protocol v' + version.join('.'));

        const newSock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            browser: ['The Smart School Portal', 'Chrome', '124.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 20000,
            defaultQueryTimeoutMs: 18000,
            keepAliveIntervalMs: 20000,
            retryRequestDelayMs: 350,
            maxMsgRetryCount: 5,
            options: {
                timeout: 25000
            },
            getMessage: async (key) => {
                if (key && key.id && msgStore.has(key.id)) {
                    return msgStore.get(key.id);
                }
                return undefined;
            }
        });
        sock = newSock;

        newSock.ev.on('creds.update', async () => {
            await saveCreds();
            scheduleSessionBackupToHostinger();
        });

        newSock.ev.on('messages.update', (updates) => {
            if (!Array.isArray(updates)) return;
            for (const u of updates) {
                const msgId = u?.key?.id;
                const jid = u?.key?.remoteJid;
                const ack = u?.update?.status;
                if (msgId && typeof ack === 'number') {
                    const mapped = mapAckStatus(ack);
                    if (mapped) {
                        recordAndPushReceipt(msgId, jid, mapped);
                    }
                }
            }
        });

        newSock.ev.on('message-receipt.update', (receipts) => {
            if (!Array.isArray(receipts)) return;
            for (const r of receipts) {
                const msgId = r?.key?.id;
                const jid = r?.key?.remoteJid;
                const rec = r?.receipt || {};
                if (!msgId) continue;
                if (rec.readTimestamp || rec.playedTimestamp) {
                    recordAndPushReceipt(msgId, jid, 'read');
                } else if (rec.receiptTimestamp) {
                    recordAndPushReceipt(msgId, jid, 'delivered');
                }
            }
        });

        newSock.ev.on('connection.update', async (update) => {
            // Ignore stale events from an older recycled socket instance
            if (sock !== newSock) return;

            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                connectionState = 'qr_ready';
                try {
                    latestQrDataUrl = await QRCode.toDataURL(qr, { width: 260, margin: 1 });
                    console.log('📱 [QR READY] Scan the QR Code inside your School Portal!');
                } catch (err) {}
            }

            if (connection === 'open') {
                phoneUnlinkedByUser = false;
                consecutiveLoggedOutCount = 0;
                connectionState = 'authorized';
                latestQrDataUrl = '';
                connectedNumber = (newSock.user && newSock.user.id) ? newSock.user.id.split(':')[0] : 'Connected';
                console.log('✅ [WHATSAPP CONNECTED PERMANENTLY] Number:', connectedNumber, '— v2.4 Ready!');
                try {
                    await newSock.uploadPreKeysToServerIfRequired();
                } catch (e) {}
                scheduleSessionBackupToHostinger();
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isExplicitLogout = statusCode === DisconnectReason.loggedOut;
                const isReplaced = statusCode === DisconnectReason.connectionReplaced;
                console.log('⚠️ Connection closed. Status:', statusCode, 'Replaced:', isReplaced, 'LoggedOut:', isExplicitLogout);
                connectionState = 'disconnected';
                latestQrDataUrl = '';

                if (isExplicitLogout) {
                    consecutiveLoggedOutCount++;
                    try {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    } catch (e) {}
                    // Only stop auto-restoring if WhatsApp rejected the restored session twice in a row (user unlinked from phone)
                    if (consecutiveLoggedOutCount >= 2) {
                        phoneUnlinkedByUser = true;
                    }
                } else if (statusCode === DisconnectReason.badSession) {
                    purgeStaleSessionFiles();
                }

                // Wait 6s on 440 (Render zero-downtime deploy overlap) so retiring container exits cleanly without kicking new container
                const retryDelayMs = isReplaced ? 6000 : 1800;
                setTimeout(() => {
                    if (sock === newSock) {
                        isReconnecting = false;
                        startWhatsAppConnection();
                    }
                }, retryDelayMs);
            }
        });
    } catch (err) {
        console.error('Error starting WhatsApp socket:', err.message);
        setTimeout(() => {
            isReconnecting = false;
            startWhatsAppConnection();
        }, 3000);
    } finally {
        isReconnecting = false;
    }
}

/**
 * Cleanly recycle a zombie / poisoned socket without logging out QR, and wait until 'authorized'
 */
async function recycleSocketAndWait(maxWaitMs = 12000) {
    const oldSock = sock;
    sock = null;
    connectionState = 'connecting';
    isReconnecting = false;
    try {
        if (oldSock && typeof oldSock.end === 'function') {
            oldSock.end(undefined);
        }
    } catch (e) {}

    await startWhatsAppConnection();
    const steps = Math.ceil(maxWaitMs / 400);
    for (let i = 0; i < steps && connectionState !== 'authorized'; i++) {
        await new Promise(r => setTimeout(r, 400));
    }
    return connectionState === 'authorized';
}

function normalizePhoneDigits(rawPhone) {
    let text = String(rawPhone || '').split(/[\/,;|\n]+/)[0] || '';
    let digits = text.replace(/\D+/g, '');
    if (digits.length === 22 && digits.startsWith('03')) {
        digits = digits.slice(0, 11);
    } else if (digits.length === 24 && digits.startsWith('923')) {
        digits = digits.slice(0, 12);
    }
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('9203') && digits.length === 13) {
        digits = '92' + digits.slice(3);
    } else if (digits.startsWith('03') && digits.length === 11) {
        digits = '92' + digits.slice(1);
    } else if (digits.length === 10 && digits.startsWith('3')) {
        digits = '92' + digits;
    }
    return digits;
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
            ? `<h2 style="color:#16a34a;">✅ WhatsApp Permanently Connected (${connectedNumber}) — v2.4 Ready!</h2>
               <p><a href="/clear-stuck" style="display:inline-block;margin:6px;padding:10px 18px;background:#0284c7;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">🧹 Clear Stuck Queue &amp; Repair Encryption (Keep QR)</a></p>`
            : (latestQrDataUrl
                ? `<h3>📱 Scan this QR Code ONCE from your Phone WhatsApp (Linked Devices &rarr; Link a Device):</h3><img src="${latestQrDataUrl}" style="border:2px solid #16a34a;padding:8px;border-radius:12px;"/><p><a href="/" style="padding:8px 16px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;">Refresh Status</a></p>`
                : `<h3>⏳ Restoring Permanent Session / Connecting... Please refresh in 3 seconds.</h3><script>setTimeout(()=>location.reload(),3000);</script>`);
        return res.end(`<!DOCTYPE html><html><head><title>TSS 24/7 Permanent WhatsApp Cloud Server</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;text-align:center;padding:30px;"><h1>🏫 The Smart School — 24/7 Permanent WhatsApp Server v2.4</h1>${statusHtml}</body></html>`);
    }

    if (pathname === '/status' && req.method === 'GET') {
        let stuckCount = 0;
        for (const v of receiptStore.values()) {
            if (v && v.status === 'sent_server') stuckCount++;
        }
        return sendJson(res, 200, {
            ok: true,
            connected: connectionState === 'authorized',
            state: connectionState,
            phone: connectedNumber,
            has_linked_creds: hasValidLinkedCreds(),
            phone_unlinked_by_user: phoneUnlinkedByUser,
            qr_image: latestQrDataUrl,
            receipts_tracked: receiptStore.size,
            stuck_1tick: stuckCount,
            gateway_version: '2.4-permanent-qr',
            status_msg: connectionState === 'authorized'
                ? `✅ Permanent WhatsApp Connected (${connectedNumber})! Ready 24/7 — No Re-Scan Needed!`
                : (latestQrDataUrl
                    ? '📱 Scan this QR Code ONCE from your Phone WhatsApp (Linked Devices -> Link a Device) — stays permanently saved!'
                    : '⏳ Restoring saved WhatsApp session, please wait 3 seconds...')
        });
    }

    if (pathname === '/receipts' && req.method === 'GET') {
        const idsParam = (urlObj.searchParams.get('ids') || '').trim();
        const out = {};
        if (idsParam) {
            for (const id of idsParam.split(',').map(s => s.trim()).filter(Boolean)) {
                if (receiptStore.has(id)) {
                    out[id] = receiptStore.get(id);
                }
            }
        } else {
            const entries = Array.from(receiptStore.entries()).slice(-200);
            for (const [k, v] of entries) {
                out[k] = v;
            }
        }
        return sendJson(res, 200, { ok: true, receipts: out });
    }

    if (pathname === '/restore-session' && req.method === 'POST') {
        let rsChunks = [];
        req.on('data', (chunk) => rsChunks.push(chunk));
        req.on('end', async () => {
            try {
                const body = JSON.parse(Buffer.concat(rsChunks).toString('utf8') || '{}');
                if ((body.sync_key || urlObj.searchParams.get('sync_key')) !== SYNC_KEY) {
                    return sendJson(res, 403, { ok: false, error: 'Forbidden' });
                }
                if (phoneUnlinkedByUser && !body.force) {
                    return sendJson(res, 200, { ok: false, unlinked: true, message: 'Device was unlinked from phone; fresh QR scan required once.' });
                }
                if (body.files && typeof body.files === 'object' && body.files['creds.json']) {
                    try {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    } catch (e) {}
                    const written = writeAuthFilesToDisk(body.files);
                    if (written > 0 && hasValidLinkedCreds()) {
                        phoneUnlinkedByUser = false;
                        consecutiveLoggedOutCount = 0;
                        const connectedOk = await recycleSocketAndWait(12000);
                        return sendJson(res, 200, {
                            ok: true,
                            connected: connectedOk,
                            phone: connectedNumber,
                            restored_files: written
                        });
                    }
                }
                return sendJson(res, 400, { ok: false, error: 'No valid creds.json provided' });
            } catch (err) {
                return sendJson(res, 500, { ok: false, error: err.message });
            }
        });
        return;
    }

    if (pathname === '/clear-stuck' && (req.method === 'POST' || req.method === 'GET')) {
        let clearedQueue = msgStore.size;
        let clearedStuckReceipts = 0;
        msgStore.clear();
        for (const [k, v] of Array.from(receiptStore.entries())) {
            if (!v || v.status === 'sent_server' || v.status === 'failed') {
                receiptStore.delete(k);
                clearedStuckReceipts++;
            }
        }
        const purgedFiles = purgeStaleSessionFiles();
        verifiedSessionJids.clear();
        scheduleSessionBackupToHostinger();
        await recycleSocketAndWait(8000);

        return sendJson(res, 200, {
            ok: true,
            cleared_queue: clearedQueue,
            cleared_stuck_receipts: clearedStuckReceipts,
            purged_session_files: purgedFiles,
            connected: connectionState === 'authorized',
            message: `Cleared ${clearedStuckReceipts} stuck item(s) and reset ${purgedFiles} Signal encryption session(s). Connected & ready!`
        });
    }

    if (pathname === '/logout' && req.method === 'POST') {
        let loChunks = [];
        req.on('data', (c) => loChunks.push(c));
        req.on('end', async () => {
            try {
                const body = JSON.parse(Buffer.concat(loChunks).toString('utf8') || '{}');
                const keyProvided = body.sync_key || urlObj.searchParams.get('sync_key') || '';
                if (keyProvided !== SYNC_KEY) {
                    return sendJson(res, 403, { ok: false, error: 'Unauthorized logout request blocked.' });
                }
                msgStore.clear();
                receiptStore.clear();
                verifiedSessionJids.clear();
                phoneUnlinkedByUser = true;
                const oldSock = sock;
                sock = null;
                try {
                    if (oldSock) await oldSock.logout();
                } catch (e) {}
                try {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                } catch (e) {}
                await clearSessionOnHostinger(true);
                connectionState = 'connecting';
                latestQrDataUrl = '';
                connectedNumber = '';
                isReconnecting = false;
                startWhatsAppConnection();
                return sendJson(res, 200, { ok: true, message: 'Explicit logout complete. Generating fresh QR code...' });
            } catch (e) {
                return sendJson(res, 500, { ok: false, error: e.message });
            }
        });
        return;
    }

    if (pathname === '/check-numbers' && req.method === 'POST') {
        let chkChunks = [];
        req.on('data', (chunk) => chkChunks.push(chunk));
        req.on('end', async () => {
            try {
                const body = JSON.parse(Buffer.concat(chkChunks).toString('utf8') || '{}');
                const rawPhones = Array.isArray(body.phones) ? body.phones : [];

                if (connectionState !== 'authorized') {
                    for (let w = 0; w < 20 && connectionState !== 'authorized'; w++) {
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
                if (connectionState !== 'authorized' || !sock) {
                    return sendJson(res, 400, {
                        ok: false,
                        connected: false,
                        error: 'WhatsApp QR is not connected yet. Please check connection first.'
                    });
                }

                const cleanList = [];
                for (const rp of rawPhones) {
                    const d = normalizePhoneDigits(rp);
                    if (d && d.length >= 10 && !cleanList.includes(d)) {
                        cleanList.push(d);
                    }
                }

                const results = {};
                const batchSize = 25;
                for (let i = 0; i < cleanList.length; i += batchSize) {
                    const batch = cleanList.slice(i, i + batchSize);
                    for (const d of batch) {
                        results[d] = false;
                    }
                    try {
                        const respArr = await withTimeout(sock.onWhatsApp(...batch), 12000, 'onWhatsAppBatch');
                        if (Array.isArray(respArr)) {
                            for (const item of respArr) {
                                if (item && item.exists && item.jid) {
                                    const numPart = String(item.jid).split('@')[0].split(':')[0].replace(/\D+/g, '');
                                    if (numPart) {
                                        results[numPart] = true;
                                    }
                                }
                            }
                        }
                    } catch (batchErr) {
                        console.warn('Batch onWhatsApp timeout/error, recycling socket:', batchErr.message);
                        await recycleSocketAndWait(8000);
                        // Retry this batch once after socket recycle
                        if (sock && connectionState === 'authorized') {
                            const retryArr = await withTimeout(sock.onWhatsApp(...batch), 12000, 'onWhatsAppBatchRetry');
                            if (Array.isArray(retryArr)) {
                                for (const item of retryArr) {
                                    if (item && item.exists && item.jid) {
                                        const numPart = String(item.jid).split('@')[0].split(':')[0].replace(/\D+/g, '');
                                        if (numPart) {
                                            results[numPart] = true;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                return sendJson(res, 200, {
                    ok: true,
                    connected: true,
                    checked_count: cleanList.length,
                    results
                });
            } catch (err) {
                console.error('Check-numbers error:', err.message);
                return sendJson(res, 500, { ok: false, error: err.message });
            }
        });
        return;
    }

    if (pathname === '/send' && req.method === 'POST') {
        let bodyChunks = [];
        req.on('data', (chunk) => bodyChunks.push(chunk));
        req.on('end', async () => {
            try {
                const rawBody = Buffer.concat(bodyChunks).toString('utf8');
                const data = JSON.parse(rawBody || '{}');

                if (connectionState !== 'authorized') {
                    for (let w = 0; w < 28 && connectionState !== 'authorized'; w++) {
                        await new Promise(r => setTimeout(r, 500));
                    }
                }

                if (connectionState !== 'authorized' || !sock) {
                    return sendJson(res, 400, {
                        ok: false,
                        error: 'WhatsApp QR Code is not connected yet. Click "Auto-Send API & QR Setup" -> "Scan QR / Check Connection".'
                    });
                }

                const phone = data.phone || '';
                const message = data.message || '';
                const mediaFormat = (data.media_format || 'image').toLowerCase();
                const mediaBase64 = data.media_base64 || '';
                const jpegThumbB64 = data.jpeg_thumbnail ? String(data.jpeg_thumbnail).replace(/^data:[^;]+;base64,/, '') : '';
                const forceFresh = !!data.force_fresh_session;
                const fileName = data.filename || data.media_filename || (mediaFormat === 'pdf' ? 'ResultCard.pdf' : 'ResultCard.png');

                const digits = normalizePhoneDigits(phone);
                if (!digits || digits.length < 10) {
                    return sendJson(res, 400, { ok: false, error: 'Valid recipient WhatsApp mobile number is required.' });
                }

                // 1. Verify number on WhatsApp with fast 8s timeout (auto-recycles socket if zombie!)
                let targetJid = digits + '@s.whatsapp.net';
                try {
                    const waCheckArr = await withTimeout(sock.onWhatsApp(digits), 8000, 'onWhatsApp');
                    if (Array.isArray(waCheckArr) && waCheckArr.length > 0) {
                        if (!waCheckArr[0].exists) {
                            return sendJson(res, 400, {
                                ok: false,
                                not_on_whatsapp: true,
                                phone: digits,
                                error: `Parent mobile number (+${digits}) is NOT registered on WhatsApp.`
                            });
                        }
                        if (waCheckArr[0].jid) {
                            targetJid = typeof jidNormalizedUser === 'function'
                                ? jidNormalizedUser(waCheckArr[0].jid)
                                : waCheckArr[0].jid;
                        }
                    } else if (Array.isArray(waCheckArr) && waCheckArr.length === 0) {
                        return sendJson(res, 400, {
                            ok: false,
                            not_on_whatsapp: true,
                            phone: digits,
                            error: `Parent mobile number (+${digits}) is NOT registered on WhatsApp.`
                        });
                    }
                } catch (chkErr) {
                    console.warn('onWhatsApp slow/stale, recycling socket cleanly:', chkErr.message);
                    await recycleSocketAndWait(10000);
                }

                if (forceFresh) {
                    purgeStaleSessionFiles(digits);
                }

                // 2. Build Zero-CPU payload (jpegThumbnail bypasses pure-JS Jimp 1.7MP PNG decode that froze Render 0.1 vCPU!)
                let contentPayload;
                if (mediaBase64) {
                    const cleanB64 = mediaBase64.replace(/^data:[^;]+;base64,/, '');
                    const fileBuffer = Buffer.from(cleanB64, 'base64');

                    if (mediaFormat === 'pdf') {
                        contentPayload = {
                            document: fileBuffer,
                            mimetype: 'application/pdf',
                            fileName: fileName.endsWith('.pdf') ? fileName : (fileName + '.pdf'),
                            caption: message
                        };
                    } else {
                        const dims = extractPngDimensions(fileBuffer);
                        contentPayload = {
                            image: fileBuffer,
                            mimetype: 'image/png',
                            caption: message,
                            jpegThumbnail: jpegThumbB64, // Always string ('' or base64 JPEG) so Baileys skips Jimp CPU freeze!
                            ...(dims ? { width: dims.width, height: dims.height } : {})
                        };
                    }
                } else {
                    contentPayload = { text: message };
                }

                // 3. Dispatch with automatic socket self-heal retry if mediaConn or WebSocket timed out
                let sentResult = null;
                let lastSendErr = null;
                for (let attempt = 1; attempt <= 2; attempt++) {
                    try {
                        if (!sock || connectionState !== 'authorized') {
                            await recycleSocketAndWait(10000);
                        }
                        sentResult = await withTimeout(sock.sendMessage(targetJid, contentPayload), 28000, 'sendMessage');
                        lastSendErr = null;
                        break;
                    } catch (sendErr) {
                        lastSendErr = sendErr;
                        console.warn(`Send attempt ${attempt} error (${sendErr.message}) — recycling socket...`);
                        if (attempt === 1) {
                            await recycleSocketAndWait(10000);
                        }
                    }
                }

                if (lastSendErr) {
                    throw lastSendErr;
                }

                const messageId = (sentResult && sentResult.key && sentResult.key.id) ? sentResult.key.id : '';
                if (messageId) {
                    if (sentResult.message) {
                        msgStore.set(messageId, sentResult.message);
                        if (msgStore.size > 3000) {
                            const firstKey = msgStore.keys().next().value;
                            msgStore.delete(firstKey);
                        }
                    }
                    // Pass digits + '@s.whatsapp.net' first so real phone number is stored before any @lid receipt arrives
                    recordAndPushReceipt(messageId, digits + '@s.whatsapp.net', 'sent_server');

                    // Wait up to 3.0s for instant DELIVERY_ACK (2 Ticks) from parent's phone
                    for (let w = 0; w < 12; w++) {
                        const recNow = receiptStore.get(messageId);
                        if (recNow && (recNow.status === 'delivered' || recNow.status === 'read')) {
                            break;
                        }
                        await new Promise(r => setTimeout(r, 250));
                    }
                }

                const finalRec = messageId ? receiptStore.get(messageId) : null;
                const finalStatus = (finalRec && finalRec.status) ? finalRec.status : 'sent_server';

                console.log(`📤 Sent ${mediaBase64 ? mediaFormat.toUpperCase() : 'TEXT'} to ${targetJid} [msgId=${messageId}, status=${finalStatus}]`);
                return sendJson(res, 200, {
                    ok: true,
                    api_sent: true,
                    mode: 'api_sent',
                    message_id: messageId,
                    delivery_status: finalStatus,
                    delivered_at: finalRec ? finalRec.delivered_at : null,
                    phone: digits
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
    console.log(` 🏫 THE SMART SCHOOL — FREE UNLIMITED WHATSAPP SERVER v2.3 (PORT ${PORT})`);
    console.log(' ✅ Zero-CPU Image FastPath • Auto Self-Heal • Live ✓✓ Receipt Tracking');
    console.log('======================================================================');
    startWhatsAppConnection();
});
