"use strict";

// Lead storage backed by Upstash Redis (REST API).
// Vercel's filesystem is read-only on serverless functions, so file-based
// persistence (data/leads.json) fails with EROFS and silently drops leads,
// which breaks Telegram notifications, scheduled emails, and the chatbot
// (the chatbot needs to look the business up by id at runtime).
//
// Key layout:
//   leads:counter  -> integer counter, incremented atomically per new lead
//   leads:{id}     -> JSON string of the lead record
//   leads:index    -> Redis set of all lead ids (string members like "001")
//
// All functions are async; callers await them.

const STATUS = {
  QUEUED: "queued",
  GENERATING: "generating",
  HTML_READY: "html_ready",
  DEPLOYING: "deploying",
  READY: "ready",
  SENT: "sent",
  CHOSEN: "chosen",
  FINISHING: "finishing",
  // Production preview deployed; waiting for Bilguun to APPROVE or CHANGE.
  AWAITING_REVIEW: "awaiting_review",
  // Bilguun sent CHANGE; regenerating production HTML with accumulated
  // feedback. Returns to AWAITING_REVIEW once the new preview ships.
  CHANGING: "changing",
  // Legacy terminal state from the old single-shot finish flow.
  FINISHED: "finished",
  // Bilguun sent APPROVE; site is ready for domain connection.
  APPROVED: "approved",
  FAILED: "failed",
  DEMO: "demo"
};

const COUNTER_KEY = "leads:counter";
const INDEX_KEY = "leads:index";
const leadKey = (id) => `leads:${id}`;

function getDelayHours() {
  const raw = process.env.DEMO_DELAY_HOURS;
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function scheduledSendAtIso(now = new Date()) {
  const ms = getDelayHours() * 60 * 60 * 1000;
  return new Date(now.getTime() + ms).toISOString();
}

function upstashConfig() {
  const url = (process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, "");
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set");
  }
  return { url, token };
}

// Native fetch in Node 18+ does NOT time out by default. The first cut of
// this guard used AbortSignal.timeout(8000), but Vercel's undici fetch
// honored that abort 145s later (not at 8s) — likely a stale keep-alive
// socket the pool re-used. Wrapping fetch in a manual Promise.race against
// an AbortController + setTimeout fires deterministically at the configured
// limit, and `Connection: close` keeps undici from reusing dead sockets
// for the next call.
const UPSTASH_TIMEOUT_MS = Number(process.env.UPSTASH_TIMEOUT_MS) || 6000;

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const e = new Error(`fetch timeout after ${timeoutMs}ms`);
      e.code = "FETCH_TIMEOUT";
      reject(e);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      timeoutPromise
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function redisCommand(args) {
  const { url, token } = upstashConfig();
  const verb = String(args?.[0] || "?");
  const key  = String(args?.[1] || "");
  const started = Date.now();
  console.log(`[leads] upstash -> ${verb} ${key}`);
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Connection": "close"
      },
      body: JSON.stringify(args)
    }, UPSTASH_TIMEOUT_MS);
  } catch (err) {
    const ms = Date.now() - started;
    const reason = err?.code === "FETCH_TIMEOUT"
      ? `timeout after ${ms}ms (limit ${UPSTASH_TIMEOUT_MS}ms)`
      : (err?.message || String(err));
    console.error(`[leads] upstash <- ${verb} ${key} fetch failed: ${reason}`);
    const wrapped = new Error(`Upstash ${verb} failed: ${reason}`);
    wrapped.code = err?.code === "FETCH_TIMEOUT" ? "UPSTASH_TIMEOUT" : "UPSTASH_FETCH_ERROR";
    throw wrapped;
  }
  let body;
  try { body = await res.json(); } catch { body = null; }
  console.log(`[leads] upstash <- ${verb} ${key} status=${res.status} ms=${Date.now() - started}`);
  if (!res.ok || (body && body.error)) {
    const message = body?.error || `Upstash ${verb} failed (${res.status})`;
    throw new Error(message);
  }
  return body?.result;
}

async function redisPipeline(commands) {
  if (!Array.isArray(commands) || commands.length === 0) return [];
  const { url, token } = upstashConfig();
  const verbs = commands.map(c => String(c?.[0] || "?")).join("+");
  const started = Date.now();
  console.log(`[leads] upstash pipeline -> ${verbs} (${commands.length} cmds)`);
  let res;
  try {
    res = await fetchWithTimeout(`${url}/pipeline`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Connection": "close"
      },
      body: JSON.stringify(commands)
    }, UPSTASH_TIMEOUT_MS);
  } catch (err) {
    const ms = Date.now() - started;
    const reason = err?.code === "FETCH_TIMEOUT"
      ? `timeout after ${ms}ms (limit ${UPSTASH_TIMEOUT_MS}ms)`
      : (err?.message || String(err));
    console.error(`[leads] upstash pipeline fetch failed (${verbs}): ${reason}`);
    const wrapped = new Error(`Upstash pipeline failed: ${reason}`);
    wrapped.code = err?.code === "FETCH_TIMEOUT" ? "UPSTASH_TIMEOUT" : "UPSTASH_FETCH_ERROR";
    throw wrapped;
  }
  let body;
  try { body = await res.json(); } catch { body = null; }
  console.log(`[leads] upstash pipeline <- ${verbs} status=${res.status} ms=${Date.now() - started}`);
  if (!res.ok) {
    throw new Error(`Upstash pipeline failed (${res.status})`);
  }
  return body || [];
}

