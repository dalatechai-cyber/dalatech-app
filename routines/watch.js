"use strict";

// DalaTech production-build watcher.
//
// Runs permanently on Bilguun's local Windows machine via PM2 (see
// routines/README.md for setup). Every POLL_INTERVAL_MS it checks Upstash
// for any lead in `ready_to_finish` and runs the full 6-step build
// pipeline on it with NO time limit:
//
//   STEP 1  PLAN          Sonnet writes a structured content plan.
//   STEP 2  GENERATE      Sonnet writes the full single-file HTML site.
//   STEP 3  SELF REVIEW   Sonnet reviews its own output. PASS or issues.
//   STEP 4  FIX           Regenerate using the issues as a checklist.
//                         Repeat 3+4 up to MAX_REVIEW_ITERATIONS times.
//   STEP 5  DEPLOY        Decorate (chatbot, no chooser bar) + push to
//                         Vercel via lib/deploy.js. Store URL on the lead.
//   STEP 6  NOTIFY        Telegram reply with the URL, which iteration
//                         passed review, total wall-clock time, and
//                         APPROVE / CHANGE instructions.
//
// State transitions performed here:
//   ready_to_finish -> (initial)  finishing -> awaiting_review
//   ready_to_finish -> (change)   changing  -> awaiting_review
//   ready_to_finish -> failed (initial only — change failures roll back to
//                              awaiting_review so the prior preview stays)
//
// The watcher reads ALL config (Upstash, Telegram, Anthropic, Vercel,
// Resend) from .env.local at the project root.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env.local") });

const Anthropic = require("@anthropic-ai/sdk");

const { listLeads, getLead, updateLead, STATUS } = require("../lib/leads");
const { generateHtml, decorateHtml } = require("../lib/pipeline");
const { deployToVercel } = require("../lib/deploy");
const { sendTelegramReply, envState: telegramEnvState } = require("../lib/telegram");

const POLL_INTERVAL_MS = Number(process.env.WATCH_POLL_MS) || 60_000;
const MAX_REVIEW_ITERATIONS = 3;
const PLAN_TIMEOUT_MS = 4 * 60 * 1000;
const REVIEW_TIMEOUT_MS = 6 * 60 * 1000;

function ts() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(`[watch ${ts()}]`, ...args);
}

function logHeader(line) {
  const bar = "─".repeat(Math.max(0, 78 - line.length - 2));
  console.log(`\n[watch ${ts()}] ── ${line} ${bar}`);
}

