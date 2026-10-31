/**
 * THE SMART SCHOOL — 100% FREE UNLIMITED WHATSAPP GATEWAY (1000+ PARENTS)
 * Sends Official Result Card Images (.png) & PDFs (.pdf) + Captions directly to Parents
 * Zero Monthly Fee • Unlimited Chats • Fresh Signal PreKey Sync • Live ✓✓ Receipt Tracking
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

// Track JIDs whose Signal E2EE session has been freshly asserted during this server boot
const verifiedSessionJids = new Set();
const msgStore = new Map();
const receiptStore = new Map(); // message_id -> { message_id, phone, status, delivered_at, read_at, updated_at }

/**
 * Ephemeral Signal Double-Ratchet files MUST NOT be backed up/restored across cloud restarts!
 * Restoring old session-*.json causes rolled-back chain counters ("Bad Mac") on parent phones,
 * leaving messages stuck on 1-Tick (sent_server) without ever appearing on the parent's WhatsApp.
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
        console.log('🔄 Checking Hostinger Cloud Backup for saved WhatsApp QR credentials...');
        const res = await httpsRequestJson(`${PORTAL_SYNC_URL}?action=wa_session_restore&sync_key=${SYNC_KEY}`, 'GET');
        if (res && res.ok && res.files && typeof res.files === 'object') {
            let count = 0;
            for (const [fname, b64] of Object.entries(res.files)) {
                const safeName = path.basename(fname);
                // NEVER restore old session-*.json / sender-key-*.json / device-list-*.json (prevents 1-tick E2E stuck bug!)
                if (isEphemeralRatchetFile(safeName)) {
                    continue;
                }
                fs.writeFileSync(path.join(AUTH_DIR, safeName), Buffer.from(b64, 'base64'));
                count++;
            }
            if (count > 0) {
                console.log(`✅ Restored ${count} core WhatsApp credential file(s) from Hostinger! Fresh E2EE PreKeys ready.`);
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
                if (isEphemeralRatchetFile(f)) continue;
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

function mapAckStatus(ackNum) {
    // Baileys WAMessageStatus: 0=ERROR, 1=PENDING, 2=SERVER_ACK, 3=DELIVERY_ACK, 4=READ, 5=PLAYED
    if (ackNum >= 4) return 'read';
    if (ackNum === 3) return 'delivered';
    if (ackNum === 2) return 'sent_server';
    if (ackNum === 0) return 'failed';
    return '';
}

function recordAndPushReceipt(msgId, remoteJid, newStatus, errorReason = '') {
    if (!msgId || !newStatus) return;
    const rank = { pending: 0, sent_server: 2, delivered: 3, read: 4, failed: 5, not_on_whatsapp: 5 };
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
    if (cleanPhone) existing.phone = cleanPhone;
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

    // Push live receipt update to School Portal immediately
    httpsRequestJson(`${PORTAL_SYNC_URL}?action=wa_delivery_webhook&sync_key=${SYNC_KEY}`, 'POST', {
        sync_key: SYNC_KEY,
        message_id: msgId,
        phone: existing.phone,
        delivery_status: newStatus,
        error_reason: errorReason || ''
    }).catch(() => {});
}

async function resolveLatestWhatsAppVersion() {
    if (typeof fetchLatestWaWebVersion === 'function') {
        try {
            const waWeb = await fetchLatestWaWebVersion({});
            if (waWeb && Array.isArray(waWeb.version) && waWeb.version.length === 3) {
                return waWeb.version;
            }
        } catch (e) {}
    }
    if (typeof fetchLatestBaileysVersion === 'function') {
        try {
            const bVer = await fetchLatestBaileysVersion();
            if (bVer && Array.isArray(bVer.version) && bVer.version.length === 3) {
                return bVer.version;
            }
        } catch (e) {}
    }
    return [2, 3000, 1052519418];
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

        // On cold boot, purge any stale ephemeral ratchet files so every recipient gets a clean PreKey session
        if (!bootClearedRatchets) {
            const purged = purgeStaleSessionFiles();
            bootClearedRatchets = true;
            if (purged > 0) {
                console.log(`🧹 Cleaned ${purged} stale Signal session file(s) on boot for clean ✓✓ parent delivery.`);
            }
        }
        verifiedSessionJids.clear();

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const version = await resolveLatestWhatsAppVersion();
        console.log('📡 Connecting WhatsApp Multi-Device using Web Protocol v' + version.join('.'));

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            browser: ['The Smart School Portal', 'Chrome', '124.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 25000,
            retryRequestDelayMs: 350,
            maxMsgRetryCount: 5,
            getMessage: async (key) => {
                if (key && key.id && msgStore.has(key.id)) {
                    return msgStore.get(key.id);
                }
                return undefined;
            }
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            scheduleSessionBackupToHostinger();
        });

        // Track 1-Tick (Server), 2-Ticks (Received by Parent), and Blue Ticks (Seen by Parent)
        sock.ev.on('messages.update', (updates) => {
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

        sock.ev.on('message-receipt.update', (receipts) => {
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
                console.log('✅ [WHATSAPP CONNECTED] Number:', connectedNumber, '— Ready to send Result Cards with ✓✓ Delivery!');
                try {
                    await sock.uploadPreKeysToServerIfRequired();
                } catch (e) {}
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
                }, 2000);
            }
        });
    } catch (err) {
        console.error('Error starting WhatsApp socket:', err.message);
        setTimeout(() => {
            isReconnecting = false;
            startWhatsAppConnection();
        }, 3500);
    } finally {
        isReconnecting = false;
    }
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
            ? `<h2 style="color:#16a34a;">✅ WhatsApp Connected (${connectedNumber}) — 24/7 Cloud Auto-Send + Live ✓✓ Receipt Tracking Ready!</h2>
               <p><a href="/clear-stuck" style="display:inline-block;margin:6px;padding:10px 18px;background:#0284c7;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">🧹 Clear Stuck Queue &amp; Repair Encryption (Keep QR)</a></p>`
            : (latestQrDataUrl
                ? `<h3>📱 Scan this QR Code from your Phone WhatsApp (Linked Devices &rarr; Link a Device):</h3><img src="${latestQrDataUrl}" style="border:2px solid #16a34a;padding:8px;border-radius:12px;"/><p><a href="/" style="padding:8px 16px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;">Refresh Status</a></p>`
                : `<h3>⏳ Generating QR Code... Please refresh in 3 seconds.</h3><script>setTimeout(()=>location.reload(),3000);</script>`);
        return res.end(`<!DOCTYPE html><html><head><title>TSS 24/7 Free WhatsApp Cloud Server</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;text-align:center;padding:30px;"><h1>🏫 The Smart School — 24/7 Free WhatsApp Server</h1>${statusHtml}</body></html>`);
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
            qr_image: latestQrDataUrl,
            receipts_tracked: receiptStore.size,
            stuck_1tick: stuckCount,
            gateway_version: '2.2-clean-e2ee',
            status_msg: connectionState === 'authorized'
                ? `✅ Free Unlimited WhatsApp Connected (${connectedNumber})! Ready to send Result Cards (Image/PDF) 24/7 with ✓✓ Receipt Tracking!`
                : (latestQrDataUrl
                    ? '📱 Scan this QR Code from your Phone WhatsApp (Linked Devices -> Link a Device)!'
                    : '⏳ Generating WhatsApp QR Code, please wait 2 seconds and click Refresh...')
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

    // Clear stuck 1-tick messages + purge corrupted Signal ratchets while KEEPING QR login intact!
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

        // Cleanly bounce the socket WITHOUT logging out QR so in-memory Signal state reloads cleanly
        try {
            if (sock && typeof sock.end === 'function') {
                sock.end(undefined);
            }
        } catch (e) {}

        return sendJson(res, 200, {
            ok: true,
            cleared_queue: clearedQueue,
            cleared_stuck_receipts: clearedStuckReceipts,
            purged_session_files: purgedFiles,
            message: `Cleared ${clearedStuckReceipts} stuck item(s) and reset ${purgedFiles} Signal encryption session(s). Reconnecting cleanly (QR preserved)!`
        });
    }

    if (pathname === '/logout' && (req.method === 'POST' || req.method === 'GET')) {
        msgStore.clear();
        receiptStore.clear();
        verifiedSessionJids.clear();
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
        isReconnecting = false;
        startWhatsAppConnection();
        return sendJson(res, 200, { ok: true, message: 'Full session reset complete. Generating fresh QR code...' });
    }

    if (pathname === '/send' && req.method === 'POST') {
        let bodyChunks = [];
        req.on('data', (chunk) => bodyChunks.push(chunk));
        req.on('end', async () => {
            try {
                const rawBody = Buffer.concat(bodyChunks).toString('utf8');
                const data = JSON.parse(rawBody || '{}');

                // If socket is mid-reconnect after Render wake-up or /clear-stuck, wait up to 14 seconds for 'authorized'
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
                const forceFresh = !!data.force_fresh_session;
                const fileName = data.filename || data.media_filename || (mediaFormat === 'pdf' ? 'ResultCard.pdf' : 'ResultCard.png');

                const digits = normalizePhoneDigits(phone);
                if (!digits || digits.length < 10) {
                    return sendJson(res, 400, { ok: false, error: 'Valid recipient WhatsApp mobile number is required.' });
                }

                // 1. Verify number on WhatsApp & resolve exact Multi-Device JID
                let targetJid = digits + '@s.whatsapp.net';
                try {
                    const waCheckArr = await sock.onWhatsApp(digits);
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
                    // Proceed with standard JID if lookup times out transiently
                }

                // 2. Ensure fresh PreKey Signal session for recipient & own companion devices (prevents 1-Tick stuck delivery!)
                if (forceFresh || !verifiedSessionJids.has(targetJid)) {
                    purgeStaleSessionFiles(digits);
                    try {
                        const meBase = (sock.user && sock.user.id && typeof jidNormalizedUser === 'function')
                            ? jidNormalizedUser(sock.user.id)
                            : null;
                        const jidsToAssert = meBase ? [targetJid, meBase] : [targetJid];
                        if (typeof sock.assertSessions === 'function') {
                            await sock.assertSessions(jidsToAssert, true);
                        }
                        verifiedSessionJids.add(targetJid);
                    } catch (sessErr) {}
                }

                // 3. Build payload & dispatch with useUserDevicesCache: false so all active devices of parent receive message
                const sendOpts = { useUserDevicesCache: false };
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
                        contentPayload = {
                            image: fileBuffer,
                            caption: message
                        };
                    }
                } else {
                    contentPayload = { text: message };
                }

                const sentResult = await sock.sendMessage(targetJid, contentPayload, sendOpts);

                const messageId = (sentResult && sentResult.key && sentResult.key.id) ? sentResult.key.id : '';
                if (messageId) {
                    if (sentResult.message) {
                        msgStore.set(messageId, sentResult.message);
                        if (msgStore.size > 3000) {
                            const firstKey = msgStore.keys().next().value;
                            msgStore.delete(firstKey);
                        }
                    }
                    recordAndPushReceipt(messageId, targetJid, 'sent_server');

                    // Wait up to 3.2s for instant DELIVERY_ACK (2 Ticks) from parent's phone
                    for (let w = 0; w < 13; w++) {
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
    console.log(` 🏫 THE SMART SCHOOL — FREE UNLIMITED WHATSAPP SERVER v2.2 (PORT ${PORT})`);
    console.log(' ✅ 100% Free • Clean PreKey E2EE • Live ✓✓ Parent Receipt Tracking');
    console.log('======================================================================');
    startWhatsAppConnection();
});
