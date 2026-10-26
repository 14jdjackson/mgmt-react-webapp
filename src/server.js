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
//       chore-state.json  ticked chores + last reset time per type
//       config.json   { "calendarUrl": "...", "icalFeeds": [...], "adminPinHash": "..." }
//
// Environment variables (all optional):
//   DATA_DIR   – absolute path to the data folder  (default: ./data)
//   PORT       – port to listen on                 (default: 3000)

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const ical    = require('node-ical');

const app     = express();
const PORT    = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR  = process.env.DATA_DIR  || path.join(__dirname, 'data');
const CHORES_DIR = path.join(DATA_DIR, 'chores');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const BOUNTIES_FILE = path.join(DATA_DIR, 'bounties.json');
const CHORE_STATE_FILE = path.join(DATA_DIR, 'chore-state.json');

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
    if (!fs.existsSync(BOUNTIES_FILE)) {
        fs.writeFileSync(BOUNTIES_FILE, JSON.stringify([], null, 2), 'utf8');
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
// Chore state helpers — which chores are ticked off, and when each reset type
// last reset. Kept in data/chore-state.json so it survives reboots.
//   { "lastReset": { "daily": "<ISO>", ... }, "checked": { "daily": ["text", ...], ... } }
// ---------------------------------------------------------------------------
function emptyChoreState() {
    const state = { lastReset: {}, checked: {} };
    for (const type of VALID_TYPES) {
        state.lastReset[type] = null;
        state.checked[type]   = [];
    }
    return state;
}

function readChoreState() {
    const state = emptyChoreState();
    try {
        const saved = JSON.parse(fs.readFileSync(CHORE_STATE_FILE, 'utf8'));
        for (const type of VALID_TYPES) {
            if (saved.lastReset && saved.lastReset[type]) state.lastReset[type] = saved.lastReset[type];
            if (saved.checked && Array.isArray(saved.checked[type])) state.checked[type] = saved.checked[type];
        }
    } catch (_) { /* missing or corrupt — start fresh */ }
    return state;
}

function writeChoreState(state) {
    // Write then rename, so a power cut mid-write can't leave a half-written file
    const tmp = CHORE_STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, CHORE_STATE_FILE);
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

// GET /api/chores/state — ticked chores and last reset times (public)
// Ticks for chores that have since been deleted are dropped.
app.get('/api/chores/state', (req, res) => {
    const state = readChoreState();
    for (const type of VALID_TYPES) {
        const current = new Set(readLines(type));
        state.checked[type] = state.checked[type].filter(text => current.has(text));
    }
    res.json(state);
});

// POST /api/chores/check — tick or untick a chore (public)
//   body: { "type": "daily", "text": "...", "checked": true }
app.post('/api/chores/check', (req, res) => {
    const type    = req.body.type;
    const text    = (req.body.text || '').trim();
    const checked = Boolean(req.body.checked);
    if (!VALID_TYPES.has(type)) {
        return res.status(400).json({ error: `Invalid reset type '${type}'.` });
    }
    if (!text) {
        return res.status(400).json({ error: "'text' is required." });
    }
    const state = readChoreState();
    const list  = state.checked[type].filter(t => t !== text);
    if (checked) list.push(text);
    state.checked[type] = list;
    writeChoreState(state);
    res.json({ status: 'saved', type, text, checked });
});

// POST /api/chores/reset/:type — untick every chore of this type (public)
//   body: { "periodStart": "<ISO>" }
// Only resets if the last reset was before periodStart (the start of the
// current day/week/month in the browser's local time), so a second screen or
// a page reload can't wipe chores ticked off since the reset already happened.
app.post('/api/chores/reset/:type', (req, res) => {
    const { type } = req.params;
    if (!VALID_TYPES.has(type)) {
        return res.status(400).json({ error: `Invalid reset type '${type}'.` });
    }
    const periodStart = new Date(req.body.periodStart);
    if (isNaN(periodStart)) {
        return res.status(400).json({ error: "'periodStart' must be an ISO date." });
    }
    const state     = readChoreState();
    const lastReset = new Date(state.lastReset[type] || 0);
    if (lastReset >= periodStart) {
        return res.json({ status: 'skipped', ...state });
    }
    state.checked[type]   = [];
    state.lastReset[type] = new Date().toISOString();
    writeChoreState(state);
    res.json({ status: 'reset', ...state });
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
// Bounty board API
//
// One-off tasks worth an extra reward, posted from the admin page and shown
// on the main dashboard's bounty board. Stored as a flat JSON array in
// data/bounties.json.
//
// GET    /api/bounties       — all bounties, newest first  (public)
// POST   /api/bounties       — post a bounty                (admin PIN)
//                               body: { "title", "reward", "description" }
// DELETE /api/bounties/:id   — remove a bounty              (admin PIN)
// ---------------------------------------------------------------------------
function readBounties() {
    try {
        return JSON.parse(fs.readFileSync(BOUNTIES_FILE, 'utf8'));
    } catch (_) {
        return [];
    }
}

function writeBounties(bounties) {
    fs.writeFileSync(BOUNTIES_FILE, JSON.stringify(bounties, null, 2), 'utf8');
}

app.get('/api/bounties', (req, res) => {
    const bounties = readBounties()
        .slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(bounties);
});

app.post('/api/bounties', requireAdminPin, (req, res) => {
    const title       = (req.body.title       || '').trim();
    const reward      = (req.body.reward      || '').trim();
    const description = (req.body.description || '').trim();

    if (!title) {
        return res.status(400).json({ error: "'title' is required and must not be empty." });
    }

    const bounty = {
        id:          crypto.randomUUID(),
        title,
        reward,
        description,
        createdAt:   new Date().toISOString(),
    };

    const bounties = readBounties();
    bounties.push(bounty);
    writeBounties(bounties);

    res.status(201).json(bounty);
});

app.delete('/api/bounties/:id', requireAdminPin, (req, res) => {
    const { id }    = req.params;
    const bounties  = readBounties();
    const filtered  = bounties.filter(b => b.id !== id);
    if (filtered.length === bounties.length) {
        return res.status(404).json({ error: `No bounty with id '${id}'.` });
    }
    writeBounties(filtered);
    res.json({ status: 'deleted', id });
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
// Google Calendar — private iCal feeds
//
// Google Calendar → Settings → (calendar) → Integrate calendar →
// "Secret address in iCal format". Any number of feeds can be added; their
// events are merged into one list. Feeds are downloaded once at startup (the
// host reboots daily) and again whenever the admin adds or removes one.
// Events for the next week are kept in memory and served to the dashboard.
//
// config.json: icalFeeds: [{ id, name, url }]   (name may be '' — the feed's
//              own calendar name is used instead)
//
// GET    /api/calendar/ical       -- feeds with status, masked addresses (admin PIN)
// POST   /api/calendar/ical       -- add a feed and re-download         (admin PIN)
//                                    body: { "name": "…", "url": "https://…/basic.ics" }
// DELETE /api/calendar/ical/:id   -- remove a feed and re-download      (admin PIN)
// GET    /api/calendar/events     -- cached events                      (public)
// ---------------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR_DAYS = 7;

// feeds: [{ id, name, eventCount, error }] in config order
let calendarCache = { events: [], feeds: [], fetchedAt: null };

function readIcalFeeds() {
    const { icalFeeds } = readConfig();
    return Array.isArray(icalFeeds) ? icalFeeds : [];
}

// Parsed text fields are either a string or { val, params }
function icalText(value) {
    if (typeof value === 'string') return value;
    return (value && value.val) || '';
}

// node-ical places all-day dates at local midnight of this process
function localDateString(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function loadIcalFeed(feed, index) {
    // Pad the range by a day each side; the browser trims it to its own
    // local "today + 7 days", since this server may be running in UTC.
    const from = new Date(Date.now() - DAY_MS);
    const to   = new Date(Date.now() + (CALENDAR_DAYS + 1) * DAY_MS);

    try {
        const data = await ical.async.fromURL(feed.url);
        // A login or error page parses as an empty calendar; treat it as a failure
        if (!data.vcalendar) throw new Error('the address did not return a calendar (check the link)');
        const name = feed.name || icalText(data.vcalendar && data.vcalendar['WR-CALNAME']) || `Calendar ${index + 1}`;

        const events = [];
        for (const ev of Object.values(data)) {
            if (ev.type !== 'VEVENT') continue;
            for (const inst of ical.expandRecurringEvent(ev, { from, to, expandOngoing: true })) {
                if ((inst.event || ev).status === 'CANCELLED') continue;
                const end = inst.end || inst.start;
                const base = { summary: icalText(inst.summary), calendar: name, calendarIndex: index };
                events.push(inst.isFullDay
                    ? { ...base, start: { date: localDateString(inst.start) }, end: { date: localDateString(end) } }
                    : { ...base, start: { dateTime: inst.start.toISOString() }, end: { dateTime: end.toISOString() } });
            }
        }
        console.log(`Calendar feed "${name}" loaded: ${events.length} event(s)`);
        return { id: feed.id, name, events, error: null };
    } catch (err) {
        const name = feed.name || `Calendar ${index + 1}`;
        console.error(`Calendar feed "${name}" failed: ${err.message}`);
        return { id: feed.id, name, events: [], error: err.message };
    }
}

async function loadCalendarFeeds() {
    const results = await Promise.all(readIcalFeeds().map(loadIcalFeed));
    calendarCache = {
        events:    results.flatMap(r => r.events),
        feeds:     results.map(({ id, name, events, error }) => ({ id, name, eventCount: events.length, error })),
        fetchedAt: results.length ? new Date().toISOString() : null,
    };
}

function maskUrl(url) {
    return url ? url.slice(0, 40) + '…' : '';
}

function icalStatus() {
    return {
        fetchedAt: calendarCache.fetchedAt,
        feeds: readIcalFeeds().map(feed => {
            const cached = calendarCache.feeds.find(f => f.id === feed.id) || {};
            return {
                id:         feed.id,
                name:       cached.name || feed.name,
                urlHint:    maskUrl(feed.url),
                eventCount: cached.eventCount || 0,
                error:      cached.error || null,
            };
        }),
    };
}

app.get('/api/calendar/ical', requireAdminPin, (req, res) => {
    res.json(icalStatus());
});

app.post('/api/calendar/ical', requireAdminPin, async (req, res) => {
    const name = (req.body.name || '').trim();
    let url    = (req.body.url  || '').trim();
    if (url.startsWith('webcal://')) url = 'https://' + url.slice('webcal://'.length);
    if (!url.startsWith('https://')) {
        return res.status(400).json({ error: 'Address must start with https:// (or webcal://).' });
    }
    const feeds = readIcalFeeds();
    if (feeds.some(f => f.url === url)) {
        return res.status(409).json({ error: 'That calendar address is already added.' });
    }
    const id = crypto.randomUUID();
    writeConfig({ icalFeeds: [...feeds, { id, name, url }] });
    await loadCalendarFeeds();
    res.status(201).json({ status: 'added', id, ...icalStatus() });
});

app.delete('/api/calendar/ical/:id', requireAdminPin, async (req, res) => {
    const feeds    = readIcalFeeds();
    const filtered = feeds.filter(f => f.id !== req.params.id);
    if (filtered.length === feeds.length) {
        return res.status(404).json({ error: `No calendar feed with id '${req.params.id}'.` });
    }
    writeConfig({ icalFeeds: filtered });
    await loadCalendarFeeds();
    res.json({ status: 'deleted', ...icalStatus() });
});

// GET /api/calendar/events
// Returns the merged iCal events when any feed is configured, falls back to
// { source: 'iframe', url } when only an embed URL is configured.
app.get('/api/calendar/events', (req, res) => {
    const config = readConfig();

    if (readIcalFeeds().length > 0) {
        // Feeds download in the background at startup; until the first
        // download finishes, say so rather than serve an empty week.
        return res.json({
            source:    'ical',
            loading:   !calendarCache.fetchedAt,
            events:    calendarCache.events,
            calendars: calendarCache.feeds.map(f => f.name),
            fetchedAt: calendarCache.fetchedAt,
            errors:    calendarCache.feeds.filter(f => f.error).map(f => ({ calendar: f.name, error: f.error })),
        });
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
        calendarUrl:  '',
        icalFeeds:    [],
        adminPinHash: '',
    }, null, 2), 'utf8');
    calendarCache = { events: [], feeds: [], fetchedAt: null };

    for (const type of VALID_TYPES) {
        fs.writeFileSync(path.join(CHORES_DIR, `${type}.txt`), '', 'utf8');
    }

    writeBounties([]);
    writeChoreState(emptyChoreState());

    res.json({ status: 'reset' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
ensureDataDir();
loadCalendarFeeds();
app.listen(PORT, '0.0.0.0', () => {
    console.log(`MGMT running on http://0.0.0.0:${PORT}`);
    console.log(`Data directory : ${path.resolve(DATA_DIR)}`);
    console.log(`Chores directory: ${CHORES_DIR}`);
    console.log(`Config file    : ${CONFIG_FILE}`);
});