function formatDurationMs(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}мин ${s}с` : `${s}с`;
}

// ---------------------------------------------------------------------------
// Anthropic helpers
// ---------------------------------------------------------------------------

function anthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in .env.local");
  return new Anthropic({ apiKey });
}

async function callSonnet({ system, user, maxTokens, timeoutMs, label }) {
  const client = anthropicClient();
  const started = Date.now();
  log(`anthropic call -> ${label} maxTokens=${maxTokens} timeoutMs=${timeoutMs}`);
  const message = await client.messages.create(
    {
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }]
    },
    { timeout: timeoutMs }
  );
  const text = (message.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
  log(`anthropic call <- ${label} stop=${message.stop_reason} chars=${text.length} ms=${Date.now() - started}`);
  if (message.stop_reason === "max_tokens") {
    log(`WARNING: ${label} hit max_tokens, output may be truncated.`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Brief construction
// ---------------------------------------------------------------------------

function describeLead(lead) {
  const sections = Array.isArray(lead.sections) ? lead.sections.join(", ") : "(none)";
  return [
    `Business name: ${lead.businessName || "—"}`,
    `Industry: ${lead.industry || "—"}`,
    `Description: ${lead.description || "—"}`,
    `Services / products: ${lead.services || "—"}`,
    `Primary brand color: ${lead.primaryColor || "—"}`,
    `Secondary brand color: ${lead.secondaryColor || "—"}`,
    `Selected visual style: ${lead.style || "—"}`,
    `Requested sections: ${sections}`,
    `Reference sites client likes: ${lead.references || "—"}`,
    `Primary contact phone: ${lead.phone || "—"}`,
    `Primary contact email: ${lead.email || "—"}`,
    `Client contact name: ${lead.fullName || "—"}`
  ].join("\n");
}

function describeExtras(lead) {
  const extras = lead.extras || {};
  const notes = (extras.notes || extras.raw || "").trim();
  const photos = Array.isArray(extras.photos) ? extras.photos : [];
  const history = Array.isArray(lead.changeHistory) ? lead.changeHistory : [];
  const blocks = [];
  if (notes) {
    blocks.push(["### Bilguun's on-site notes (real client info)", notes].join("\n"));
  }
  if (photos.length > 0) {
    blocks.push([
      "### Photo URLs supplied by the client",
      photos.map((u, i) => `${i + 1}. ${u}`).join("\n")
    ].join("\n"));
  }
  if (history.length > 0) {
    const rendered = history.map((h, i) => {
      const at = h?.at ? ` (${h.at})` : "";
      return `Revision ${i + 1}${at}: ${(h?.request || "").trim()}`;
    }).join("\n\n");
    blocks.push(["### Accumulated revision requests (newest last)", rendered].join("\n"));
  }
  return blocks.join("\n\n");
}

// Build the brief object that lib/pipeline.generateHtml expects. The plan
// and any prior review feedback are injected into extras.notes so the
// existing prompt builder (lib/prompt.js) treats them as highest-priority
// client information without needing a schema change.
function buildBrief({ lead, plan, reviewFeedback }) {
  const extras = lead.extras || null;
  const photos = Array.isArray(extras?.photos) ? extras.photos.slice() : [];
  const baseNotes = (extras?.notes || extras?.raw || "").trim();

  const noteParts = [];
  if (baseNotes) noteParts.push(baseNotes);
  if (plan && plan.trim()) {
    noteParts.push(
      "---",
      "## STRUCTURED CONTENT PLAN (follow this plan strictly)",
      plan.trim()
    );
  }
  if (reviewFeedback && reviewFeedback.trim()) {
    noteParts.push(
      "---",
      "## INTERNAL REVIEW FINDINGS — FIX EVERY ITEM IN THIS BUILD",
      "The previous iteration of this HTML was rejected by an internal review for the issues below. Fix each one in this rewrite. Do not introduce new violations.",
      "",
      reviewFeedback.trim()
    );
  }

  const mergedExtras = {
    ...(extras || {}),
    notes: noteParts.join("\n\n"),
    raw: baseNotes,
    photos
  };

  return {
    businessName: lead.businessName,
    industry: lead.industry,
    description: lead.description,
    services: lead.services,
    primaryColor: lead.primaryColor,
    secondaryColor: lead.secondaryColor,
    style: lead.style,
    references: lead.references,
    sections: lead.sections,
    fullName: lead.fullName,
    email: lead.email,
    phone: lead.phone,
    logo: null,
    quality: "production",
    extras: mergedExtras,
    photoUrls: photos,
    changeHistory: Array.isArray(lead.changeHistory) ? lead.changeHistory : []
  };
}

// ---------------------------------------------------------------------------
// STEP 1 — PLAN
// ---------------------------------------------------------------------------

const PLAN_SYSTEM = [
  "You are a senior design engineer + copywriter planning a single-file production website for a real Mongolian small business.",
  "Apply the impeccable design philosophy (committed color strategy, deliberate motion, no AI slop, no SVG, no mailto) and Emil Kowalski's design engineering laws (transform/opacity only, custom easing, asymmetric enter/exit timing).",
  "Your output is a structured plan ONLY. Do not write HTML, CSS, or JavaScript. The next step turns this plan into HTML.",
  "Be specific, opinionated, and committed. Every section needs a concrete reason to exist."
].join("\n");

function planUserPrompt(lead) {
  return [
    "## Client brief",
    describeLead(lead),
    "",
    "## Extras gathered by Bilguun (real client info, source of truth)",
    describeExtras(lead) || "(none — work from the brief above)",
    "",
    "## Plan format (use these exact headings)",
    "",
    "### 1. Section list",
    "Ordered list of sections (Hero first). For each: a one-sentence summary of what it says, and why it earns its place. Aim for 6–9 sections. No filler.",
    "",
    "### 2. Copy strategy",
    "Tone, voice, what to emphasize, what to avoid. Concrete examples of phrases that match the brand. Mongolian Cyrillic.",
    "",
    "### 3. Color strategy",
    "Pick one strategy from Committed / Drenched / Full palette. State where the brand primary appears in each section (hero, accent borders, hovers, etc.). Reject Restrained for this build.",
    "",
    "### 4. Hero treatment",
    "Describe exactly what the visitor sees in the first second. Layout, headline phrasing, ambient CSS motion (no SVG), how the brand color carries the surface.",
    "",
    "### 5. Typography hierarchy",
    "Scale ratios, weight contrasts, where italics or display weight are used sparingly. Reference the requested style register.",
    "",
    "### 6. Motion plan",
    "Which sections animate, the easing curve, the timing. Stagger ranges. Hover/active feedback expectations.",
    "",
    "### 7. Photo distribution",
    "If the client supplied photo URLs, list which section each photo lands in, with the alt text in Mongolian.",
    "",
    "### 8. Concrete copy notes",
    "Specific phrasing, plausible tugrik prices, real names, address, hours, social handles. Anything Bilguun mentioned in the extras must be woven in here."
  ].join("\n");
}

async function runPlanStep(lead) {
  logHeader(`#${lead.id} STEP 1/6 — PLAN`);
  const plan = await callSonnet({
    system: PLAN_SYSTEM,
    user: planUserPrompt(lead),
    maxTokens: 4000,
    timeoutMs: PLAN_TIMEOUT_MS,
    label: `plan-#${lead.id}`
  });
  if (!plan.trim()) throw new Error("Sonnet returned an empty plan");
  console.log("\n--- PLAN ---\n" + plan.trim() + "\n--- END PLAN ---\n");
  return plan.trim();
}

