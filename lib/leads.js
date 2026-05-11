"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const REPO_ROOT = path.resolve(__dirname, "..");
const PRIMARY_PATH = path.join(REPO_ROOT, "data", "leads.json");
const FALLBACK_PATH = path.join(os.tmpdir(), "dalatech-leads.json");

const STATUS = {
  QUEUED: "queued",
  READY: "ready",
  SENT: "sent",
  FINISHING: "finishing",
  FINISHED: "finished",
  FAILED: "failed",
  DEMO: "demo"
};

const SCHEDULED_DELAY_MS = 24 * 60 * 60 * 1000;

function readStore(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && Array.isArray(data.leads)) {
      return { counter: Number(data.counter) || data.leads.length, leads: data.leads };
    }
  } catch (_) {}
  return { counter: 0, leads: [] };
}

function writeStore(filePath, store) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf8");
}

function loadStore() {
  const primary = readStore(PRIMARY_PATH);
  const fallback = readStore(FALLBACK_PATH);

  if (primary.leads.length === 0 && fallback.leads.length > 0) {
    return { store: fallback, path: FALLBACK_PATH };
  }
  if (fallback.leads.length === 0) {
    return { store: primary, path: PRIMARY_PATH };
  }

  const byId = new Map();
  for (const lead of primary.leads) byId.set(lead.id, lead);
  for (const lead of fallback.leads) {
    const existing = byId.get(lead.id);
    if (!existing) {
      byId.set(lead.id, lead);
    } else {
      const aT = Date.parse(lead.updatedAt || lead.createdAt || 0) || 0;
      const bT = Date.parse(existing.updatedAt || existing.createdAt || 0) || 0;
      if (aT > bT) byId.set(lead.id, lead);
    }
  }
  const merged = Array.from(byId.values()).sort((a, b) => Number(a.number) - Number(b.number));
  const counter = Math.max(primary.counter || 0, fallback.counter || 0, merged.length);
  return { store: { counter, leads: merged }, path: PRIMARY_PATH };
}

function persist(store, preferredPath) {
  const attempts = [preferredPath, FALLBACK_PATH];
  const seen = new Set();
  let lastError;
  for (const p of attempts) {
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      writeStore(p, store);
      return p;
    } catch (err) {
      lastError = err;
      console.warn(`[leads] write to ${p} failed:`, err?.message || err);
    }
  }
  throw new Error(`Unable to persist leads store: ${lastError?.message || "unknown"}`);
}

function formatId(n) {
  return String(n).padStart(3, "0");
}

function normalizeId(id) {
  return String(id || "").replace(/^#/, "").trim().padStart(3, "0");
}

function createLead(payload) {
  const { store, path: storePath } = loadStore();
  const next = (Number(store.counter) || 0) + 1;
  const id = formatId(next);
  const now = new Date();
  const record = {
    id,
    number: next,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: payload.status || STATUS.QUEUED,
    scheduledSendAt: payload.scheduledSendAt || new Date(now.getTime() + SCHEDULED_DELAY_MS).toISOString(),
    previewUrl: null,
    projectName: null,
    generatedAt: null,
    sentAt: null,
    finalUrl: null,
    finishedAt: null,
    lastError: null,
    ...payload
  };
  store.counter = next;
  store.leads.push(record);
  const writtenTo = persist(store, storePath);
  console.log(`[leads] created lead #${id} status=${record.status} scheduledSendAt=${record.scheduledSendAt} (stored at ${writtenTo})`);
  return record;
}

function getLead(id) {
  const normalized = normalizeId(id);
  const { store } = loadStore();
  return store.leads.find(l => l.id === normalized) || null;
}

function updateLead(id, patch) {
  const normalized = normalizeId(id);
  const { store, path: storePath } = loadStore();
  const lead = store.leads.find(l => l.id === normalized);
  if (!lead) return null;
  Object.assign(lead, patch, { updatedAt: new Date().toISOString() });
  persist(store, storePath);
  return lead;
}

function listLeads(filter) {
  const { store } = loadStore();
  if (typeof filter === "function") return store.leads.filter(filter);
  return store.leads.slice();
}

function findQueuedForGeneration({ limit = 1 } = {}) {
  const { store } = loadStore();
  return store.leads
    .filter(l => l.status === STATUS.QUEUED)
    .sort((a, b) => Number(a.number) - Number(b.number))
    .slice(0, limit);
}

function findDueForSend({ limit = 5, now = new Date() } = {}) {
  const cutoff = now.getTime();
  const { store } = loadStore();
  return store.leads
    .filter(l => l.status === STATUS.READY && l.scheduledSendAt && Date.parse(l.scheduledSendAt) <= cutoff && l.previewUrl)
    .sort((a, b) => Date.parse(a.scheduledSendAt) - Date.parse(b.scheduledSendAt))
    .slice(0, limit);
}

module.exports = {
  createLead,
  getLead,
  updateLead,
  listLeads,
  findQueuedForGeneration,
  findDueForSend,
  formatId,
  normalizeId,
  STATUS,
  SCHEDULED_DELAY_MS,
  PRIMARY_PATH,
  FALLBACK_PATH
};
