"use strict";

// DalaTech production-build watcher.
//
// Runs permanently on Bilguun's local Windows machine via PM2 (see
// routines/README.md for setup). Every POLL_INTERVAL_MS it checks Upstash
// for any lead in `ready_to_finish` and runs the full build pipeline on it
// with NO time limit:
//
//   STEP 0  RESEARCH      Opus + web_search finds 3 premium global sites,
//                         Mongolia/Asia examples, and reads dalatech.online
//                         as the quality bar. Findings feed every later step.
//   STEP 1  PLAN          Opus writes a structured content plan.
//   STEP 2  GENERATE      Opus writes the full single-file HTML site.
//   STEP 3  SELF REVIEW   Opus reviews its own output, naming impeccable
//                         and Emil violations explicitly. PASS or issues.
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
//
// Model strategy: production builds (this watcher) run on Opus. Demos in
// lib/pipeline.js stay on Sonnet — the contracts diverge on purpose. Only
// the final-paid path is allowed to spend Opus tokens.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env.local") });

const Anthropic = require("@anthropic-ai/sdk");

const { listLeads, getLead, updateLead, STATUS } = require("../lib/leads");
const { generateHtml, decorateHtml } = require("../lib/pipeline");
const { deployToVercel } = require("../lib/deploy");
const { sendTelegramReply, envState: telegramEnvState } = require("../lib/telegram");

const MODEL = "claude-opus-4-6";
const POLL_INTERVAL_MS = Number(process.env.WATCH_POLL_MS) || 60_000;
const MAX_REVIEW_ITERATIONS = 3;
const RESEARCH_TIMEOUT_MS = 6 * 60 * 1000;
const PLAN_TIMEOUT_MS = 5 * 60 * 1000;
const GENERATE_TIMEOUT_MS = 14 * 60 * 1000;
const REVIEW_TIMEOUT_MS = 8 * 60 * 1000;

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

