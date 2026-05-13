"use strict";

// DalaTech Gmail label organizer.
//
// Manual one-shot: `node routines/gmail-organizer.js`.
//
// Connects to the user's Gmail using OAuth2 refresh-token credentials
// stored in .env.local, creates the DalaTech/* label tree if missing,
// then classifies every message ever sent FROM the DalaTech system
// address (`hello@dalatech.online` by default) and labels it:
//
//   • subject contains "Шинэ" / "Шинэ хүсэлт" / "New DalaTech lead"
//       → DalaTech/Шинэ хүсэлт
//   • subject contains "демо" or "бэлэн боллоо"
//       → DalaTech/Демо илгээсэн
//   • subject contains "амьдарлаа" (final-site live email)
//       → DalaTech/Дууссан
//   • everything else from the system address
//       → DalaTech/Систем (catch-all)
//
// At the end it pushes a one-line Telegram summary to Bilguun.
//
// One-time OAuth setup (Bilguun does this once):
//   1. https://console.cloud.google.com → enable Gmail API
//   2. Create OAuth client id (type: Desktop app). Copy id + secret.
//   3. Use Google's OAuth Playground or a small local flow with scope
//      `https://www.googleapis.com/auth/gmail.modify` to obtain a
//      refresh token (offline access, prompt=consent).
//   4. Save GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN
//      in .env.local.
//
// Uses Node 18+ fetch — no new npm dependencies.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env.local") });

const { sendTelegramReply, envState: telegramEnvState } = require("../lib/telegram");

const LABELS = {
  newLead:  "DalaTech/Шинэ хүсэлт",
  demoSent: "DalaTech/Демо илгээсэн",
  done:     "DalaTech/Дууссан",
  system:   "DalaTech/Систем"
};

function log(...args) {
  console.log(`[gmail-organizer ${new Date().toISOString()}]`, ...args);
}

function systemAddress() {
  const explicit = (process.env.GMAIL_SYSTEM_ADDRESS || "").trim();
  if (explicit) return explicit.toLowerCase();
  const from = (process.env.FROM_EMAIL || "").trim();
  const m = from.match(/<([^>]+)>/);
  if (m && m[1]) return m[1].toLowerCase();
  if (from && from.includes("@")) return from.toLowerCase();
  return "hello@dalatech.online";
}

// ---------------------------------------------------------------------------
// OAuth — swap refresh token for an access token.
// ---------------------------------------------------------------------------

async function getAccessToken() {
  const clientId = (process.env.GMAIL_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GMAIL_CLIENT_SECRET || "").trim();
  const refreshToken = (process.env.GMAIL_REFRESH_TOKEN || "").trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN must be set in .env.local");
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`OAuth token refresh failed (${res.status}): ${json.error_description || json.error || "unknown"}`);
  }
  return json.access_token;
}

// ---------------------------------------------------------------------------
// Gmail REST helpers.
// ---------------------------------------------------------------------------

async function gmailFetch(accessToken, urlPath, init = {}) {
  const url = `https://gmail.googleapis.com${urlPath}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `Gmail API ${res.status}`;
    throw new Error(`${init.method || "GET"} ${urlPath} failed: ${msg}`);
  }
  return body;
}

async function listAllLabels(token) {
  const body = await gmailFetch(token, "/gmail/v1/users/me/labels");
  return Array.isArray(body.labels) ? body.labels : [];
}

async function createLabel(token, name) {
  return gmailFetch(token, "/gmail/v1/users/me/labels", {
    method: "POST",
    body: JSON.stringify({
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show"
    })
  });
}

async function ensureLabels(token) {
  const existing = await listAllLabels(token);
  const byName = new Map(existing.map(l => [l.name, l.id]));
  const created = [];
  for (const name of Object.values(LABELS)) {
    if (byName.has(name)) continue;
    log(`creating label: ${name}`);
    const label = await createLabel(token, name);
    byName.set(name, label.id);
    created.push(name);
  }
  if (created.length === 0) log("all labels already exist");
  const ids = {};
  for (const [key, name] of Object.entries(LABELS)) ids[key] = byName.get(name);
  return ids;
}

async function searchMessages(token, query) {
  const out = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ q: query, maxResults: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const body = await gmailFetch(token, `/gmail/v1/users/me/messages?${params.toString()}`);
    for (const m of body.messages || []) out.push(m.id);
    pageToken = body.nextPageToken;
  } while (pageToken);
  return out;
}

async function getMessageHeaders(token, id) {
  const body = await gmailFetch(
    token,
    `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`
  );
  const headers = body?.payload?.headers || [];
  const get = (name) => (headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || "");
  return {
    id,
    subject: get("Subject"),
    from: get("From"),
    labelIds: body.labelIds || []
  };
}

async function addLabel(token, messageId, labelId) {
  return gmailFetch(token, `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds: [labelId] })
  });
}

