"use strict";

// POST /api/choice
// Called by the sticky chooser bar embedded in every generated demo when a
// visitor picks one of the three variants. Responsibilities:
//   1. Validate the payload and look the lead up in Upstash.
//   2. Persist the chosen design number on the lead record, flip status to
//      "chosen" (idempotent: re-submissions for the same design no-op).
//   3. Send a Telegram alert to Bilguun so we can follow up within 24 hours.
//
// CORS is permissive because the chooser bar runs on per-deploy
// *.vercel.app hostnames while this API lives at app.dalatech.online.

const { getLead, updateLead, STATUS, normalizeId } = require("../lib/leads");
const { sendDesignChoiceNotification } = require("../lib/telegram");

const ALLOWED_DESIGNS = [1, 2, 3];

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Cache-Control", "no-store");
}

function bad(res, status, message) {
  applyCors(res);
  res.status(status).json({ ok: false, error: message });
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 32 * 1024) { req.destroy(); reject(new Error("payload too large")); }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

async function handler(req, res) {
  if (req.method === "OPTIONS") {
    applyCors(res);
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    applyCors(res);
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  let body;
  try { body = await readJsonBody(req); }
  catch { return bad(res, 400, "Invalid JSON body"); }

  const leadIdRaw = String(body.leadId || "").trim();
  const designNumber = Number(body.designNumber);

  if (!leadIdRaw) return bad(res, 400, "leadId is required");
  if (!ALLOWED_DESIGNS.includes(designNumber)) return bad(res, 400, "designNumber must be 1, 2 or 3");

  const leadId = normalizeId(leadIdRaw);
  let lead;
  try {
    lead = await getLead(leadId);
  } catch (err) {
    console.error(`[choice] lead lookup failed leadId=#${leadId}:`, err?.message || err);
    return bad(res, 502, "Lead store unavailable");
  }
  if (!lead) return bad(res, 404, "Lead not found");

  // Idempotent re-submission: same lead + same design + already chosen →
  // 200 ok, no duplicate Telegram message. We still allow switching
  // designs by writing a new chosenDesign value.
  if (lead.status === STATUS.CHOSEN && Number(lead.chosenDesign) === designNumber) {
    console.log(`[choice] lead=#${leadId} already chose design=${designNumber}, returning 200`);
    applyCors(res);
    return res.status(200).json({ ok: true, alreadyChosen: true });
  }

  const now = new Date().toISOString();
  try {
    await updateLead(leadId, {
      status: STATUS.CHOSEN,
      chosenDesign: designNumber,
      chosenAt: now,
      lastError: null
    });
  } catch (err) {
    console.error(`[choice] persist failed leadId=#${leadId}:`, err?.message || err);
    return bad(res, 502, "Could not save your choice. Please try again.");
  }

  console.log(`[choice] recorded leadId=#${leadId} design=${designNumber}`);

  // Send the Telegram notification BEFORE responding so the function does
  // not freeze mid-fetch (the same fire-and-forget bug we just fixed in
  // api/generate.js). The call is fast (~1s) and the function has a 30s
  // budget. allSettled-equivalent error handling: Telegram failure does
  // NOT roll back the persisted choice; we log and continue.
  try {
    await sendDesignChoiceNotification({
      leadId,
      designNumber,
      businessName: lead.businessName,
      fullName: lead.fullName,
      phone: lead.phone,
      email: lead.email
    });
    console.log(`[choice] telegram notify ok leadId=#${leadId} design=${designNumber}`);
  } catch (err) {
    console.error(`[choice] telegram notify failed leadId=#${leadId} design=${designNumber}:`, err?.message || err);
  }

  applyCors(res);
  return res.status(200).json({ ok: true, designNumber, leadId });
}

module.exports = handler;
module.exports.default = handler;
module.exports.config = {
  api: {
    bodyParser: { sizeLimit: "32kb" }
  }
};