// Single call to Claude with optional server-side tools (e.g. web_search).
async function callClaude({ system, user, maxTokens, timeoutMs, label, tools }) {
  const client = anthropicClient();
  const started = Date.now();
  const hasTools = Array.isArray(tools) && tools.length > 0;
  log(`anthropic call -> ${label} model=${MODEL} maxTokens=${maxTokens} timeoutMs=${timeoutMs} tools=${hasTools ? tools.map(t => t.type).join(",") : "none"}`);

  const request = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }]
  };
  if (hasTools) request.tools = tools;

  const message = await client.messages.create(request, { timeout: timeoutMs });

  const text = (message.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");

  const toolUseCount = (message.content || []).filter(b =>
    b.type === "tool_use" || b.type === "server_tool_use" || b.type === "web_search_tool_result"
  ).length;

  log(`anthropic call <- ${label} stop=${message.stop_reason} chars=${text.length} toolBlocks=${toolUseCount} ms=${Date.now() - started}`);
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
// Production-override system prompt (appended on top of lib/prompt.js's
// system prompt by generateHtml when this watcher invokes it). Contains
// every impeccable absolute ban + every Emil Kowalski motion law restated
// in hard language, plus mobile-first and visual-variety hard requirements,
// plus the live research findings.
// ---------------------------------------------------------------------------

function buildExtraSystem({ research }) {
  const lines = [
    "## PRODUCTION OVERRIDE (WATCH.JS — OPUS BUILD, NON-NEGOTIABLE)",
    "",
    "This is the paid production build for a real Mongolian client. Every rule below is a hard ban or hard requirement. Treat any violation as a critical bug that must be fixed before output.",
    "",
    "### IMPECCABLE ABSOLUTE BANS (restated — refuse and rewrite if you catch yourself)",
    "- NO inline <svg> tags. NO <path>, <polyline>, <polygon>, <circle>, <rect>, <line>, <ellipse>, <g>. NO data:image/svg+xml URIs in href, src, content, or background-image. Total ban — has caused blank-page production bugs.",
    "- NO mailto: links anywhere. NO <a href=\"mailto:...\">. NO <form action=\"mailto:...\">. NO JavaScript that builds a mailto URL.",
    "- NO working <form> with a non-empty action attribute (other than action=\"#\"). Any <form> must not submit. Lead capture is handled by the platform-injected chooser bar.",
    "- NO side-stripe borders. border-left or border-right >1px as a colored accent on cards, callouts, list items, or alerts is always wrong. Use full borders, background tints, leading numbers/icons, or nothing.",
    "- NO gradient text. background-clip: text combined with a gradient is always wrong. Use a single solid color; emphasis through weight or size.",
    "- NO decorative glassmorphism as default. backdrop-filter: blur must be rare and purposeful, never the default look.",
    "- NO hero-metric SaaS template (big number + small label + supporting stats + gradient accent).",
    "- NO identical card grids. Same-size cards with icon + heading + two-line text repeated endlessly is the AI-slop signal. Vary sizes, content, and layout. Break the grid in at least one section.",
    "- NO nested cards. A card inside a card is always wrong.",
    "- NO modals as a first instinct. Exhaust inline and progressive alternatives.",
    "- NO em dashes (—) and NO double-hyphens (--) anywhere in visible Mongolian copy. CSS custom properties using -- are fine.",
    "- NO #000 and NO #fff anywhere. Tint every neutral toward the brand hue (chroma 0.005–0.01).",
    "- NO tables for layout. <table> only for genuinely tabular data.",
    "- NO inline style attributes mixed with CSS classes for non-dynamic styling.",
    "- NO Lorem ipsum, NO bracket placeholders, NO 'Coming soon', NO 'Service One / Service Two', NO 'John Doe'.",
    "- NO empty <div> with a colored background as a stock-photo placeholder.",
    "- NO generic SaaS hero gradient (purple-to-blue, pink-to-orange, indigo-to-cyan).",
    "- NO external animation or component libraries. ONLY Google Fonts and the Font Awesome 6 stylesheet. No Tailwind CDN, no Bootstrap, no AOS, no GSAP, no jQuery, no Material Icons.",
    "- NO buzzwords (revolutionary, cutting-edge, next-generation, world-class, innovative) unless backed by a specific claim immediately after.",
    "- NO category reflex. Restaurant → warm brown + serif, tech → dark blue + grotesk, salon → pink + light is the training-data reflex. The brief's brand colors pick the palette.",
    "",
    "### EMIL KOWALSKI MOTION LAWS (every one is a hard requirement, not a suggestion)",
    "- Animate ONLY transform and opacity. NEVER animate layout properties (height, width, padding, margin, top, left, right, bottom).",
    "- Custom easing only. Define --ease-out-quart cubic-bezier(0.23, 1, 0.32, 1) and --ease-out-expo cubic-bezier(0.16, 1, 0.3, 1) in :root and use them. Built-in CSS easings are too weak.",
    "- NEVER use ease-in on UI animations. It feels sluggish — the visitor is watching the start, and ease-in delays the first frame.",
    "- NEVER use bounce, elastic, or spring overshoot on UI animations. Reserved for marketing demos only.",
    "- transition: all is FORBIDDEN. Always name exact properties (transform, opacity, box-shadow, border-color, color).",
    "- Buttons MUST feel responsive: transform: scale(0.97) on :active, transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1). Hover state visually distinct from :active.",
    "- Interactive cards MUST hover-lift: translateY(-2px) + stronger shadow + accent border, 220ms cubic-bezier(0.23, 1, 0.32, 1).",
    "- NEVER animate from scale(0). Start scale(0.95) + opacity 0 minimum.",
    "- IntersectionObserver scroll reveals on EVERY <section>, EVERY section heading, EVERY card or list row, EVERY hero label via the [data-reveal] attribute. Toggle 'is-in' on viewport entry. Animation: opacity 0→1 and translateY(16px)→0 over 500–600ms cubic-bezier(0.23, 1, 0.32, 1). Stagger 30–80ms via a --i custom property set inline.",
    "- The observer is wrapped in try/catch and has a DOMContentLoaded fallback that adds 'is-in' to every [data-reveal] element if the observer is unavailable or throws.",
    "- Durations: buttons 160ms, dropdowns/small popovers 180–220ms, modals 240–300ms, scroll reveals 500–600ms. UI animations stay under 300ms.",
    "- prefers-reduced-motion: reduce — disable transform-based motion, keep opacity transitions for comprehension.",
    "",
    "### MOBILE FIRST AT 375PX (HARD REQUIREMENT — most Mongolian visitors arrive on phones)",
    "- The site MUST be fully functional at 375px viewport width. Build the mental model at 375px FIRST, then scale up to 768px, 1280px, 1920px.",
    "- At <768px the header collapses to a hamburger nav that opens a real overlay menu with smooth-scroll anchors; clicking an anchor closes the menu.",
    "- The hero headline NEVER overflows or clips at 375px. Use clamp() for display type so it shrinks gracefully.",
    "- Cards, pricing tiers, services, and team grids stack to a single column at 375px with comfortable spacing (gap ≥16px, section padding ≥24px).",
    "- All tap targets are at minimum 44px × 44px. Buttons, nav links, and form-shaped inputs at <768px have padding to reach that minimum.",
    "- Pricing readable at 375px: font-size ≥14px, numbers ≥18px. No clipping. Horizontal scroll acceptable only for genuinely tabular data with overflow-x: auto.",
    "- The Contact section is finger-friendly: phone is a tel: link, email is plain text (no mailto), and touch targets are spaced apart so a thumb cannot mis-tap.",
    "- Side padding clamp(20px, 5vw, 96px). Nothing kisses the viewport edge.",
    "- Mentally scroll the page top-to-bottom at 375px before finalizing. If any section overflows, clips, or feels cramped, redesign that section.",
    "",
    "### VISUAL VARIETY (HARD REQUIREMENT — no section should look auto-generated)",
    "- Every section has a DISTINCT visual treatment. No two sections share the same background color/tint, the same layout pattern, or the same card structure.",
    "- The hero immediately communicates the brand identity within the first second: strong brand-committed color carrying the surface, opinionated typography (display weight + a single italic or colored accent word), and ambient CSS motion (drifting blob, breathing gradient, slow rotation, typewriter on one word). A plain neutral hero is a failure.",
    "- Cycle through these archetypes (no two adjacent sections share one): (1) full-bleed brand-colored band with off-center heading, (2) asymmetric two-column with oversize numeric or display word vs dense copy, (3) breathable centered editorial spread capped at 65ch, (4) varied-size tile grid where at least one tile spans 2 columns, (5) sidebar-and-stream with a vertical pull quote, (6) horizontal scroll strip for menus or products, (7) drenched accent panel with reversed-contrast text.",
    "- If you catch yourself stamping out identical icon + heading + 2-line cards, redesign that section into a different archetype."
  ];

  const trimmedResearch = (research || "").trim();
  if (trimmedResearch) {
    lines.push(
      "",
      "### DESIGN RESEARCH (real reference sites — match this quality bar)",
      "",
      trimmedResearch,
      "",
      "Borrow specific decisions from the references above (hero treatment, color, typography, motion, copy voice). Do not copy verbatim. The dalatech.online observations define the minimum quality bar Bilguun expects from this build."
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// STEP 0 — RESEARCH (web_search)
// ---------------------------------------------------------------------------

const RESEARCH_SYSTEM = [
  "You are a senior design research analyst working alongside Bilguun's production website team.",
  "Use the web_search tool to gather real, premium reference sites and concrete design observations for a single-file marketing website build. Do not invent URLs — if a search yields nothing useful, say so and move on.",
  "Be specific. Premium means craft, not chrome: opinionated typography, committed color, real motion, real copy. Award-winning sites (Awwwards, FWA, SiteInspire), recent agency portfolios, and well-loved consumer brand sites are good. Generic SaaS templates are not.",
  "Your output is a markdown report only. The next step turns this report into a content plan; the step after that turns the plan into HTML."
].join("\n");

function researchUserPrompt(lead) {
  const style = lead.style || "premium";
  return [
    "Research premium reference sites for the following Mongolian business and report what 'premium' looks like for this specific industry. Use the web_search tool aggressively — at least 4 searches.",
    "",
    "## Client brief",
    describeLead(lead),
    "",
    "## Searches to run (use the web_search tool for each)",
    `1. Top 3 PREMIUM websites in the ${lead.industry || "this"} industry globally. Award winners or sites known for craft (Awwwards, FWA, SiteInspire, agency portfolios).`,
    `2. Best examples of ${lead.industry || "this category"} websites in Mongolia or wider Asia. Real businesses, not concept work.`,
    `3. dalatech.online — read its design language as the quality standard Bilguun expects. Note hero treatment, color, motion, typography, and copy register. (Search for "dalatech.online", "DalaTech Mongolia", or related queries.)`,
    `4. Recent (2025–2026) hero and layout patterns that match the "${style}" register and would feel premium for this brief.`,
    "",
    "## Output format (strict — use these exact headings)",
    "",
    `### 1. Top 3 premium ${lead.industry || "industry"} sites (global)`,
    "For each: real URL, why it works, the specific design decisions worth borrowing (hero treatment, color strategy, typography, motion, copy voice). 4–6 sentences per entry.",
    "",
    "### 2. Mongolia or Asia examples",
    "Real URLs plus the concrete observations to borrow. If no strong examples surface, write 'no strong Asia examples found' and skip — do not invent.",
    "",
    "### 3. dalatech.online design language",
    "Concrete observations from search results: color, typography, motion, copy register. State this explicitly as the quality bar the build must clear.",
    "",
    `### 4. Premium 2025–2026 patterns matching the "${style}" register`,
    "Brief notes — what's current and how it could shape the hero, services, pricing, and contact sections of this site.",
    "",
    "### 5. Synthesis — what premium looks like for THIS specific industry",
    "5–8 concrete design decisions the generator should make in the build, derived from the research above. Specific colors, type pairings, motion patterns, copy moves. No hedging."
  ].join("\n");
}

async function runResearchStep(lead) {
  logHeader(`#${lead.id} STEP 0/6 — RESEARCH (web_search)`);
  let research = "";
  try {
    research = await callClaude({
      system: RESEARCH_SYSTEM,
      user: researchUserPrompt(lead),
      maxTokens: 6000,
      timeoutMs: RESEARCH_TIMEOUT_MS,
      label: `research-#${lead.id}`,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }]
    });
  } catch (err) {
    // Research failure is NOT fatal. Production builds should still ship.
    // We log and fall through to PLAN/GENERATE with no research findings.
    log(`#${lead.id} research step threw, continuing without findings: ${err?.message || err}`);
    return "";
  }
  research = (research || "").trim();
  if (!research) {
    log(`#${lead.id} research returned empty, continuing without findings`);
    return "";
  }
  console.log("\n--- RESEARCH ---\n" + research + "\n--- END RESEARCH ---\n");
  return research;
}

// ---------------------------------------------------------------------------
// STEP 1 — PLAN
// ---------------------------------------------------------------------------

const PLAN_SYSTEM = [
  "You are a senior design engineer + copywriter planning a single-file production website for a real Mongolian small business.",
  "Apply the impeccable design philosophy (committed color strategy, deliberate motion, no AI slop, no SVG, no mailto) and Emil Kowalski's design engineering laws (transform/opacity only, custom easing, asymmetric enter/exit timing, no transition: all, no bounce, no elastic, no scale(0) entries).",
  "Mobile-first at 375px is non-negotiable — the plan must work on a phone.",
  "Every section must have a distinct visual treatment — no two sections share the same background, layout pattern, or card structure.",
  "Your output is a structured plan ONLY. Do not write HTML, CSS, or JavaScript. The next step turns this plan into HTML.",
  "Be specific, opinionated, and committed. Every section needs a concrete reason to exist."
].join("\n");

function planUserPrompt(lead, research) {
  const trimmedResearch = (research || "").trim();
  const lines = [
    "## Client brief",
    describeLead(lead),
    "",
    "## Extras gathered by Bilguun (real client info, source of truth)",
    describeExtras(lead) || "(none — work from the brief above)"
  ];

  if (trimmedResearch) {
    lines.push(
      "",
      "## Design research (real premium references — borrow specific decisions)",
      trimmedResearch
    );
  }

  lines.push(
    "",
    "## Plan format (use these exact headings)",
    "",
    "### 1. Section list",
    "Ordered list of sections (Hero first). For each: a one-sentence summary of what it says, and why it earns its place. Aim for 6–9 sections. No filler. Each section names a DISTINCT visual archetype — no two adjacent sections share one.",
    "",
    "### 2. Copy strategy",
    "Tone, voice, what to emphasize, what to avoid. Concrete examples of phrases that match the brand. Mongolian Cyrillic.",
    "",
    "### 3. Color strategy",
    "Pick one strategy from Committed / Drenched / Full palette. State where the brand primary appears in each section (hero, accent borders, hovers, etc.). Reject Restrained for this build.",
    "",
    "### 4. Hero treatment",
    "Describe exactly what the visitor sees in the first second on a 375px phone screen AND on desktop. Layout, headline phrasing, ambient CSS motion (no SVG), how the brand color carries the surface.",
    "",
    "### 5. Typography hierarchy",
    "Scale ratios, weight contrasts, where italics or display weight are used sparingly. Reference the requested style register. Specify clamp() ranges so display type does not overflow at 375px.",
    "",
    "### 6. Motion plan",
    "Which sections animate, the easing curve, the timing. Stagger ranges. Hover/active feedback expectations. Reference Emil Kowalski laws by name (transform/opacity only, custom ease-out-quart, no transition: all, no bounce, no elastic, no scale(0) entries).",
    "",
    "### 7. Mobile-at-375px plan",
    "How the header collapses to hamburger, how the hero stacks, how pricing remains readable, how cards stack, what padding scales. Be specific.",
    "",
    "### 8. Photo distribution",
    "If the client supplied photo URLs, list which section each photo lands in, with the alt text in Mongolian.",
    "",
    "### 9. Concrete copy notes",
    "Specific phrasing, plausible tugrik prices, real names, address, hours, social handles. Anything Bilguun mentioned in the extras must be woven in here."
  );

  return lines.join("\n");
}

async function runPlanStep(lead, research) {
  logHeader(`#${lead.id} STEP 1/6 — PLAN`);
  const plan = await callClaude({
    system: PLAN_SYSTEM,
    user: planUserPrompt(lead, research),
    maxTokens: 4000,
    timeoutMs: PLAN_TIMEOUT_MS,
    label: `plan-#${lead.id}`
  });
  if (!plan.trim()) throw new Error("Plan step returned an empty plan");
  console.log("\n--- PLAN ---\n" + plan.trim() + "\n--- END PLAN ---\n");
  return plan.trim();
}

// ---------------------------------------------------------------------------
// STEP 2 — GENERATE
// ---------------------------------------------------------------------------

async function runGenerateStep({ lead, plan, reviewFeedback, attempt, extraSystem }) {
  logHeader(`#${lead.id} STEP 2/6 — GENERATE (attempt ${attempt})`);
  const brief = buildBrief({ lead, plan, reviewFeedback });
  const html = await generateHtml(brief, {
    model: MODEL,
    extraSystem,
    timeoutMs: GENERATE_TIMEOUT_MS
  });
  log(`#${lead.id} generated HTML length=${html.length}`);
  return { html, brief };
}

// ---------------------------------------------------------------------------
// STEP 3 — SELF REVIEW
// ---------------------------------------------------------------------------

const REVIEW_SYSTEM = [
  "You are a senior design engineer doing an adversarial review of a single-file production website. Be ruthless.",
  "You MUST apply EVERY impeccable absolute ban and EVERY Emil Kowalski motion law. Name the violation type explicitly in each finding using one of these tags: [Impeccable], [Emil], [Mobile-375], [Visual-Variety], [Tech]. The site must feel alive, brand-committed, crafted — not AI slop.",
  "",
  "Check (non-exhaustive):",
  "",
  "Impeccable absolute bans — tag each finding [Impeccable]:",
  "- Any inline <svg>, <path>, <polyline>, <polygon>, <circle>, <rect>, <line>, <g>, <ellipse>, or data:image/svg+xml URI. Total ban.",
  "- Any mailto: link or <form action=\"mailto:...\">. Total ban.",
  "- Any working <form> with a non-empty action attribute (other than action=\"#\").",
  "- Side-stripe borders (border-left or border-right >1px as a colored accent on cards, list items, callouts, alerts).",
  "- Gradient text (background-clip: text combined with a gradient).",
  "- Decorative glassmorphism used as default (backdrop-filter blur everywhere).",
  "- The hero-metric SaaS template (big number, small label, supporting stats, gradient accent).",
  "- Identical card grids with no variation.",
  "- Nested cards.",
  "- Pure #000 or #fff anywhere.",
  "- Em dashes (—) or double-hyphens (--) in visible Mongolian copy (CSS custom properties using -- are fine).",
  "- Lorem ipsum, [bracket placeholders], 'Coming soon', generic SaaS phrasing, restated headings.",
  "- Brand primary failing to carry roughly 35%+ of the visible surface (Committed strategy).",
  "- Hero without ambient CSS motion in the first second.",
  "- Tables used for layout.",
  "- Inline style attributes mixed with CSS classes for non-dynamic styling.",
  "- External animation or component libraries (Tailwind CDN, Bootstrap, AOS, GSAP, jQuery, Material Icons).",
  "",
  "Emil Kowalski motion violations — tag each finding [Emil]:",
  "- transition: all anywhere.",
  "- Animating layout properties (height, width, padding, margin, top, left).",
  "- ease-in on UI animations.",
  "- Bounce or elastic easing on UI animations.",
  "- Animation entering from scale(0). Must be scale(0.95) + opacity 0 minimum.",
  "- Built-in CSS easings without a custom curve. Must use --ease-out-quart cubic-bezier(0.23, 1, 0.32, 1) or --ease-out-expo cubic-bezier(0.16, 1, 0.3, 1).",
  "- Buttons missing transform: scale(0.97) on :active.",
  "- Cards missing hover-lift translateY(-2px) + stronger shadow + accent border.",
  "- Missing IntersectionObserver scroll reveals on every section + missing stagger via --i.",
  "- Observer NOT wrapped in try/catch with a DOMContentLoaded fallback that adds is-in to all [data-reveal].",
  "- Missing prefers-reduced-motion handling.",
  "",
  "Mobile-first at 375px violations — tag each finding [Mobile-375]:",
  "- Hero text overflows or clips at 375px.",
  "- Header lacks a hamburger nav at <768px.",
  "- Cards/pricing/services do not stack to a single column at 375px.",
  "- Tap targets <44px × 44px on mobile.",
  "- Pricing clips or becomes unreadable at 375px (numbers <18px).",
  "- Side padding touches the viewport edge (no clamp() with a ≥20px floor).",
  "- Fixed pixel font-sizes on hero display type.",
  "- Any section that overflows horizontally at 375px (look for fixed widths, missing min-width: 0, missing flex-wrap, etc).",
  "",
  "Visual variety violations — tag each finding [Visual-Variety]:",
  "- Two adjacent sections share the same background, layout pattern, or card structure.",
  "- Hero looks like a template (no committed brand color, no opinionated typography, no ambient motion).",
  "- Sections look auto-generated (identical icon + heading + two-line cards repeated).",
  "- Fewer than 6 distinct content-rich sections beyond Hero.",
  "- Section with less than ~80 words of substantive Mongolian copy.",
  "",
  "Technical violations — tag each finding [Tech]:",
  "- Missing scroll-margin-top on sections (sticky header overlaps anchored content).",
  "- Anchors in the header without matching section ids (clicking them does nothing).",
  "- Buttons with href=\"#\" that don't scroll to a real section.",
  "- JavaScript syntax errors, or any unclosed <script>, <style>, <body>, or <html> tag.",
  "- Photo URLs provided by the client that are not used as real <img> tags.",
  "- Missing or weak FAQ (need 5–8 real client-style questions).",
  "- Missing or weak About (need a magazine-style founding story).",
  "- Missing pricing/services tiers — production needs at least 3 with concrete tugrik prices.",
  "- Copy that reads like generic AI (hedging, vague, restated headings, buzzwords without specifics).",
  "",
  "OUTPUT FORMAT — STRICT:",
  "- If you find ZERO issues, output exactly: PASS",
  "- Otherwise output a numbered list. Each item starts with one of the tags above in square brackets, then says which section, what is wrong, and exactly what to do instead.",
  "  Example: '3. [Emil] Hero CTA button uses transition: all 0.3s. Replace with transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1) and add transform: scale(0.97) on :active.'",
  "- Do NOT output anything else. No preamble. No commentary. No congratulations."
].join("\n");

function reviewUserPrompt(lead, html) {
  return [
    `Business: ${lead.businessName} (${lead.industry || "unknown"}).`,
    `Style register: ${lead.style || "—"}.`,
    `Brand primary: ${lead.primaryColor || "—"}, secondary: ${lead.secondaryColor || "—"}.`,
    "",
    "Review the following HTML and report every flaw you find. Tag every finding with [Impeccable], [Emil], [Mobile-375], [Visual-Variety], or [Tech]. If clean, output the single word PASS.",
    "",
    "--- BEGIN HTML ---",
    html,
    "--- END HTML ---"
  ].join("\n");
}

async function runSelfReviewStep({ lead, html, attempt }) {
  logHeader(`#${lead.id} STEP 3/6 — SELF REVIEW (after attempt ${attempt})`);
  const text = await callClaude({
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

  logHeader(`#${lead.id} BUILD START iteration=${iteration} business="${lead.businessName}" model=${MODEL}`);

  // Claim the lead immediately so a second watcher loop tick can't pick it
  // up. The status flip from READY_TO_FINISH -> FINISHING/CHANGING is the
  // single-owner gate. Also bumps updatedAt so the staleness window starts
  // from the moment we began work.
  await updateLead(lead.id, {
    status: isInitial ? STATUS.FINISHING : STATUS.CHANGING,
    finishingStartedAt: lead.finishingStartedAt || new Date().toISOString(),
    lastError: null
  });

  // STEP 0 — RESEARCH (non-fatal)
  const research = await runResearchStep(lead);
  const extraSystem = buildExtraSystem({ research });

  // STEP 1 — PLAN
  let plan;
  try {
    plan = await runPlanStep(lead, research);
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
      const out = await runGenerateStep({ lead, plan, reviewFeedback: lastReviewFeedback, attempt, extraSystem });
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
  log(`watcher starting. poll=${POLL_INTERVAL_MS}ms model=${MODEL} maxReviewIters=${MAX_REVIEW_ITERATIONS}`);
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
