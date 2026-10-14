THIS APPLICATION IS A PERSONAL PROJECT TO MANAGE THINGS AROUND THE HOUSE.
THIS APPLICATION IS MEANT TO BE RUN LOCALLY ON A PERSONAL NETWORK, UTILIZING A DOCKER CONTAINER AND/OR A RASPBERRY PI WITH NO ACCESS ALLOWED FROM OUTSIDE YOUR PERSONAL NETWORK.
PLEASE DO NOT SPIN THIS UP AND ALLOW ANYONE ON THE INTERNET TO ACCESS IT.

# MGMT - Personal homescreen dashboard

Chores, calendar, and (eventually) finances. Runs as a Docker container on a Raspberry Pi.

## Directory layout

```
mgmt-react-webapp/
├── docker-compose.yml   builds and runs the container (recommended)
├── Dockerfiles/
│   └── Dockerfile
├── data/                ← created on first run; mounted into the container
│   ├── config.json      PIN hash, Google Calendar iCal addresses, embed URL
│   ├── bounties.json    posted bounties shown on the dashboard's bounty board
│   └── chores/
│       ├── daily.txt    one chore per line
│       ├── weekly.txt
│       └── monthly.txt
└── src/
    ├── server.js        Node/Express backend
    ├── package.json
    └── static/          served as-is by Express
        ├── index.html   main dashboard
        ├── index.js
        ├── index.css
        ├── admin.html   admin settings page (PIN-protected)
        ├── admin.js
        ├── setup.html   first-time setup wizard
        └── setup.js
```

`data/` is in `.gitignore` because it holds the PIN hash and the secret
calendar addresses. Never commit it.

---

## First-time setup

When you open the app for the first time (or after a full reset), you are
automatically redirected to the setup wizard at `/setup.html`. It walks you
through two steps:

1. **Create a 4-digit admin PIN** — protects the admin settings page
2. **Google Calendar** (optional) — paste a calendar's secret iCal address so
   the dashboard can show your events. You can skip this, and add more
   calendars later from the admin page.

After setup completes you land on the main dashboard.

---

## Main dashboard

The dashboard (`/`) is meant to stay open on a screen around the house. From
top to bottom:

- **Top bar**: date and time on the left, **Login** on the right
- **Chores/Tasks** and the **Bounty Board**, side by side and the same size
- **Calendar**: the next 7 days of events, across the full width. The box
  grows to fit every event, so a busy week makes the page longer.

All three boxes share the same left and right edges.

Click **Login** and enter the PIN to reach the admin page.

---

## Google Calendar setup

The dashboard shows the next 7 days of events from one or more Google
Calendars, using each calendar's private iCal feed. Events from every calendar
are merged into one list, with a colour and name per calendar. No Google Cloud
project or Google sign-in setup is needed.

For each calendar you want to show:

