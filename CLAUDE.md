# DalaTech App — Claude Code Context

## What this is
Automated website demo generator. Client submits form → 3 Sonnet-generated websites deployed to Vercel → client picks one → Bilguun finishes via Telegram.

## Stack
Node.js, Vercel serverless, Upstash Redis, Anthropic Claude API, Resend email, Telegram Bot API, Upstash QStash

## Key files
- api/generate.js — form submission handler
- api/cron.js — stage dispatcher + hourly DNS-propagation sweep
- api/choice.js — design choice handler
- api/telegram.js — Telegram webhook (finish / change / approve / domain)
- lib/process-lead.js — 7-stage pipeline orchestration
- lib/pipeline.js — HTML generation (claude-sonnet-4-6)
- lib/prompt.js — generation prompt with impeccable + emil standards
- lib/leads.js — Upstash Redis storage
- lib/chooser-bar.js — sticky CTA bar on demo sites
- lib/email.js — Resend email templates
- lib/telegram.js — Telegram API calls + command parsers
- lib/deploy.js — Vercel deployment + custom-domain API
- lib/namecheap.js — Namecheap XML API (check / purchase / set nameservers)

## Pipeline stages
generate:1 → deploy:1 → generate:2 → deploy:2 → generate:3 → deploy:3 → send
Each stage runs in its own Vercel function with 300s budget.
Stage chaining uses Upstash QStash to avoid HTTP 508 loop detection.

## Design standards
ALWAYS read /mnt/skills/public/frontend-design/SKILL.md (impeccable) and emil-design-eng skill before touching any generation prompt or UI.

## How to verify changes
1. npx vercel logs --follow (from C:/dev/dalatech-app)
2. Submit test form at app.dalatech.online
3. Watch for 7 stage completions in logs
4. Check dalatech.ai@gmail.com for 3 demo links

## Domain automation (Telegram DOMAIN command)
Two paths. Both end in `domain_pending` status with the hourly cron flipping to `domain_live` once DNS resolves to Vercel.
- `DOMAIN #001 new gsauto.mn` — Path A: Namecheap check → purchase → set Vercel nameservers → add domain to Vercel project → notify Bilguun.
- `DOMAIN #001 existing gsauto.mn` — Path B: add domain to Vercel project → send DNS instructions Bilguun forwards to the client.
- Hourly sweep: `api/cron.js` resolves each pending domain via Node DNS + Vercel `/domains/{domain}/config`; flips to `domain_live` on success, sends a one-shot warning at 72h pending.

## Environment variables (all in Vercel)
ANTHROPIC_API_KEY, RESEND_API_KEY, VERCEL_TOKEN, VERCEL_TEAM_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, QSTASH_TOKEN, FROM_EMAIL, LEAD_NOTIFY_EMAIL, DEMO_DELAY_HOURS, NAMECHEAP_API_KEY, NAMECHEAP_API_USER, NAMECHEAP_USERNAME, NAMECHEAP_CLIENT_IP, NAMECHEAP_REGISTRANT_* (FIRSTNAME/LASTNAME/ADDRESS1/CITY/STATEPROVINCE/POSTALCODE/COUNTRY/PHONE/EMAILADDRESS)
