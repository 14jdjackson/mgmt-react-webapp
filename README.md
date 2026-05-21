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
│   ├── config.json     PIN hash, Google credentials, calendar selection
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

1. **Create a 4-digit admin PIN** — protects the admin settings page
2. **Google Calendar credentials** (optional) — paste your OAuth Client ID and
   Client Secret so the app can connect to a private Google Calendar. You can
   skip this and add them later from the admin page.

After setup completes you land on the main dashboard.

---

## Google Calendar setup

The app uses the **OAuth 2.0 Device Authorization Flow**, which works on any
hostname or IP address — no redirect URI or domain name required.

### Step 1 — Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and
   create a new project (or select an existing one).
2. In the sidebar: **APIs & Services → Library** → search for
   **Google Calendar API** → Enable it.

### Step 2 — Create OAuth 2.0 credentials

1. **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
2. Application type: **TV and Limited Input devices**
   *(this is the type that supports the device flow — no redirect URI needed)*
3. Give it a name (e.g. "MGMT Dashboard") and click **Create**.
4. Copy the **Client ID** and **Client Secret** from the confirmation dialog.

> If Google asks you to configure the OAuth consent screen first, set it to
> **Internal** (if using a Google Workspace account) or **External** with your
> own email as a test user.

### Step 3 — Enter credentials in MGMT

**During first-time setup:** paste the Client ID and Secret into the fields on
setup step 2.

**After setup / to update credentials:** Admin page → Google Calendar section
→ enter Client ID and Secret → **Save credentials**.

Credentials are stored in `data/config.json`. If you prefer to inject them as
environment variables instead, set `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` — env vars always take priority over the saved values.

### Step 4 — Connect your Google Account

1. Go to the **Admin page** → Google Calendar section.
2. Click **Connect Google Calendar**.
3. The admin page shows a short code and a link to **google.com/device**.
4. Open that link in any browser, sign in to your Google Account, and enter
   the code. You have a few minutes before it expires.
5. The admin page detects approval automatically and prompts you to choose
   which calendar to display.
6. Select a calendar and click **Use this calendar**. The main dashboard will
   now show upcoming events from that calendar.

To switch accounts or calendars, click **Disconnect** and repeat the flow.

---

## Running locally (no Docker)

```bash
cd src
npm install
node server.js
# Open http://localhost:3000
```

To use Google Calendar locally, set the env vars before starting:

```bash
GOOGLE_CLIENT_ID=your-id GOOGLE_CLIENT_SECRET=your-secret node server.js
```

Or skip the env vars and enter the credentials via the admin page after setup.

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

If you prefer to pass Google credentials as env vars rather than through the UI:

```bash
docker run -d \
  -p 3000:3000 \
  -v /home/pi/mgmt/data:/app/data \
  -e GOOGLE_CLIENT_ID=your-id \
  -e GOOGLE_CLIENT_SECRET=your-secret \
  --restart unless-stopped \
  --name mgmt \
  mgmt
```

Or use `docker-compose.yml` — add them under the `environment:` key.

---

## Admin page

Navigate to the admin page by clicking **Login** on the dashboard and entering
your 4-digit PIN. From there you can:

- **Google Calendar** — save/update OAuth credentials, connect or disconnect
  your Google Account, and choose which calendar to display
- **Admin PIN** — change the 4-digit PIN
- **Add/Remove Chores** — manage individual tasks or bulk-import from a `.txt` file
- **Danger Zone** — reset everything (clears PIN, credentials, tokens, and all chores)

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

This clears the admin PIN, Google credentials, OAuth tokens, calendar
selection, calendar embed URL, and all chores, then redirects to the setup
wizard.

Alternatively, to reset manually: delete or empty `data/config.json` and the
files in `data/chores/`, then restart the server.

---

## API reference

### Chores

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/chores` | — | All chores grouped by reset type |
| GET | `/api/chores/:type` | — | Chores for one type (`daily`/`weekly`/`monthly`) |
| POST | `/api/chores/:type` | PIN | Add a chore — `{ "text": "…" }` |
| DELETE | `/api/chores/:type/by-text` | PIN | Remove by text — `{ "text": "…" }` |
| DELETE | `/api/chores/:type/:index` | PIN | Remove by line index (0-based) |

### Calendar (embed URL fallback)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/calendar-url` | — | Get embed URL from config |
| POST | `/api/calendar-url` | PIN | Save embed URL — `{ "url": "…" }` |
| GET | `/api/calendar/events` | — | Unified: returns OAuth events, iframe URL, or `none` |

### Google Calendar OAuth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/auth/google/status` | — | Connection state and calendar info |
| GET | `/api/auth/google/credentials` | PIN | Whether credentials are set and their source |
| POST | `/api/auth/google/credentials` | PIN | Save Client ID + Secret — `{ "clientId", "clientSecret" }` |
| POST | `/api/auth/google/device/start` | PIN | Begin device auth flow — returns `{ userCode, verificationUrl }` |
| GET | `/api/auth/google/device/poll` | PIN | Poll for user approval — returns `{ status }` |
| DELETE | `/api/auth/google` | PIN | Disconnect (clears tokens) |
| GET | `/api/auth/google/calendars` | PIN | List the user's calendars |
| POST | `/api/auth/google/calendar` | PIN | Select which calendar to show — `{ "calendarId", "calendarSummary" }` |

### Admin PIN

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/pin/exists` | — | Returns `{ "exists": bool }` |
| POST | `/api/pin/verify` | — | Verify PIN hash — `{ "hash": "<sha256 hex>" }` → `{ "valid": bool }` |
| POST | `/api/pin` | PIN | Set new PIN — `{ "hash": "<sha256 hex>" }` |
| POST | `/api/reset` | PIN | Wipe all data and return to setup state |

The PIN is never transmitted as plaintext — the browser hashes it with SHA-256
and only the hash is sent to and stored by the server.

**Auth (PIN)** means the request must include an `X-Admin-Pin-Hash` header
containing the SHA-256 hex hash of the current 4-digit PIN.
