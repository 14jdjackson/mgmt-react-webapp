// server.js — MGMT local backend
//
// Serves static files and exposes a small REST API for chore file management
// and persistent config (calendar URL, admin PIN hash).
//
// Expected directory layout at runtime:
//   /app/
//     server.js
//     package.json
//     static/          index.html, admin.html, index.js, admin.js, index.css
//     data/
//       chores/
//         daily.txt
//         weekly.txt
//         monthly.txt
//       config.json    { "calendarUrl": "...", "adminPinHash": "..." }
//
// Environment variables (all optional):
//   DATA_DIR   – absolute path to the data folder  (default: ./data)
//   PORT       – port to listen on                 (default: 3000)

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { google } = require('googleapis');

const app     = express();
const PORT    = parseInt(process.env.PORT || '3000', 10);
// Google credentials: config.json values are used when env vars are not set.
// Env vars always take precedence so existing deployments aren't broken.
function getGoogleCreds() {
    const cfg = readConfig();
    return {
        clientId:     process.env.GOOGLE_CLIENT_ID     || cfg.googleClientId     || '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || cfg.googleClientSecret || '',
    };
}
const DATA_DIR  = process.env.DATA_DIR  || path.join(__dirname, 'data');
const CHORES_DIR = path.join(DATA_DIR, 'chores');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const VALID_TYPES = new Set(['daily', 'weekly', 'monthly']);

// ---------------------------------------------------------------------------
// Startup — ensure directories and default files exist
// ---------------------------------------------------------------------------
function ensureDataDir() {
    fs.mkdirSync(CHORES_DIR, { recursive: true });
    for (const type of VALID_TYPES) {
        const file = path.join(CHORES_DIR, `${type}.txt`);
        if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
    }
    if (!fs.existsSync(CONFIG_FILE)) {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({
            calendarUrl:   '',
            adminPinHash:  ''    // SHA-256 hash of the 4-digit PIN; empty = PIN not yet set
        }, null, 2), 'utf8');
    }
}

// ---------------------------------------------------------------------------
// Config helpers (config.json is the persistent equivalent of an env var)
// ---------------------------------------------------------------------------
function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (_) {
        return {};
    }
}

function writeConfig(patch) {
    const current = readConfig();
    const updated = { ...current, ...patch };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf8');
    return updated;
}

// ---------------------------------------------------------------------------
// Admin auth middleware — checks X-Admin-Pin-Hash header on mutating routes
// ---------------------------------------------------------------------------
function requireAdminPin(req, res, next) {
    const hash = (req.headers['x-admin-pin-hash'] || '').trim().toLowerCase();
    if (!hash) return res.status(401).json({ error: 'Admin PIN required.' });
    const { adminPinHash } = readConfig();
    if (!adminPinHash || hash !== adminPinHash) {
        return res.status(403).json({ error: 'Invalid admin PIN.' });
    }
    next();
}

// ---------------------------------------------------------------------------
// Chore file helpers
// ---------------------------------------------------------------------------
function choreFilePath(resetType) {
    return path.join(CHORES_DIR, `${resetType}.txt`);
}

function readLines(resetType) {
    try {
        return fs.readFileSync(choreFilePath(resetType), 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0);
    } catch (_) {
        return [];
    }
}

function writeLines(resetType, lines) {
    const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
    fs.writeFileSync(choreFilePath(resetType), content, 'utf8');
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'static')));

// ---------------------------------------------------------------------------
// Chore API
// ---------------------------------------------------------------------------

// GET /api/chores — all chores grouped by reset type
app.get('/api/chores', (req, res) => {
    const result = {};
    for (const type of VALID_TYPES) result[type] = readLines(type);
    res.json(result);
});

// GET /api/chores/:type — chores for one reset type
app.get('/api/chores/:type', (req, res) => {
    const { type } = req.params;
    if (!VALID_TYPES.has(type)) {
        return res.status(400).json({ error: `Invalid reset type '${type}'.` });
    }
    res.json(readLines(type));
});

// POST /api/chores/:type — add a chore   body: { "text": "..." }
app.post('/api/chores/:type', requireAdminPin, (req, res) => {
    const { type } = req.params;
    if (!VALID_TYPES.has(type)) {
        return res.status(400).json({ error: `Invalid reset type '${type}'.` });
    }
    const text = (req.body.text || '').trim();
    if (!text) {
        return res.status(400).json({ error: "'text' is required and must not be empty." });
    }
    const lines = readLines(type);
    if (lines.includes(text)) {
        return res.status(200).json({ status: 'exists', message: 'Chore already present.' });
    }
    lines.push(text);
    writeLines(type, lines);
    res.status(201).json({ status: 'added', text, reset_type: type });
});

