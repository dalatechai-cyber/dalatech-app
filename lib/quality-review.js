"use strict";

const Anthropic = require("@anthropic-ai/sdk");

const REVIEW_SYSTEM = [
  "You are a senior design engineer doing a strict quality review on a single-file HTML website.",
  "You will receive the full HTML. Your job is to find every quality violation and return a corrected HTML document.",
  "",
  "Apply the impeccable design standards and Emil Kowalski's design engineering standards. Specifically check for and fix:",
  "",
  "IMPECCABLE VIOLATIONS (forbidden, must be rewritten):",
  "- Side-stripe borders (border-left or border-right > 1px as a colored accent on cards, list items, callouts, alerts). Replace with full borders, background tints, leading numbers/icons, or nothing.",
  "- Gradient text (background-clip: text with a gradient). Replace with a single solid color. Emphasis via weight or size only.",
  "- Decorative glassmorphism (blur/glass as default). Remove unless purposeful.",
  "- The hero-metric cliche (big number, small label, supporting stats with gradient accent). Rewrite the section if present.",
  "- Identical-card grids (same-size cards with icon + heading + 2-line text, repeated endlessly). Break the grid: vary sizes, content, or layout in at least one section.",
  "- Nested cards (a card inside a card). Always wrong, flatten.",
  "- Pure #000 or #fff. Replace with neutrals tinted toward the brand hue.",
  "- Em dashes and double-hyphens in VISIBLE Mongolian copy. Replace with commas, colons, periods, or parentheses. CSS custom properties using -- are fine, only fix VISIBLE text.",
  "- Buzzwords (revolutionary, cutting-edge, next-generation, world-class) without a specific claim after.",
  "- Inline style attributes mixed with classes for non-dynamic styling. Move to <style>.",
  "- Lorem ipsum, placeholder names, [bracket placeholders], 'Coming soon'. Replace with realistic Mongolian copy.",
  "",
  "EMIL DESIGN ENG VIOLATIONS (must be fixed):",
  "- Bouncy or elastic easing on UI animations. Replace with cubic-bezier(0.23, 1, 0.32, 1) ease-out.",
  "- ease-in on UI elements (sluggish entrance). Replace with ease-out.",
  "- Animations from scale(0). Replace with scale(0.95) + opacity 0.",
  "- transition: all. Replace with explicit properties (transform, opacity).",
  "- Animation duration > 300ms on small UI elements (buttons, hovers, tooltips).",
  "- Decorative motion with no purpose. Remove or justify with state change.",
  "- Identical animation rates across all reveal elements (no stagger). Add stagger via --i custom property.",
  "- Buttons missing :active scale(0.97) feedback.",
  "",
  "CRITICAL RENDERING ISSUES (must fix or the site renders broken):",
  "- Any <svg> <path> with empty d='' attribute, broken d attribute (truncated, contains a literal newline inside the attribute value), or malformed numbers like NaN/undefined. Remove or replace the path with a valid one.",
  "- Any unclosed tag, especially <style>, <script>, <body>, <html>.",
  "- Any [data-reveal] element where the reveal animation could leave the element stuck at opacity: 0 if JavaScript fails. Add a safety rule so [data-reveal] elements are visible by default (the initial opacity: 0 lives behind a class that the inline script adds to <html> on load), so the page is still readable if JS fails.",
  "- Any inline <script> with a syntax error. Validate the JavaScript.",
  "",
  "OUTPUT CONTRACT (non-negotiable):",
  "- Return ONE complete HTML document. Start with <!doctype html>. End with </html>.",
  "- Do NOT include markdown fences, do NOT add commentary before or after the HTML.",
  "- Preserve the structure, copy, and design intent of the original. Only fix violations and rendering issues. Do not redesign.",
  "- If the original has no violations, return it unchanged.",
  "- The very first characters of your output must be <!doctype html>. The very last characters must be </html>."
].join("\n");

function buildReviewUser(brief, html) {
  const parts = [
    `Review the following HTML website for ${brief?.businessName || "a Mongolian business"} (${brief?.industry || "unknown industry"}).`,
    "",
    "Apply every standard from the system prompt. Fix every violation you find. Return the corrected HTML in full.",
    "",
    "Pay extra attention to:",
    "- Any [data-reveal] element that could stay invisible if JavaScript fails or throws.",
    "- Any malformed SVG path d attribute.",
    "- Any unclosed style/script/body/html tag.",
    "- Em dashes or double-hyphen sequences in Mongolian copy.",
    "",
    "Here is the HTML:",
    "",
    html
  ];
  return parts.join("\n");
}

function extractCleanHtml(text) {
  if (!text) return "";
  let candidate = text.trim();

  const fence = candidate.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();

  const startMatch = candidate.match(/<!doctype\s+html|<html\b/i);
  if (startMatch && startMatch.index !== undefined && startMatch.index > 0) {
    candidate = candidate.slice(startMatch.index);
  }

  const endIdx = candidate.search(/<\/html\s*>/i);
  if (endIdx >= 0) {
    const tagMatch = candidate.slice(endIdx).match(/<\/html\s*>/i);
    const tagLen = tagMatch ? tagMatch[0].length : "</html>".length;
    candidate = candidate.slice(0, endIdx + tagLen);
  }

  return candidate.trim();
}

async function reviewAndFixHtml({ html, brief }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  if (!html) throw new Error("reviewAndFixHtml requires html");

  const client = new Anthropic({ apiKey });
  console.log(`[review] starting quality review business="${brief?.businessName || "?"}" htmlLength=${html.length}`);

  const message = await client.messages.create(
    {
      model: "claude-sonnet-4-6",
      max_tokens: 24000,
      system: REVIEW_SYSTEM,
      messages: [
        { role: "user", content: buildReviewUser(brief || {}, html) }
      ]
    },
    { timeout: 240000 }
  );

  const text = (message.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");

  const cleaned = extractCleanHtml(text);
  if (!cleaned || !/<html/i.test(cleaned)) {
    console.warn("[review] reviewer returned invalid HTML, falling back to original");
    return { html, reviewed: false };
  }

  console.log(`[review] review complete original=${html.length} reviewed=${cleaned.length}`);
  return { html: cleaned, reviewed: true };
}

module.exports = { reviewAndFixHtml };
