"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const REPO_ROOT = path.resolve(__dirname, "..");
const PRIMARY_PATH = path.join(REPO_ROOT, "data", "leads.json");
const FALLBACK_PATH = path.join(os.tmpdir(), "dalatech-leads.json");

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
  if (primary.leads.length > 0 || primary.counter > 0) {
    return { store: primary, path: PRIMARY_PATH };
  }
  const fallback = readStore(FALLBACK_PATH);
  if (fallback.leads.length > 0 || fallback.counter > 0) {
    return { store: fallback, path: FALLBACK_PATH };
  }
  return { store: primary, path: PRIMARY_PATH };
}

function persist(store, preferredPath) {
  const attempts = [preferredPath, FALLBACK_PATH];
  const seen = new Set();
  for (const p of attempts) {
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      writeStore(p, store);
      return p;
    } catch (err) {
      console.warn(`[leads] write to ${p} failed:`, err?.message || err);
    }
  }
  throw new Error("Unable to persist leads store to any location");
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
  const record = {
    id,
    number: next,
    createdAt: new Date().toISOString(),
    status: "demo",
    finalUrl: null,
    finishedAt: null,
    ...payload
  };
  store.counter = next;
  store.leads.push(record);
  const writtenTo = persist(store, storePath);
  console.log(`[leads] created lead #${id} (stored at ${writtenTo})`);
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
  Object.assign(lead, patch);
  persist(store, storePath);
  return lead;
}

module.exports = {
  createLead,
  getLead,
  updateLead,
  formatId,
  normalizeId,
  PRIMARY_PATH,
  FALLBACK_PATH
};
