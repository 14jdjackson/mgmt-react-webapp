THIS APPLICATION IS A PERSONAL PROJECT TO MANAGE THINGS AROUND THE HOUSE.
THIS APPLICATION IS MEANT TO BE RUN LOCALLY ON A PERSONAL NETWORK, UTILIZING A DOCKER CONTAINER AND/OR A RASPBERRY PI WITH NO ACCESS ALLOWED FROM OUTSIDE YOUR PERSONAL NETWORK.
PLEASE DO NOT SPIN THIS UP AND ALLOW ANYONE ON THE INTERNET TO ACCESS IT.

# MGMT - Personal homescreen dashboard

Chores, calendar, and (eventually) finances. Runs as a Docker container on a Raspberry Pi.

## Directory layout

```
mgmt/
├── server.js           Node/Express backend
├── package.json
├── Dockerfile
├── data/               ← mount this as a Docker volume
│   ├── config.json     calendar URL + admin PIN hash (written by setup/admin)
│   └── chores/
│       ├── daily.txt   one chore per line
│       ├── weekly.txt
│       └── monthly.txt
└── static/             served as-is by Express
    ├── index.html      main dashboard
    ├── index.js
    ├── admin.html      admin settings page (PIN-protected)
    ├── admin.js
    ├── setup.html      first-time setup wizard
    ├── setup.js
    └── index.css
```

---

## First-time setup

When you open the app for the first time (or after a full reset), you are
automatically redirected to the setup wizard at `/setup.html`. It walks you
through two steps:

1. **Create a 4-digit admin PIN** - protects the admin settings page
2. **Paste your Google Calendar embed URL** (optional - can be skipped and set later)

After setup completes you land on the main dashboard. The setup page will not
appear again unless you reset the app.

To get your Google Calendar embed URL:
Google Calendar → Settings (⚙) → click your calendar name →
"Integrate calendar" → copy the `src="…"` value from the Embed Code block.

**Please note that whatever Google Calendar you embed here will need to be public, or you can try to add OAuth to this before I get to it. Next test for me will be to find out if OAuth will work to get a private Google Calendar up here. There is currently no way to combine all Google Calendars into one view to get a URL, presumably because this is what the homepage of Google Calendar does. With OAuth and an iframe to that homepage, this feature may work better.**

---

## Running locally (no Docker)

```bash
cd src
npm install
node server.js
# Open http://localhost:3000
```

## Docker deployment on Raspberry Pi

### 1. Build

```bash
docker build -t mgmt .
```

### 2. Run

Mount your local `data/` directory so chores and config persist across
container restarts and image rebuilds:

```bash
docker run -d \
  -p 3000:3000 \
  -v /home/pi/mgmt/data:/app/data \
  --restart unless-stopped \
  --name mgmt \
  mgmt
```

Access from any device on your network: `http://<pi-ip>:3000`

`--restart unless-stopped` keeps the container running after a Pi reboot
with no extra configuration.

---

## Admin page

Navigate to the admin page by clicking **Login** on the dashboard and entering
your 4-digit PIN. From there you can:

- **Settings** - update the Google Calendar embed URL or change the admin PIN
- **Add/Remove Chores** - manage individual tasks or bulk-import from a `.txt` file
- **Danger Zone** - reset everything (see below)

---

## How chores work

| File | Reset schedule |
|------|---------------|
| `data/chores/daily.txt` | Every day at 00:00 |
| `data/chores/weekly.txt` | Every Sunday at 00:00 |
| `data/chores/monthly.txt` | 1st of each month at 00:00 |

- One chore per line; blank lines are ignored
- The main page fetches `GET /api/chores` on load and builds the checkbox list
- Checked items are hidden and persisted in `sessionStorage` until the next reset
- Adding/removing from the admin page writes directly to the `.txt` files
- Bulk import reads a `.txt` file line-by-line and adds each line as a chore

---

## Full reset

Admin page → **Danger Zone** → **Reset Everything**

This clears the admin PIN, calendar URL, and all chores, then redirects to the
setup wizard. You will need to go through first-time setup again.

Alternatively, to reset manually: delete or empty `data/config.json` and the
files in `data/chores/`, then restart the server.

---

## API reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/chores` | All chores grouped by reset type |
| GET | `/api/chores/:type` | Chores for one type |
| POST | `/api/chores/:type` | Add a chore - `{ "text": "…" }` |
| DELETE | `/api/chores/:type/by-text` | Remove by text - `{ "text": "…" }` |
| DELETE | `/api/chores/:type/:index` | Remove by line index (0-based) |
| GET | `/api/calendar-url` | Get calendar URL from config.json |
| POST | `/api/calendar-url` | Save calendar URL - `{ "url": "…" }` |
| GET | `/api/pin/exists` | Returns `{ "exists": bool }` |
| POST | `/api/pin/verify` | Verify PIN - `{ "hash": "<sha256 hex>" }` → `{ "valid": bool }` |
| POST | `/api/pin` | Set new PIN - `{ "hash": "<sha256 hex>" }` |
| POST | `/api/reset` | Wipe all data and return to first-time setup state |

The PIN is never transmitted as plaintext, the browser hashes it with SHA-256
and only the hash is sent to and stored by the server.
