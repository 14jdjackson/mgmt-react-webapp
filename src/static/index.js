// index.js — MGMT main page
//
// Chores are fetched from GET /api/chores on every load.
// Calendar events are fetched from GET /api/calendar/events.
// Reset scheduling and checkbox state are managed client-side.

// index.js — MGMT main page
//
// Chores are fetched from GET /api/chores on every load.
// Calendar events are fetched from GET /api/calendar/events.
// Admin PIN is verified via POST /api/pin/verify (hash stored in data/config.json).
// Ticked chores and reset timestamps are stored server-side via /api/chores/state.

// ---------------------------------------------------------------------------
// SHA-256 / PIN check
// ---------------------------------------------------------------------------
async function sha256(str) {
    const buffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

async function checkPin(code) {
    // Check whether a PIN has been configured at all first
    const existsResp = await fetch('/api/pin/exists');
    const { exists } = await existsResp.json();
    if (!exists) {
        alert('Admin PIN is not set. Set it in admin.html first.');
        return false;
    }
    const hash = await sha256(code.trim());
    const resp = await fetch('/api/pin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
    });
    const { valid } = await resp.json();
    return valid ? hash : null;
}

// ---------------------------------------------------------------------------
// Chore loading and rendering
// ---------------------------------------------------------------------------
async function loadAndRenderChores() {
    const choresList = document.getElementById('choresList');
    if (!choresList) return;

    let allChores, state;
    try {
        const [choresResp, stateResp] = await Promise.all([fetch('/api/chores'), fetch('/api/chores/state')]);
        if (!choresResp.ok) throw new Error(`HTTP ${choresResp.status}`);
        if (!stateResp.ok)  throw new Error(`HTTP ${stateResp.status}`);
        allChores = await choresResp.json();
        state     = await stateResp.json();
    } catch (err) {
        choresList.innerHTML = `<li style="color:#f88">Could not load chores: ${err.message}</li>`;
        return;
    }

    choresList.innerHTML = '';
    let total = 0;

    for (const resetType of ['daily', 'weekly', 'monthly']) {
        for (const text of (allChores[resetType] || [])) {
            total++;
            const li    = document.createElement('li');
            const label = document.createElement('label');
            const input = document.createElement('input');

            input.type = 'checkbox';
            input.setAttribute('data-reset', resetType);
            input.setAttribute('data-text', text);

            // Checked state lives on the server so it survives reboots
            input.checked = (state.checked[resetType] || []).includes(text);
            input.hidden  = input.checked;

            input.addEventListener('change', async function () {
                this.hidden = this.checked;
                try {
                    const resp = await fetch('/api/chores/check', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: resetType, text, checked: this.checked }),
                    });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                } catch (err) {
                    // Not saved — undo the tick so the screen matches the server
                    this.checked = !this.checked;
                    this.hidden  = this.checked;
                    alert(`Could not save chore: ${err.message}`);
                }
            });

            label.appendChild(input);
            label.appendChild(document.createTextNode(' ' + text));
            li.appendChild(label);
            choresList.appendChild(li);
        }
    }

    if (total === 0) {
        choresList.innerHTML = '<li>No chores configured yet.</li>';
    }
}

// ---------------------------------------------------------------------------
// Reset scheduling
// ---------------------------------------------------------------------------
// Start of the current day / week (Sunday) / month in local time
function periodStart(resetType) {
    const now = new Date();
    if (resetType === 'daily')  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (resetType === 'weekly') return new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    return new Date(now.getFullYear(), now.getMonth(), 1);
}