function formatId(n) {
  return String(n).padStart(3, "0");
}

function normalizeId(id) {
  return String(id || "").replace(/^#/, "").trim().padStart(3, "0");
}

function parseLead(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

async function createLead(payload) {
  const nextRaw = await redisCommand(["INCR", COUNTER_KEY]);
  const next = Number(nextRaw);
  if (!Number.isFinite(next) || next < 1) {
    throw new Error("Failed to allocate lead id from Upstash");
  }
  const id = formatId(next);
  const now = new Date();
  const record = {
    previewUrl: null,
    projectName: null,
    generatedAt: null,
    sentAt: null,
    finalUrl: null,
    finishedAt: null,
    lastError: null,
    status: STATUS.QUEUED,
    ...payload,
    id,
    number: next,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    scheduledSendAt: payload?.scheduledSendAt || scheduledSendAtIso(now)
  };
  await redisPipeline([
    ["SET", leadKey(id), JSON.stringify(record)],
    ["SADD", INDEX_KEY, id]
  ]);
  console.log(`[leads] created lead #${id} status=${record.status} scheduledSendAt=${record.scheduledSendAt} (upstash)`);
  return record;
}

async function getLead(id) {
  const normalized = normalizeId(id);
  if (!normalized || normalized === "000") return null;
  const raw = await redisCommand(["GET", leadKey(normalized)]);
  return parseLead(raw);
}

async function updateLead(id, patch) {
  const normalized = normalizeId(id);
  const current = await getLead(normalized);
  if (!current) return null;
  const updated = {
    ...current,
    ...patch,
    id: current.id,
    number: current.number,
    updatedAt: new Date().toISOString()
  };
  await redisCommand(["SET", leadKey(normalized), JSON.stringify(updated)]);
  return updated;
}

async function listLeads(filter) {
  const ids = (await redisCommand(["SMEMBERS", INDEX_KEY])) || [];
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const sortedIds = ids.slice().sort((a, b) => Number(a) - Number(b));
  const raws = (await redisCommand(["MGET", ...sortedIds.map(leadKey)])) || [];
  const leads = raws
    .map(parseLead)
    .filter(Boolean);
  if (typeof filter === "function") return leads.filter(filter);
  return leads;
}

async function findQueuedForGeneration({ limit = 1 } = {}) {
  const leads = await listLeads();
  return leads
    .filter(l => l.status === STATUS.QUEUED)
    .sort((a, b) => Number(a.number) - Number(b.number))
    .slice(0, limit);
}

// Safety net: leads whose staged pipeline got interrupted between stages.
// We treat anything older than 10 minutes in an intermediate state as stuck.
async function findStuckForStage({ limit = 3, now = new Date() } = {}) {
  const STALE_MS = 10 * 60 * 1000;
  const cutoff = now.getTime() - STALE_MS;
  const intermediate = new Set([
    STATUS.GENERATING,
    STATUS.HTML_READY,
    STATUS.DEPLOYING
  ]);
  const leads = await listLeads();
  return leads
    .filter(l => intermediate.has(l.status))
    .filter(l => {
      const ts = Date.parse(l.updatedAt || l.createdAt || "");
      return Number.isFinite(ts) && ts <= cutoff;
    })
    .sort((a, b) => Number(a.number) - Number(b.number))
    .slice(0, limit);
}

// Weekly cleanup sweep: any lead in SENT or CHOSEN status (or APPROVED) that
// is older than `olderThanMs` and still has demo project names recorded but
// not yet deleted. Used by api/cron.js to garbage-collect Vercel preview
// projects that no client will ever revisit.
async function findLeadsForDemoCleanup({
  olderThanMs = 7 * 24 * 60 * 60 * 1000,
  limit = 10,
  now = new Date()
} = {}) {
  const cutoff = now.getTime() - olderThanMs;
  const cleanable = new Set([STATUS.SENT, STATUS.CHOSEN, STATUS.APPROVED]);
  const leads = await listLeads();
  return leads
    .filter(l => cleanable.has(l.status))
    .filter(l => l.demoProjectNames && Object.keys(l.demoProjectNames).length > 0)
    .filter(l => l.demoDeleted !== true)
    .filter(l => {
      const ts = Date.parse(l.createdAt || "");
      return Number.isFinite(ts) && ts <= cutoff;
    })
    .sort((a, b) => Number(a.number) - Number(b.number))
    .slice(0, limit);
}

async function findDueForSend({ limit = 5, now = new Date() } = {}) {
  const cutoff = now.getTime();
  const leads = await listLeads();
  return leads
    .filter(l =>
      l.status === STATUS.READY &&
      l.scheduledSendAt &&
      Date.parse(l.scheduledSendAt) <= cutoff &&
      l.previewUrl
    )
    .sort((a, b) => Date.parse(a.scheduledSendAt) - Date.parse(b.scheduledSendAt))
    .slice(0, limit);
}

module.exports = {
  createLead,
  getLead,
  updateLead,
  listLeads,
  findQueuedForGeneration,
  findStuckForStage,
  findDueForSend,
  findLeadsForDemoCleanup,
  formatId,
  normalizeId,
  scheduledSendAtIso,
  getDelayHours,
  STATUS
};
