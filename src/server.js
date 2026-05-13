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

const app     = express();
const PORT    = parseInt(process.env.PORT || '3000', 10);
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
app.post('/api/chores/:type', (req, res) => {
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
app.delete('/api/chores/:type/by-text', (req, res) => {
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
app.delete('/api/chores/:type/:index', (req, res) => {
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

app.post('/api/calendar-url', (req, res) => {
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

app.post('/api/pin', (req, res) => {
    const hash = (req.body.hash || '').trim().toLowerCase();
    // Expect a 64-character hex string (SHA-256 output)
    if (!/^[0-9a-f]{64}$/.test(hash)) {
        return res.status(400).json({ error: 'Invalid hash — expected 64-character hex SHA-256.' });
    }
    writeConfig({ adminPinHash: hash });
    res.json({ status: 'saved' });
});

// ---------------------------------------------------------------------------
// Reset API
//
// POST /api/reset — wipes all configuration and chore data so the app returns
//                   to a "first-time setup" state.
// ---------------------------------------------------------------------------
app.post('/api/reset', (req, res) => {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
        calendarUrl:  '',
        adminPinHash: ''
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