// The server keeps the last reset time and only resets when it is older than
// periodStart, so this is safe to call on every load. Resets missed while the
// machine was off are applied on the next load. Returns true if any reset ran.
async function applyDueResets() {
    let anyReset = false;
    for (const type of ['daily', 'weekly', 'monthly']) {
        try {
            const resp = await fetch(`/api/chores/reset/${type}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ periodStart: periodStart(type).toISOString() }),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const { status } = await resp.json();
            if (status === 'reset') anyReset = true;
        } catch (err) {
            console.error(`Could not apply ${type} chore reset: ${err.message}`);
        }
    }
    return anyReset;
}

function scheduleDailyReset() {
    const now          = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setDate(now.getDate() + 1);
    nextMidnight.setHours(0, 0, 0, 0);
    setTimeout(async function () {
        if (await applyDueResets()) await loadAndRenderChores();
        initCalendar();
        scheduleDailyReset();
    }, nextMidnight - now);
}

// ---------------------------------------------------------------------------
// Calendar — one-week events list (merged iCal feeds) or iframe fallback
// Calls GET /api/calendar/events which returns one of:
//   { source: 'ical', events, calendars, errors } — render events list
//   { source: 'iframe', url: '...' }              — show embed iframe
//   { source: 'none' }                            — hide section
// ---------------------------------------------------------------------------
const CALENDAR_DAYS = 7;

// The server only downloads feeds at startup (daily reboot). Older than this,
// the end of the 7-day window is past what was downloaded.
const CALENDAR_STALE_MS = 24 * 60 * 60 * 1000;
const CALENDAR_RETRY_MS = 30 * 1000;
let calendarRetryTimer  = null;

function retryCalendarSoon() {
    clearTimeout(calendarRetryTimer);
    calendarRetryTimer = setTimeout(initCalendar, CALENDAR_RETRY_MS);
}

// One colour per calendar, by its position in the admin list
const CALENDAR_COLORS = ['#4e9af1', '#e5a03b', '#5cc489', '#d96fb8', '#9b8cf2', '#e06c6c', '#4fc3c7', '#c9c45a'];

function localDateKey(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// All-day events carry a bare 'YYYY-MM-DD' date; read it as local midnight
function eventStart(event) {
    return event.start.date ? new Date(event.start.date + 'T00:00:00') : new Date(event.start.dateTime);
}

function eventEnd(event) {
    return event.end.date ? new Date(event.end.date + 'T00:00:00') : new Date(event.end.dateTime);
}

function formatEventTime(event) {
    if (event.start.date) return 'All day';
    const t = new Date(event.start.dateTime);
    return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function dayLabel(dateKey) {
    const today    = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    if (dateKey === localDateKey(today))    return 'TODAY';
    if (dateKey === localDateKey(tomorrow)) return 'TOMORROW';
    return new Date(dateKey + 'T00:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
}

// Red banner above the list for anything that means events may be missing
function showCalendarWarning(lines) {
    const box = document.getElementById('calendarWarning');
    if (!box) return;
    box.innerHTML = '';
    box.style.display = lines.length ? 'block' : 'none';
    if (!lines.length) return;

    const heading = document.createElement('strong');
    heading.textContent = '⚠ Calendar incomplete: some events may be missing';
    box.appendChild(heading);
    for (const line of lines) {
        const div = document.createElement('div');
        div.textContent = line;
        box.appendChild(div);
    }
}

function renderEvents({ events, calendars, errors, fetchedAt }) {
    const list = document.getElementById('eventsList');
    if (!list) return;
    list.innerHTML  = '';
    list.style.display = 'block';

    // Keep events overlapping [today 00:00, today + 7 days) in local time
    const now        = new Date();
    const weekStart  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekEnd    = new Date(now.getFullYear(), now.getMonth(), now.getDate() + CALENDAR_DAYS);
    const weekEvents = (events || [])
        .filter(ev => eventStart(ev) < weekEnd && eventEnd(ev) > weekStart)
        .sort((a, b) => eventStart(a) - eventStart(b));

    // A failed feed is reported but doesn't hide the others
    const warnings = (errors || []).map(({ calendar, error }) => `Could not load "${calendar}": ${error}`);
    if (fetchedAt && now - new Date(fetchedAt) > CALENDAR_STALE_MS) {
        warnings.push(`Last downloaded ${new Date(fetchedAt).toLocaleString()}. Restart the server to refresh.`);
    }
    showCalendarWarning(warnings);

    if (weekEvents.length === 0) {
        const li = document.createElement('li');
        li.style.color = '#aaa';
        li.textContent = 'No events in the next week.';
        list.appendChild(li);
        return;
    }

    const showCalendarNames = (calendars || []).length > 1;

    // Events already in progress (e.g. a multi-day trip) are listed under today
    const days = {};
    for (const ev of weekEvents) {
        const start = eventStart(ev);
        const key   = localDateKey(start < weekStart ? weekStart : start);
        if (!days[key]) days[key] = [];
        days[key].push(ev);
    }

    for (const [day, dayEvents] of Object.entries(days).sort(([a], [b]) => a.localeCompare(b))) {
        const header = document.createElement('li');
        header.style.cssText = 'font-weight:bold;color:#888;margin-top:10px;font-size:0.8rem;letter-spacing:0.05em;';
        header.textContent   = dayLabel(day);
        list.appendChild(header);

        for (const ev of dayEvents) {
            const li = document.createElement('li');
            const color = CALENDAR_COLORS[(ev.calendarIndex || 0) % CALENDAR_COLORS.length];
            li.style.cssText = `display:flex;gap:10px;padding:4px 0 4px 10px;border-left:3px solid ${color};margin:3px 0;`;

            const time = document.createElement('span');
            time.style.cssText = 'color:#888;font-size:0.85rem;min-width:52px;flex-shrink:0;';
            time.textContent   = formatEventTime(ev);

            const title = document.createElement('span');
            title.textContent = ev.summary || '(no title)';

            li.appendChild(time);
            li.appendChild(title);
            if (showCalendarNames) {
                const name = document.createElement('span');
                name.style.cssText = `color:${color};font-size:0.8rem;margin-left:auto;padding-right:6px;`;
                name.textContent   = ev.calendar;
                li.appendChild(name);
            }
            list.appendChild(li);
        }
    }
}

async function initCalendar() {
    const calDiv = document.getElementById('calendarDiv');
    if (!calDiv) return;

    try {
        const resp = await fetch('/api/calendar/events');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        if (data.source === 'ical' && data.loading) {
            showCalendarWarning(['The server is still downloading your calendars. Retrying in 30 seconds…']);
            retryCalendarSoon();
        } else if (data.source === 'ical') {
            renderEvents(data);
        } else if (data.source === 'iframe' && data.url) {
            const iframe = document.getElementById('calendarIframe');
            if (iframe) { iframe.src = data.url; iframe.style.display = ''; }
        } else {
            calDiv.style.display = 'none';
        }
    } catch (err) {
        // Don't hide the section: an empty calendar would look like a free week
        showCalendarWarning([`Could not reach the server for calendar events (${err.message}). Retrying in 30 seconds…`]);
        const list = document.getElementById('eventsList');
        if (list) { list.innerHTML = ''; list.style.display = 'none'; }
        retryCalendarSoon();
    }
}

// ---------------------------------------------------------------------------
// Bounty board — one-off tasks with an extra reward, posted from the admin
// page. Fetched fresh from GET /api/bounties on every load.
// ---------------------------------------------------------------------------
async function loadAndRenderBounties() {
    const list = document.getElementById('bountyList');
    if (!list) return;

    let bounties;
    try {
        const resp = await fetch('/api/bounties');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        bounties = await resp.json();
    } catch (err) {
        list.innerHTML = `<li style="color:#f88">Could not load bounty board: ${err.message}</li>`;
        return;
    }

    list.innerHTML = '';

    if (!bounties || bounties.length === 0) {
        list.innerHTML = '<li style="color:#aaa;">No bounties posted right now.</li>';
        return;
    }

    for (const bounty of bounties) {
        const li = document.createElement('li');

        const titleLine = document.createElement('div');
        titleLine.textContent = bounty.reward ? `${bounty.title} — ${bounty.reward}` : bounty.title;
        titleLine.style.fontWeight = 'bold';
        li.appendChild(titleLine);

        if (bounty.description) {
            const descLine = document.createElement('div');
            descLine.textContent = bounty.description;
            descLine.style.cssText = 'color:#ccc;font-size:0.85rem;margin-top:2px;';
            li.appendChild(descLine);
        }

        list.appendChild(li);
    }
}

// ---------------------------------------------------------------------------
// Date/time label
// ---------------------------------------------------------------------------
function updateDateTime() {
    const label = document.getElementById('dateTimeLabel');
    if (!label) return;
    label.textContent = `Date/Time: ${new Date().toLocaleString([], {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    })}`;
}

// ---------------------------------------------------------------------------
// Admin PIN gate
// ---------------------------------------------------------------------------
async function askAdminPin() {
    const code = prompt('Enter 4-digit admin PIN to continue:');
    if (code === null) return;
    if (!/^\d{4}$/.test(code.trim())) {
        alert('Please enter a valid 4-digit PIN.');
        return;
    }
    const hash = await checkPin(code);
    if (hash) {
        sessionStorage.setItem('adminPinHash', hash);
        window.location.href = 'admin.html';
    } else {
        alert('Wrong PIN. Access denied.');
    }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async function () {
    // Redirect to setup if no PIN has been configured yet
    try {
        const existsResp = await fetch('/api/pin/exists');
        const { exists } = await existsResp.json();
        if (!exists) {
            window.location.href = 'setup.html';
            return;
        }
    } catch (_) { /* server unreachable — fall through and show page as-is */ }

    const loginButton = document.getElementById('loginButton');
    if (loginButton) loginButton.addEventListener('click', askAdminPin);

    await applyDueResets();
    await loadAndRenderChores();
    await initCalendar();
    await loadAndRenderBounties();

    updateDateTime();
    setInterval(updateDateTime, 1000);
    scheduleDailyReset();
});