// ---------------------------------------------------------------------------
// STEP 2 — GENERATE
// ---------------------------------------------------------------------------

async function runGenerateStep({ lead, plan, reviewFeedback, attempt }) {
  logHeader(`#${lead.id} STEP 2/6 — GENERATE (attempt ${attempt})`);
  const brief = buildBrief({ lead, plan, reviewFeedback });
  const html = await generateHtml(brief);
  log(`#${lead.id} generated HTML length=${html.length}`);
  return { html, brief };
}

// ---------------------------------------------------------------------------
// STEP 3 — SELF REVIEW
// ---------------------------------------------------------------------------

const REVIEW_SYSTEM = [
  "You are a senior design engineer doing an adversarial review of a single-file production website. Be ruthless.",
  "Apply EVERY impeccable absolute ban and EVERY Emil Kowalski motion law. The site must feel alive, brand-committed, and crafted — not like AI slop.",
  "",
  "Check (non-exhaustive):",
  "- Any inline <svg> tag, <path>, <polyline>, <polygon>, <circle>, <rect>, <line>, <g>, <ellipse>, or data:image/svg+xml URI. Forbidden, total ban.",
  "- Any mailto: link or any <form action> that points to email. Forbidden.",
  "- Any working <form> with a non-empty action attribute (other than action=\"#\"). Forbidden.",
  "- Side-stripe borders (border-left/right >1px as a colored accent on cards, list items, callouts).",
  "- Gradient text (background-clip: text combined with a gradient).",
  "- Decorative glassmorphism used as a default (backdrop-filter blur everywhere).",
  "- The hero-metric SaaS cliché (big number, small label, supporting stats, gradient accent).",
  "- Identical card grids with no variation.",
  "- Nested cards.",
  "- transition: all anywhere.",
  "- ease-in or bouncy/elastic easing on UI animations.",
  "- Animation entering from scale(0). Must be scale(0.95) + opacity 0 minimum.",
  "- Buttons missing transform: scale(0.97) on :active.",
  "- Cards missing hover-lift translateY(-2px) + stronger shadow + accent border.",
  "- Pure #000 or #fff anywhere.",
  "- Em dashes (—) or double-hyphens (--) in visible Mongolian copy. CSS custom properties using -- are fine.",
  "- Lorem ipsum, [bracket placeholders], 'Coming soon', generic SaaS phrasing, restated headings.",
  "- Brand primary failing to carry roughly 35%+ of the visible surface (Committed strategy).",
  "- Hero without ambient CSS motion in the first second.",
  "- Missing IntersectionObserver scroll reveals on every section + missing stagger via --i.",
  "- Observer NOT wrapped in try/catch with a DOMContentLoaded fallback that adds is-in to all [data-reveal].",
  "- Anchors in the header without matching section ids (clicking them does nothing).",
  "- JavaScript syntax errors, or any unclosed <script>, <style>, <body>, or <html> tag.",
  "- Missing scroll-margin-top on sections (sticky header overlaps anchored content).",
  "- Photo URLs provided by the client that are not used as real <img> tags in the document.",
  "- Fewer than 6 distinct content-rich sections beyond Hero.",
  "- Sections with less than ~80 words of substantive Mongolian copy.",
  "- Missing or weak FAQ (need 5–8 real client-style questions).",
  "- Missing or weak About (need a magazine-style founding story).",
  "- Missing pricing/services tiers — production needs at least 3 with concrete tugrik prices.",
  "- Buttons with href=\"#\" that don't scroll to a real section.",
  "- Inline style attributes mixed with CSS classes for non-dynamic styling.",
  "- Copy that reads like generic AI (hedging, vague, restated headings, buzzwords without specifics).",
  "",
  "OUTPUT FORMAT — STRICT:",
  "- If you find ZERO issues, output exactly: PASS",
  "- Otherwise output a numbered list. Each item: which section, what is wrong, exactly what to do instead.",
  "- Do NOT output anything else. No preamble. No commentary. No congratulations."
].join("\n");