// DELETE /api/chores/:type/by-text — remove by text   body: { "text": "..." }
app.delete('/api/chores/:type/by-text', requireAdminPin, (req, res) => {
    const { type } = req.params;
    if (!VALID_TYPES.has(type)) {
        return res.status(400).json({ error: `Invalid reset type '${type}'.` });
    }
    const text = (req.body.text || '').trim();
    if (!text) {
        return res.status(400).json({ error: "'text' is required." });
    }
    const lines    = readLines(type);
    const filtered = lines.filter(l => l.toLowerCase() !== text.toLowerCase());
    if (filtered.length === lines.length) {
        return res.status(404).json({ error: `'${text}' not found in ${type}.txt` });
    }
    writeLines(type, filtered);
    res.json({ status: 'deleted', text, removed: lines.length - filtered.length });
});

// DELETE /api/chores/:type/:index — remove by line index (0-based)
app.delete('/api/chores/:type/:index', requireAdminPin, (req, res) => {
    const { type } = req.params;
    const index = parseInt(req.params.index, 10);
    if (!VALID_TYPES.has(type)) {
        return res.status(400).json({ error: `Invalid reset type '${type}'.` });
    }
    const lines = readLines(type);
    if (isNaN(index) || index < 0 || index >= lines.length) {
        return res.status(404).json({ error: `No chore at index ${index} in ${type}.txt` });
    }
    const [removed] = lines.splice(index, 1);
    writeLines(type, lines);
    res.json({ status: 'deleted', text: removed });
});

// ---------------------------------------------------------------------------
// Calendar URL API
//
// GET  /api/calendar-url         — returns the current URL from config.json
// POST /api/calendar-url         — writes a new URL to config.json
//                                  body: { "url": "https://calendar.google.com/..." }
//
// Writing to config.json is the correct persistent equivalent of updating an
// env var: the value survives container restarts as long as DATA_DIR is a
// mounted volume, and the server reads it fresh on every GET request.
// ---------------------------------------------------------------------------
app.get('/api/calendar-url', (req, res) => {
    const config = readConfig();
    res.json({ url: config.calendarUrl || '' });
});

app.post('/api/calendar-url', requireAdminPin, (req, res) => {
    const url = (req.body.url || '').trim();
    if (!url) {
        return res.status(400).json({ error: "'url' is required." });
    }
    if (!url.startsWith('https://calendar.google.com/')) {
        return res.status(400).json({ error: 'URL must be a Google Calendar embed URL (https://calendar.google.com/…).' });
    }
    const updated = writeConfig({ calendarUrl: url });
    res.json({ status: 'saved', url: updated.calendarUrl });
});

// ---------------------------------------------------------------------------
// Admin PIN API
//
// The PIN itself is never sent to or stored by the server — only its SHA-256
// hash (computed in the browser) is stored in config.json.
//
// GET  /api/pin/exists   — returns { exists: bool } so the UI can show the
//                          right prompt without exposing the hash itself.
// POST /api/pin/verify   — body: { hash: "<sha256 hex>" }
//                          returns { valid: bool }
//                          Used by index.js to check the PIN before redirecting.
// POST /api/pin          — body: { hash: "<sha256 hex>" }
//                          Saves a new PIN hash to config.json.
// ---------------------------------------------------------------------------
app.get('/api/pin/exists', (req, res) => {
    const { adminPinHash } = readConfig();
    res.json({ exists: Boolean(adminPinHash) });
});

app.post('/api/pin/verify', (req, res) => {
    const hash = (req.body.hash || '').trim().toLowerCase();
    if (!hash) return res.status(400).json({ error: "'hash' is required." });
    const { adminPinHash } = readConfig();
    res.json({ valid: Boolean(adminPinHash) && hash === adminPinHash });
});

app.post('/api/pin', requireAdminPin, (req, res) => {
    const hash = (req.body.hash || '').trim().toLowerCase();
    // Expect a 64-character hex string (SHA-256 output)
    if (!/^[0-9a-f]{64}$/.test(hash)) {
        return res.status(400).json({ error: 'Invalid hash — expected 64-character hex SHA-256.' });
    }
    writeConfig({ adminPinHash: hash });
    res.json({ status: 'saved' });
});