// ---------------------------------------------------------------------------
// Classification — order matters: more specific buckets win first.
// ---------------------------------------------------------------------------

function classify(subject) {
  const s = (subject || "").toLowerCase();
  if (s.includes("new dalatech lead") || s.includes("шинэ хүсэлт") || s.includes("шинэ захиалга")) return "newLead";
  if (s.includes("амьдарлаа")) return "done";
  if (s.includes("демо") || s.includes("бэлэн боллоо")) return "demoSent";
  return "system";
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  const required = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
  const missing = required.filter(k => !process.env[k] || !String(process.env[k]).trim());
  if (missing.length > 0) {
    log(`FATAL: missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  const sysAddr = systemAddress();
  log(`system address: ${sysAddr}`);

  log("requesting Gmail access token…");
  const token = await getAccessToken();

  log("ensuring DalaTech/* labels exist…");
  const labelIds = await ensureLabels(token);

  log(`searching messages from:${sysAddr}…`);
  const ids = await searchMessages(token, `from:${sysAddr}`);
  log(`found ${ids.length} candidate messages`);

  const tally = { newLead: 0, demoSent: 0, done: 0, system: 0, skipped: 0, errors: 0 };

  for (const id of ids) {
    try {
      const headers = await getMessageHeaders(token, id);
      const bucket = classify(headers.subject);
      const labelId = labelIds[bucket];
      if (!labelId) {
        tally.errors++;
        continue;
      }
      if (headers.labelIds.includes(labelId)) {
        tally.skipped++;
        continue;
      }
      await addLabel(token, id, labelId);
      tally[bucket]++;
      log(`labeled ${id.slice(0, 8)} → ${LABELS[bucket]}  (${headers.subject.slice(0, 60)})`);
    } catch (err) {
      tally.errors++;
      log(`message ${id} failed: ${err?.message || err}`);
    }
  }

  const labeled = tally.newLead + tally.demoSent + tally.done + tally.system;
  log(`done. labeled=${labeled} skipped=${tally.skipped} errors=${tally.errors}`);

  const summary = [
    `✅ Gmail зохион байгуулагдлаа.`,
    `${labeled} имэйл шошгологдлоо.`,
    "",
    `Шинэ хүсэлт: ${tally.newLead}`,
    `Демо илгээсэн: ${tally.demoSent}`,
    `Дууссан: ${tally.done}`,
    `Систем: ${tally.system}`
  ];
  if (tally.skipped > 0) summary.push(`(${tally.skipped} имэйл аль хэдийн шошготой байсан)`);
  if (tally.errors > 0)  summary.push(`⚠️ ${tally.errors} имэйлд алдаа гарлаа`);

  const env = telegramEnvState();
  try {
    await sendTelegramReply({ chatId: env.chatId, text: summary.join("\n") });
    log("telegram summary sent");
  } catch (err) {
    log(`telegram summary failed: ${err?.message || err}`);
  }
}

main().catch(err => {
  log(`gmail-organizer failed: ${err?.message || err}`);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});

module.exports = { classify, LABELS };