function reviewUserPrompt(lead, html) {
  return [
    `Business: ${lead.businessName} (${lead.industry || "unknown"}).`,
    `Style register: ${lead.style || "—"}.`,
    `Brand primary: ${lead.primaryColor || "—"}, secondary: ${lead.secondaryColor || "—"}.`,
    "",
    "Review the following HTML and report every flaw you find. If clean, output the single word PASS.",
    "",
    "--- BEGIN HTML ---",
    html,
    "--- END HTML ---"
  ].join("\n");
}

async function runSelfReviewStep({ lead, html, attempt }) {
  logHeader(`#${lead.id} STEP 3/6 — SELF REVIEW (after attempt ${attempt})`);
  const text = await callSonnet({
    system: REVIEW_SYSTEM,
    user: reviewUserPrompt(lead, html),
    maxTokens: 6000,
    timeoutMs: REVIEW_TIMEOUT_MS,
    label: `review-#${lead.id}-iter${attempt}`
  });
  const trimmed = (text || "").trim();
  const passed = /^PASS\s*$/i.test(trimmed);
  if (passed) {
    log(`#${lead.id} review PASS on attempt ${attempt}`);
  } else {
    log(`#${lead.id} review FOUND ISSUES on attempt ${attempt} (${trimmed.length} chars)`);
    console.log("\n--- REVIEW FINDINGS ---\n" + trimmed + "\n--- END FINDINGS ---\n");
  }
  return { passed, feedback: passed ? "" : trimmed };
}

// ---------------------------------------------------------------------------
// STEP 5 — DEPLOY
// ---------------------------------------------------------------------------

async function runDeployStep({ lead, brief, html, iteration }) {
  logHeader(`#${lead.id} STEP 5/6 — DEPLOY`);
  // Production sites get the chatbot widget but NOT the chooser bar
  // (that nag belongs on the 3 demo variants only).
  const decorated = decorateHtml(html, {
    brief,
    leadId: lead.id,
    designNumber: 1,
    skipChooser: true
  });
  const projectLabel = iteration > 1
    ? `${lead.businessName} prod v${iteration}`
    : `${lead.businessName} prod`;
  log(`#${lead.id} deploying to Vercel as "${projectLabel}" (decorated=${decorated.length} chars)`);
  const deployment = await deployToVercel({ projectName: projectLabel, html: decorated });
  log(`#${lead.id} deployed → ${deployment.url}`);
  return deployment;
}