// ---------------------------------------------------------------------------
// Google Calendar — Device Authorization Flow
//
// Uses OAuth 2.0 for devices (RFC 8628). No redirect URI required — works on
// any hostname or IP address. The OAuth app type in Google Cloud Console must
// be "TV and Limited Input devices" (or Desktop app).
//
// Flow:
//   1. Admin POSTs /api/auth/google/device/start  ->  server gets a user_code
//      from Google and returns it to the admin page.
//   2. Admin visits google.com/device and enters the short code shown on screen.
//   3. Admin page polls GET /api/auth/google/device/poll every few seconds.
//   4. Once the admin approves in their browser, the poll returns 'approved'
//      and the server stores the refresh token in config.json.
//
// GET    /api/auth/google/status         -- connection state (no auth needed)
// GET    /api/auth/google/credentials    -- masked cred info  (admin PIN)
// POST   /api/auth/google/credentials    -- save client ID/secret (admin PIN)
// POST   /api/auth/google/device/start   -- begin device flow (admin PIN)
// GET    /api/auth/google/device/poll    -- check approval   (admin PIN)
// DELETE /api/auth/google                -- disconnect        (admin PIN)
// GET    /api/auth/google/calendars      -- list calendars    (admin PIN)
// POST   /api/auth/google/calendar       -- pick calendar     (admin PIN)
// GET    /api/calendar/events            -- fetch events      (public)
// ---------------------------------------------------------------------------

function makeOAuth2Client() {
    const { clientId, clientSecret } = getGoogleCreds();
    return new google.auth.OAuth2(clientId, clientSecret);
}

