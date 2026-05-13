# DalaTech routines — local PM2 watcher

`routines/watch.js` is the production-build daemon. It runs permanently on
Bilguun's Windows machine, polls Upstash every 60 seconds for any lead in
status `ready_to_finish`, and runs the full 6-step build pipeline (plan →
generate → self-review → fix loop → deploy → Telegram notify) with no
Vercel time limit.

The Telegram webhook at `api/telegram.js` only queues — it never runs a
build inside the lambda anymore.

## Prerequisites

- Node 18+ already installed (same one the rest of the repo uses).
- `.env.local` at `C:\dev\dalatech-app\.env.local` populated with the same
  variables the deployed app uses: `UPSTASH_REDIS_REST_URL`,
  `UPSTASH_REDIS_REST_TOKEN`, `ANTHROPIC_API_KEY`, `VERCEL_TOKEN`,
  `VERCEL_TEAM_ID` (if used), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
  `RESEND_API_KEY`, etc.
- `npm install` has been run at the project root so `node_modules` exists.

## Windows setup (one-time)

### 1. Install PM2 globally if not already

```powershell
npm install -g pm2
```

### 2. Start the watcher

```powershell
cd C:/dev/dalatech-app
pm2 start routines/watch.js --name dalatech-builder
```

### 3. Save the PM2 process list

```powershell
pm2 save
```

This writes `~/.pm2/dump.pm2` so `pm2 resurrect` can later restore the
process list verbatim.

### 4. Auto-start on every Windows login (Task Scheduler)

Create a task that runs on user login and calls `pm2 resurrect`:

1. Open **Task Scheduler** → **Create Task** (not Basic Task).
2. **General tab**
   - Name: `DalaTech PM2 Resurrect`
   - Check "Run only when user is logged on".
3. **Triggers tab** → New → Begin the task: "At log on" → choose your user.
4. **Actions tab** → New → Action: "Start a program"
   - Program/script: `C:/Users/x86/AppData/Roaming/npm/pm2.cmd`
   - Add arguments: `resurrect`
   - Start in (optional): `C:/dev/dalatech-app`
5. **Conditions tab** → uncheck "Start the task only if the computer is on AC power".
6. Save.

On every Windows login this restarts PM2 and every saved process,
including `dalatech-builder`.

### 5. Day-to-day commands

```powershell
pm2 status                              # list running processes
pm2 logs dalatech-builder               # tail the watcher's log
pm2 logs dalatech-builder --lines 200   # last 200 lines
pm2 restart dalatech-builder            # after editing routines/watch.js
pm2 stop dalatech-builder               # pause without removing it
pm2 delete dalatech-builder             # remove entirely (then pm2 save)
```

## What the watcher does for each lead

1. Polls Upstash via `lib/leads.js#listLeads`, filters to
   `status === "ready_to_finish"`, sorted by lead number.
2. Claims the lead by flipping its status to `finishing` (iteration 1) or
   `changing` (iteration > 1). A second poll cannot pick the same lead up
   because the status is no longer `ready_to_finish`.
3. **STEP 1 — PLAN.** Asks Sonnet for a structured 8-section content plan
   based on the brief and Bilguun's extras (notes, photos, prices,
   address). The full plan is printed to the terminal.
4. **STEP 2 — GENERATE.** Calls `lib/pipeline.js#generateHtml` with
   `quality: "production"`. The plan is injected into `extras.notes` so the
   existing prompt builder treats it as highest-priority client info.
5. **STEP 3 — SELF REVIEW.** Asks Sonnet to adversarially review its own
   HTML against every impeccable ban + Emil motion law. Output is either
   `PASS` or a numbered list of issues.
6. **STEP 4 — FIX.** If issues are found, regenerates with the review
   feedback prepended to `extras.notes`. Loops up to 3 attempts total.
7. **STEP 5 — DEPLOY.** Decorates with the chatbot widget (no chooser bar
   on production builds), pushes to Vercel via `lib/deploy.js`, stores the
   URL on the lead, and sets status to `awaiting_review`.
8. **STEP 6 — NOTIFY.** Sends Bilguun a Telegram reply with the preview
   URL, which iteration passed review, total wall-clock time, and the
   APPROVE / CHANGE instructions.