// ---------------------------------------------------------------------------
// STEP 6 — NOTIFY
// ---------------------------------------------------------------------------

async function notifyBilguun(lead, text) {
  const env = telegramEnvState();
  if (!env.hasToken || !env.hasChatId) {
    log(`#${lead.id} notify skipped: token=${env.hasToken} chatId=${env.hasChatId}`);
    return;
  }
  try {
    await sendTelegramReply({
      chatId: env.chatId,
      text,
      replyToMessageId: lead?.lastUserMessageId || null
    });
  } catch (err) {
    log(`#${lead.id} notify failed: ${err?.message || err}`);
  }
}

function buildSuccessNotification({ lead, deployment, iteration, passedOnAttempt, elapsedMs, hitCeiling }) {
  const lines = [
    `✅ #${lead.id} (${lead.businessName}) урьдчилсан хувилбар бэлэн боллоо.`,
    "",
    `🌐 ${deployment.url}`,
    ""
  ];
  if (iteration > 1) {
    lines.push(`🔁 Засвар №${iteration}`);
  }
  if (hitCeiling) {
    lines.push(`🧪 Чанарын шалгалт: ${MAX_REVIEW_ITERATIONS}/${MAX_REVIEW_ITERATIONS} давталт ашигласан, сүүлчийн хувилбараар явуулав.`);
  } else {
    lines.push(`🧪 Чанарын шалгалт: ${passedOnAttempt}/${MAX_REVIEW_ITERATIONS}-р давталтаар тэнцлээ.`);
  }
  lines.push(`⏱ Бүтэх хугацаа: ${formatDurationMs(elapsedMs)}`);
  lines.push(
    "",
    "Дараагийн алхам:",
    "",
    `   ✅ APPROVE #${lead.id}`,
    "      Сайт бэлэн, домэйн холболт эхлэх.",
    "",
    `   ✏️ CHANGE #${lead.id} [юу засах вэ]`,
    `      Жишээ: CHANGE #${lead.id} hero-г илүү тод болго, FAQ хэсгийг хас.`,
    "      Хэдэн ч удаа явуулж болно. Засвар бүрд өмнөх бүх засварууд хэвээр үлдэнэ."
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main build orchestration
// ---------------------------------------------------------------------------

async function runBuildForLead(lead) {
  const buildStarted = Date.now();
  const iteration = Math.max(1, Number(lead.productionIteration) || 1);
  const isInitial = iteration === 1;

  logHeader(`#${lead.id} BUILD START iteration=${iteration} business="${lead.businessName}"`);

  // Claim the lead immediately so a second watcher loop tick can't pick it
  // up. The status flip from READY_TO_FINISH -> FINISHING/CHANGING is the
  // single-owner gate. Also bumps updatedAt so the staleness window starts
  // from the moment we began work.
  await updateLead(lead.id, {
    status: isInitial ? STATUS.FINISHING : STATUS.CHANGING,
    finishingStartedAt: lead.finishingStartedAt || new Date().toISOString(),
    lastError: null
  });

  // STEP 1 — PLAN
  let plan;
  try {
    plan = await runPlanStep(lead);
  } catch (err) {
    await handleBuildFailure({ lead, iteration, stage: "plan", err, buildStarted });
    return;
  }

  // STEPS 2 — 4 — GENERATE + SELF REVIEW loop
  let html = null;
  let brief = null;
  let passedOnAttempt = null;
  let lastReviewFeedback = null;
  let hitCeiling = false;

  for (let attempt = 1; attempt <= MAX_REVIEW_ITERATIONS; attempt++) {
    try {
      const out = await runGenerateStep({ lead, plan, reviewFeedback: lastReviewFeedback, attempt });
      html = out.html;
      brief = out.brief;
    } catch (err) {
      await handleBuildFailure({ lead, iteration, stage: `generate#${attempt}`, err, buildStarted });
      return;
    }

    let review;
    try {
      review = await runSelfReviewStep({ lead, html, attempt });
    } catch (err) {
      // A reviewer failure is not fatal: ship the current HTML and log it.
      log(`#${lead.id} review threw on attempt ${attempt}, shipping current HTML: ${err?.message || err}`);
      passedOnAttempt = attempt;
      break;
    }

    if (review.passed) {
      passedOnAttempt = attempt;
      break;
    }

    lastReviewFeedback = review.feedback;

    if (attempt < MAX_REVIEW_ITERATIONS) {
      logHeader(`#${lead.id} STEP 4/6 — FIX (regenerating for attempt ${attempt + 1})`);
    } else {
      hitCeiling = true;
      passedOnAttempt = MAX_REVIEW_ITERATIONS;
      log(`#${lead.id} reached MAX_REVIEW_ITERATIONS=${MAX_REVIEW_ITERATIONS}, shipping latest HTML`);
    }
  }

  if (!html || !brief) {
    await handleBuildFailure({
      lead,
      iteration,
      stage: "generate-loop",
      err: new Error("no HTML produced after generate/review loop"),
      buildStarted
    });
    return;
  }

  // STEP 5 — DEPLOY
  let deployment;
  try {
    deployment = await runDeployStep({ lead, brief, html, iteration });
  } catch (err) {
    await handleBuildFailure({ lead, iteration, stage: "deploy", err, buildStarted });
    return;
  }

  // Persist the result. Update changeHistory entry (the in-flight one is
  // the last item appended by the CHANGE webhook).
  const now = new Date().toISOString();
  const previewUrls = isInitial
    ? [deployment.url]
    : [...(Array.isArray(lead.productionUrls) ? lead.productionUrls : []), deployment.url];

  let completedHistory = Array.isArray(lead.changeHistory) ? lead.changeHistory.slice() : [];
  if (!isInitial && completedHistory.length > 0) {
    completedHistory[completedHistory.length - 1] = {
      ...completedHistory[completedHistory.length - 1],
      previewUrl: deployment.url,
      projectName: deployment.projectName,
      completedAt: now
    };
  }

  await updateLead(lead.id, {
    status: STATUS.AWAITING_REVIEW,
    productionUrl: deployment.url,
    productionUrls: previewUrls,
    productionProjectName: deployment.projectName,
    productionIteration: iteration,
    finalUrl: deployment.url,
    finalProjectName: deployment.projectName,
    finishedAt: now,
    changeHistory: completedHistory,
    lastError: null
  });

  // STEP 6 — NOTIFY
  logHeader(`#${lead.id} STEP 6/6 — NOTIFY`);
  const elapsedMs = Date.now() - buildStarted;
  const refreshed = (await getLead(lead.id)) || lead;
  const message = buildSuccessNotification({
    lead: refreshed,
    deployment,
    iteration,
    passedOnAttempt,
    elapsedMs,
    hitCeiling
  });
  await notifyBilguun(refreshed, message);
  log(`#${lead.id} BUILD COMPLETE elapsed=${formatDurationMs(elapsedMs)} url=${deployment.url}`);
}

async function handleBuildFailure({ lead, iteration, stage, err, buildStarted }) {
  const isInitial = iteration === 1;
  const reason = err?.message || String(err);
  const elapsed = formatDurationMs(Date.now() - buildStarted);
  log(`#${lead.id} ${stage} FAILED after ${elapsed}: ${reason}`);
  // Initial build failures fall to FAILED (no prior preview to keep).
  // CHANGE failures roll the lead back to AWAITING_REVIEW so the previous
  // good URL stays the active preview.
  try {
    await updateLead(lead.id, {
      status: isInitial ? STATUS.FAILED : STATUS.AWAITING_REVIEW,
      lastError: `${stage}: ${reason}`
    });
  } catch (saveErr) {
    log(`#${lead.id} updateLead during failure handling threw: ${saveErr?.message || saveErr}`);
  }
  const text = isInitial
    ? `❌ #${lead.id} барих явцад алдаа гарлаа (${stage}, ${elapsed}): ${reason}`
    : `❌ #${lead.id} засвар амжилтгүй боллоо (${stage}, ${elapsed}): ${reason}\nӨмнөх хувилбар хэвээр байна: ${lead.productionUrl || "—"}`;
  await notifyBilguun(lead, text);
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

let pollInFlight = false;

async function pollOnce() {
  if (pollInFlight) return; // overlap guard
  pollInFlight = true;
  try {
    let leads;
    try {
      leads = await listLeads();
    } catch (err) {
      log(`listLeads failed: ${err?.message || err}`);
      return;
    }
    const targets = leads
      .filter(l => l && l.status === STATUS.READY_TO_FINISH)
      .sort((a, b) => Number(a.number) - Number(b.number));

    if (targets.length === 0) return;
    log(`found ${targets.length} ready_to_finish lead(s): ${targets.map(l => `#${l.id}`).join(", ")}`);

    for (const candidate of targets) {
      // Re-read just before claiming so a manual status change between
      // listLeads and now is honored.
      const fresh = await getLead(candidate.id).catch(err => {
        log(`#${candidate.id} getLead refresh failed: ${err?.message || err}`);
        return null;
      });
      if (!fresh) continue;
      if (fresh.status !== STATUS.READY_TO_FINISH) {
        log(`#${fresh.id} no longer ready_to_finish (now ${fresh.status}); skipping`);
        continue;
      }
      try {
        await runBuildForLead(fresh);
      } catch (err) {
        log(`#${fresh.id} unexpected build error: ${err?.message || err}`);
        if (err?.stack) console.error(err.stack);
        // Never leave a lead pinned in FINISHING/CHANGING because of an
        // uncaught throw — fall it to FAILED so the next CHANGE can recover.
        try {
          await updateLead(fresh.id, {
            status: STATUS.FAILED,
            lastError: `unexpected: ${err?.message || String(err)}`
          });
        } catch (saveErr) {
          log(`#${fresh.id} fallback FAILED write threw: ${saveErr?.message || saveErr}`);
        }
        await notifyBilguun(fresh, `❌ #${fresh.id} барих явцад санаандгүй алдаа: ${err?.message || err}`);
      }
    }
  } finally {
    pollInFlight = false;
  }
}

async function main() {
  const requiredEnv = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "ANTHROPIC_API_KEY", "VERCEL_TOKEN"];
  const missing = requiredEnv.filter(k => !process.env[k] || !String(process.env[k]).trim());
  if (missing.length > 0) {
    log(`FATAL: missing env vars: ${missing.join(", ")}. Make sure .env.local has them.`);
    process.exit(1);
  }
  const telegramEnv = telegramEnvState();
  log(`watcher starting. poll=${POLL_INTERVAL_MS}ms model=claude-sonnet-4-6 maxReviewIters=${MAX_REVIEW_ITERATIONS}`);
  log(`telegram token=${telegramEnv.tokenPreview} chat=${telegramEnv.chatIdPreview}`);

  // First poll runs immediately so a freshly-queued lead doesn't have to
  // wait the full interval on startup.
  await pollOnce().catch(err => log(`first pollOnce threw: ${err?.message || err}`));

  setInterval(() => {
    pollOnce().catch(err => log(`pollOnce threw: ${err?.message || err}`));
  }, POLL_INTERVAL_MS);
}

// Surface async errors so PM2 restarts cleanly instead of hanging silent.
process.on("unhandledRejection", (reason) => {
  log(`unhandledRejection: ${reason?.message || reason}`);
  if (reason?.stack) console.error(reason.stack);
});
process.on("uncaughtException", (err) => {
  log(`uncaughtException: ${err?.message || err}`);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});

main().catch(err => {
  log(`main() threw: ${err?.message || err}`);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