// Raw HTTPS POST helper for Google token endpoints (no extra dependencies)
function googlePost(endpoint, params) {
    return new Promise((resolve, reject) => {
        const body    = new URLSearchParams(params).toString();
        const url     = new URL(endpoint);
        const options = {
            hostname: url.hostname,
            path:     url.pathname,
            method:   'POST',
            headers:  {
                'Content-Type':   'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
        };
        const req = require('https').request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Invalid JSON from Google')); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// In-memory state for the pending device authorisation (one at a time)
let pendingDeviceAuth = null;

// GET /api/auth/google/credentials — tells the admin whether credentials are
// set and where they came from, without exposing the secret itself.
app.get('/api/auth/google/credentials', requireAdminPin, (req, res) => {
    const cfg      = readConfig();
    const fromEnv  = Boolean(process.env.GOOGLE_CLIENT_ID);
    const clientId = process.env.GOOGLE_CLIENT_ID || cfg.googleClientId || '';
    res.json({
        source:      fromEnv ? 'env' : (clientId ? 'config' : 'none'),
        clientIdSet: Boolean(clientId),
        clientIdHint: clientId ? clientId.slice(0, 14) + '…' : '',
    });
});

// POST /api/auth/google/credentials — save client ID + secret to config.json.
// Ignored at runtime if the corresponding env vars are set (env takes priority).
app.post('/api/auth/google/credentials', requireAdminPin, (req, res) => {
    const clientId     = (req.body.clientId     || '').trim();
    const clientSecret = (req.body.clientSecret || '').trim();
    if (!clientId || !clientSecret) {
        return res.status(400).json({ error: 'Both clientId and clientSecret are required.' });
    }
    writeConfig({ googleClientId: clientId, googleClientSecret: clientSecret });
    res.json({ status: 'saved' });
});

app.get('/api/auth/google/status', (req, res) => {
    const config = readConfig();
    const { clientId, clientSecret } = getGoogleCreds();
    res.json({
        connected:             Boolean(config.googleRefreshToken),
        email:                 config.googleEmail           || null,
        calendarId:            config.googleCalendarId      || null,
        calendarSummary:       config.googleCalendarSummary || null,
        credentialsConfigured: Boolean(clientId && clientSecret),
    });
});

app.post('/api/auth/google/device/start', requireAdminPin, async (req, res) => {
    const { clientId, clientSecret } = getGoogleCreds();
    if (!clientId || !clientSecret) {
        return res.status(500).json({ error: 'Google credentials not configured. Add your Client ID and Secret in admin settings.' });
    }
    try {
        const data = await googlePost('https://oauth2.googleapis.com/device/code', {
            client_id: clientId,
            scope:     'https://www.googleapis.com/auth/calendar.readonly',
        });
        if (data.error) throw new Error(data.error_description || data.error);

        pendingDeviceAuth = {
            deviceCode:      data.device_code,
            userCode:        data.user_code,
            verificationUrl: data.verification_url,
            expiresAt:       Date.now() + data.expires_in * 1000,
            interval:        data.interval || 5,
        };

        res.json({
            userCode:        data.user_code,
            verificationUrl: data.verification_url,
            expiresIn:       data.expires_in,
            interval:        data.interval || 5,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/google/device/poll', requireAdminPin, async (req, res) => {
    if (!pendingDeviceAuth) {
        return res.status(400).json({ status: 'error', message: 'No pending device auth. Start the flow again.' });
    }
    if (Date.now() > pendingDeviceAuth.expiresAt) {
        pendingDeviceAuth = null;
        return res.json({ status: 'expired' });
    }
    try {
        const { clientId, clientSecret } = getGoogleCreds();
        const data = await googlePost('https://oauth2.googleapis.com/token', {
            client_id:     clientId,
            client_secret: clientSecret,
            device_code:   pendingDeviceAuth.deviceCode,
            grant_type:    'urn:ietf:params:oauth:grant-type:device_code',
        });

        if (data.error) {
            if (data.error === 'authorization_pending') return res.json({ status: 'pending' });
            if (data.error === 'slow_down') {
                pendingDeviceAuth.interval += 5;
                return res.json({ status: 'pending', interval: pendingDeviceAuth.interval });
            }
            pendingDeviceAuth = null;
            return res.json({ status: 'error', message: data.error_description || data.error });
        }

        // Approved — store tokens and fetch the account email for display
        const config = readConfig();
        writeConfig({ googleRefreshToken: data.refresh_token || config.googleRefreshToken });

        try {
            const auth = makeOAuth2Client();
            auth.setCredentials({ access_token: data.access_token });
            const oauth2         = google.oauth2({ version: 'v2', auth });
            const { data: user } = await oauth2.userinfo.get();
            writeConfig({ googleEmail: user.email });
        } catch (_) { /* email is cosmetic */ }

        pendingDeviceAuth = null;
        res.json({ status: 'approved' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.delete('/api/auth/google', requireAdminPin, (req, res) => {
    pendingDeviceAuth = null;
    writeConfig({
        googleRefreshToken:    '',
        googleEmail:           '',
        googleCalendarId:      '',
        googleCalendarSummary: '',
    });
    res.json({ status: 'disconnected' });
});

app.get('/api/auth/google/calendars', requireAdminPin, async (req, res) => {
    const config = readConfig();
    if (!config.googleRefreshToken) {
        return res.status(401).json({ error: 'Not connected to Google Calendar.' });
    }
    try {
        const auth = makeOAuth2Client();
        auth.setCredentials({ refresh_token: config.googleRefreshToken });

        const calendar = google.calendar({ version: 'v3', auth });
        const { data } = await calendar.calendarList.list();
        res.json((data.items || []).map(c => ({
            id:      c.id,
            summary: c.summary,
            primary: Boolean(c.primary),
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/google/calendar', requireAdminPin, (req, res) => {
    const { calendarId, calendarSummary } = req.body;
    if (!calendarId) return res.status(400).json({ error: "'calendarId' is required." });
    writeConfig({ googleCalendarId: calendarId, googleCalendarSummary: calendarSummary || '' });
    res.json({ status: 'saved', calendarId });
});

// GET /api/calendar/events
// Unified endpoint: returns OAuth events when connected, falls back to
// { source: 'iframe', url } when only an embed URL is configured.
app.get('/api/calendar/events', async (req, res) => {
    const config = readConfig();

    const { clientId: gcid, clientSecret: gcsec } = getGoogleCreds();
    if (config.googleRefreshToken && config.googleCalendarId && gcid && gcsec) {
        try {
            const auth = makeOAuth2Client();
            auth.setCredentials({ refresh_token: config.googleRefreshToken });

            const calendar = google.calendar({ version: 'v3', auth });
            const now      = new Date();
            const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

            const { data } = await calendar.events.list({
                calendarId:   config.googleCalendarId,
                timeMin:      now.toISOString(),
                timeMax:      twoWeeks.toISOString(),
                singleEvents: true,
                orderBy:      'startTime',
                maxResults:   30,
            });

            return res.json({ source: 'oauth', events: data.items || [] });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    if (config.calendarUrl) {
        return res.json({ source: 'iframe', url: config.calendarUrl });
    }

    res.json({ source: 'none', events: [] });
});

// ---------------------------------------------------------------------------
// Reset API
//
// POST /api/reset — wipes all configuration and chore data so the app returns
//                   to a "first-time setup" state.
// ---------------------------------------------------------------------------
app.post('/api/reset', requireAdminPin, (req, res) => {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
        calendarUrl:           '',
        adminPinHash:          '',
        googleClientId:        '',
        googleClientSecret:    '',
        googleRefreshToken:    '',
        googleEmail:           '',
        googleCalendarId:      '',
        googleCalendarSummary: '',
    }, null, 2), 'utf8');

    for (const type of VALID_TYPES) {
        fs.writeFileSync(path.join(CHORES_DIR, `${type}.txt`), '', 'utf8');
    }

    res.json({ status: 'reset' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
ensureDataDir();
app.listen(PORT, '0.0.0.0', () => {
    console.log(`MGMT running on http://0.0.0.0:${PORT}`);
    console.log(`Data directory : ${path.resolve(DATA_DIR)}`);
    console.log(`Chores directory: ${CHORES_DIR}`);
    console.log(`Config file    : ${CONFIG_FILE}`);
});