1. In [Google Calendar](https://calendar.google.com/), open **Settings**, pick
   the calendar in the left sidebar, and scroll to **Integrate calendar**.
2. Copy the **Secret address in iCal format**
   (`https://calendar.google.com/calendar/ical/…/private-…/basic.ics`).
3. Paste it into setup step 2, or into Admin page → Google Calendar →
   **Add calendar**. The name is optional; if left blank, the calendar's own
   name from Google is used.

Colours follow the order calendars were added.

**Missing-events warning:** the dashboard shows a red "Calendar incomplete"
banner above the event list whenever events might be missing, so an empty day
is never mistaken for a free one:

- a calendar failed to download (bad link, Google error, or a page that isn't
  a calendar); the other calendars are still listed
- the last download is more than a day old (e.g. the daily reboot didn't happen)
- the server is still downloading after a restart, or can't be reached; the
  dashboard retries every 30 seconds until it can

The addresses are stored in `data/config.json`. Treat them like passwords:
anyone with one can read that calendar. If one leaks, use **Reset** next to the
secret address in Google Calendar, then remove the old entry here and add the
new address.

**When events update:** the server downloads every feed once at startup and
again whenever you add or remove a calendar on the admin page. The host is expected to
reboot daily; to pick up new events sooner, restart the container
(`docker restart mgmt`). Google also caches the feed on its side, so very
recent changes can take a few hours to appear in it.

> Google Workspace (work/school) accounts may have the secret address disabled
> by their administrator.

---

## Docker deployment on Raspberry Pi

From the repository folder:

```bash
docker compose up -d --build
```

This builds the image from `Dockerfiles/Dockerfile`, mounts `./data` into the
container at `/app/data`, and serves the app on port 3000.

The build uses the host's network (`network: host` under `build:` in
`docker-compose.yml`). On some machines, build steps get a DNS server they
can't reach, and `npm install` hangs for a few minutes and then fails with
`EAI_AGAIN registry.npmjs.org`. This only affects building; the running
container still uses Docker's normal network and the `3000:3000` port mapping. Open
`http://<pi-ip>:3000` from any device on your network.

`restart: unless-stopped` in `docker-compose.yml` starts the container again
after a Pi reboot, and the reboot is also what refreshes calendar events (see
above).

**After pulling changes**, run `docker compose up -d --build` again so the
image picks up new code and dependencies. Everything in `data/` is kept.

Without Compose, build from the repository folder (not from `Dockerfiles/`):

```bash
docker build --network host -f Dockerfiles/Dockerfile -t mgmt .
docker run -d \
  -p 3000:3000 \
  -v "$(pwd)/data:/app/data" \
  --restart unless-stopped \
  --name mgmt \
  mgmt
```

## Running locally (no Docker)

```bash
cd src
npm install
node server.js
# Open http://localhost:3000
```

Data is stored in `src/data/` unless you set `DATA_DIR`. `PORT` changes the
port (default 3000).

---

## Admin page

Navigate to the admin page by clicking **Login** on the dashboard and entering
your 4-digit PIN. From there you can:

- **Google Calendar** — add or remove calendars by their secret iCal address,
  and see when each was last downloaded and whether it failed
- **Admin PIN** — change the 4-digit PIN
- **Add/Remove Chores** — manage individual tasks or bulk-import from a `.txt` file
- **Bounty Board** — post one-off tasks with an optional reward, and remove
  them once they're done
- **Danger Zone** — reset everything (clears the PIN, calendar addresses,
  chores, and bounties)

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

## How the bounty board works

Bounties are one-off jobs worth something extra, separate from the recurring
chores (e.g. "Clean out the garage — $10").

- **Posting:** admin page → **Bounty Board** → enter a title (required), a
  reward (optional, free text such as "$10" or "Pizza night"), and a
  description (optional) → **Post bounty**.
- **On the dashboard:** the Bounty Board box sits to the right of
  Chores/Tasks. Each bounty shows its title and reward in bold, with the
  description underneath; the newest is at the top. When there are none, it
  says "No bounties posted right now."
- **Removing:** bounties stay up until removed from the admin page. There is
  no claim or complete button on the dashboard, so remove a bounty once it's
  claimed or no longer needed.
- **Storage:** `data/bounties.json`. The dashboard loads bounties each time
  the page loads, so reload it to see a newly posted one.

---

## Full reset

Admin page → **Danger Zone** → **Reset Everything**

This clears the admin PIN, iCal addresses, calendar embed URL, all chores, and
all bounties, then redirects to the setup wizard.

Alternatively, to reset manually: delete or empty `data/config.json`, the
files in `data/chores/`, and `data/bounties.json`, then restart the server.

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

### Bounty board

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/bounties` | — | All bounties, newest first |
| POST | `/api/bounties` | PIN | Post a bounty — `{ "title", "reward", "description" }` (`reward`/`description` optional) |
| DELETE | `/api/bounties/:id` | PIN | Remove a bounty by id |

### Calendar embed URL (fallback)

Used only when no iCal calendars are added. Admin page → Google Calendar →
"Use embed URL instead" takes a public calendar's embed link and shows it in an
iframe instead of the event list.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/calendar-url` | — | Get embed URL from config |
| POST | `/api/calendar-url` | PIN | Save embed URL — `{ "url": "…" }` |

### Google Calendar (iCal feed)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/calendar/events` | — | Merged iCal events with per-calendar errors and last download time (`loading: true` until the first download finishes), or the embed URL, or `none` |
| GET | `/api/calendar/ical` | PIN | Calendars with masked address, event count, error, and last download time |
| POST | `/api/calendar/ical` | PIN | Add a calendar and re-download — `{ "name": "…", "url": "…" }` (`name` optional) |
| DELETE | `/api/calendar/ical/:id` | PIN | Remove a calendar by id and re-download |

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