Failure handling:

- Initial build (iteration 1) failure → status flips to `failed`, lastError
  set, Telegram error sent. The next `#NNN finish` can recover.
- CHANGE failure → status rolls back to `awaiting_review` so the prior
  preview URL stays live; Telegram error sent.
- An uncaught throw in the orchestrator falls the lead to `failed` so it is
  never pinned in `finishing`/`changing` forever.

## Editing the watcher

Whenever you change `routines/watch.js`, restart it so PM2 picks up the
new code:

```powershell
pm2 restart dalatech-builder
```

If you want the watcher to poll more aggressively during testing, set
`WATCH_POLL_MS` in `.env.local` (default 60000):

```env
WATCH_POLL_MS=5000
```

## Daily routines (PM2 cron)

Two additional fire-once routines run on a daily schedule under PM2's
built-in cron syntax. Both are scheduled in Asia/Ulaanbaatar local time
and use `--no-autorestart` so PM2 does not restart the process after it
exits cleanly.

### Morning report — `routines/morning-report.js`

Every day at 09:00 Ulaanbaatar time. Reads every lead from Upstash,
groups them by status, and sends Bilguun a single Telegram message
summarizing what needs attention today: total leads, the breakdown by
status, urgent items (production preview waiting for APPROVE/CHANGE for
2+ days, or a domain pending DNS for 3+ days), and stale demos (SENT
status for 3+ days with no client choice).

```bash
pm2 start routines/morning-report.js \
  --name dalatech-morning \
  --cron "0 9 * * *" \
  --no-autorestart \
  --timezone "Asia/Ulaanbaatar"

pm2 save
```

### Follow-up reminder — `routines/follow-up.js`

Every day at 10:00 Ulaanbaatar time. Scans every lead in `sent` status
that has been sitting for 3+ days without the client choosing a design,
and sends Bilguun one Telegram reminder per lead with the client's name,
phone, email, and the three demo URLs. It is a reminder only — no email
or message is sent to the client; Bilguun decides whether to call or
message them.

```bash
pm2 start routines/follow-up.js \
  --name dalatech-followup \
  --cron "0 10 * * *" \
  --no-autorestart \
  --timezone "Asia/Ulaanbaatar"

pm2 save
```

### Test runs

Either script can be invoked directly without PM2 to verify it works
before scheduling:

```bash
node routines/morning-report.js
node routines/follow-up.js
```

Each one reads `.env.local`, fetches leads from Upstash, sends the
Telegram message(s), and exits.

## Manual routines

### Gmail label organizer — `routines/gmail-organizer.js`

Manual one-shot. Bilguun runs:

```bash
node routines/gmail-organizer.js
```

It connects to Gmail via the official Gmail REST API using an OAuth2
refresh token, creates the `DalaTech/*` label tree if missing, then
classifies every message ever sent FROM the DalaTech system address
(`hello@dalatech.online` by default) and labels each one:

- Lead-notification email subject → `DalaTech/Шинэ хүсэлт`
- Demo-delivery email subject → `DalaTech/Демо илгээсэн`
- Final-site live email subject → `DalaTech/Дууссан`
- Anything else from the system address → `DalaTech/Систем`

When it finishes it sends Bilguun a Telegram summary with the count of
emails labeled per bucket. The organizer is idempotent — re-running it
does not re-label messages that already carry the target label.

#### One-time OAuth setup

1. https://console.cloud.google.com → enable the Gmail API on a project.
2. Create an OAuth client id (type: **Desktop app**). Copy the client id
   and client secret into `.env.local` as `GMAIL_CLIENT_ID` and
   `GMAIL_CLIENT_SECRET`.
3. Run a one-off OAuth flow with scope
   `https://www.googleapis.com/auth/gmail.modify`, `access_type=offline`,
   `prompt=consent` to receive a refresh token. Google's OAuth Playground
   works (choose your own client id under the gear icon). Copy the
   refresh token into `.env.local` as `GMAIL_REFRESH_TOKEN`.
4. (Optional) set `GMAIL_SYSTEM_ADDRESS=hello@dalatech.online` in
   `.env.local` if your `FROM_EMAIL` is a display-name format the
   built-in parser misreads.
