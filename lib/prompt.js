"use strict";

const STYLE_GUIDANCE = {
  minimal:      "Generous whitespace, restrained typography, monochrome surfaces with one accent. Editorial pacing. Inspired by Linear, Apple, Stripe.",
  bold:         "Large display type, saturated brand colors, strong contrast, confident negative space. Inspired by Vercel ship pages, Mercury, Notion launch posts.",
  elegant:      "Sophisticated serif headings paired with a clean sans body, refined spacing, subtle hairlines, generous line-height. Inspired by The New York Times, Aesop, Hermès.",
  playful:      "Rounded geometry, vibrant gradients, friendly micro-interactions, motion that feels alive without being childish. Inspired by Duolingo, Figma, MailChimp.",
  professional: "Structured grid, conservative palette, clear hierarchy, business-credible. Inspired by HubSpot, Salesforce, Stripe enterprise pages."
};

const INDUSTRY_HINTS = {
  restaurant: "Use food-forward language. Sections likely include menu highlights, ambience description, location with hours, reservation CTA. Visuals should evoke warmth and appetite.",
  salon:      "Sections likely include featured services, stylists/technicians, before-and-after or portfolio look, booking CTA. Visuals should feel calm, premium, tactile.",
  retail:     "Sections likely include featured products, brand story, what makes the goods special, store / online ordering CTA. Visuals should feel curated.",
  service:    "Lead with the outcome the client gets. Sections likely include process steps, social proof, pricing tiers, contact CTA. Visuals should feel trustworthy and concrete.",
  tech:       "Lead with the problem solved and how. Sections likely include product capability, integration list, pricing, demo / contact CTA. Visuals should feel modern and precise.",
  other:      "Read the business description carefully and write copy that fits."
};

function buildSystemPrompt() {
  return [
    "You are an elite frontend designer and front-end engineer.",
    "You have shipped award-winning sites for clients comparable to Apple, Linear, Stripe, Vercel, Aesop, and Mercury.",
    "Your output is real, working, production-quality HTML, not a template, not boilerplate, not generic SaaS slop.",
    "",
    "WHEN ASKED TO GENERATE A WEBSITE, YOU MUST:",
    "1. Return ONE single self-contained HTML document.",
    "2. Inline ALL CSS inside a <style> tag and ALL JS inside a <script> tag. No external CSS, no external JS, no build step.",
    "3. The ONLY external resources allowed are Google Fonts (via <link> in head) and inline SVG. No images, no icon libraries, no animation libraries.",
    "4. Start the response with <!doctype html> and end it with </html>.",
    "5. Output NOTHING else: no markdown fences, no preamble, no commentary, no closing remarks.",
    "",
    "DESIGN STANDARDS (non-negotiable):",
    "- Mobile-first responsive. Looks excellent from 360px to 1920px. Use clamp() for fluid type.",
    "- Use the client's brand colors as the actual palette. Tint neutrals toward the primary hue (do not use #000 or #fff).",
    "- Strong typography hierarchy. Use 1-2 Google Fonts that match the requested style. Display font for headings, clean sans for body.",
    "- Smooth scroll between sections (CSS scroll-behavior: smooth + scroll-margin-top on section anchors).",
    "- Entrance animations on scroll using IntersectionObserver toggling a CSS class. Eased with cubic-bezier(0.22, 1, 0.36, 1) or similar ease-out-quart. NO bounce, NO elastic.",
    "- Sticky header with smooth-scroll anchors.",
    "- Realistic, business-specific copy in Mongolian (the client and their visitors are Mongolian). Use real numbers and names that fit the business, not Lorem ipsum, not 'Service One / Service Two'.",
    "- Strong opinionated visual choices. The site should feel like it was made specifically for this business, not adapted from a template.",
    "",
    "ABSOLUTE BANS (rewrite the element if you catch yourself doing any of these):",
    "- No side-stripe borders (border-left/right > 1px as a colored accent on cards or callouts).",
    "- No gradient text via background-clip: text.",
    "- No glassmorphism by default (rare, only if it serves the brand).",
    "- No identical card grids of icon + heading + 2-line text repeated 3 or 6 times.",
    "- No em dashes anywhere in copy. Use commas, periods, colons, or parentheses.",
    "- No external animation, icon, or component libraries.",
    "",
    "QUALITY BAR: A senior designer reviewing this should not be able to tell it was AI-generated. If you produce SaaS-template slop, you have failed."
  ].join("\n");
}

function buildUserPrompt(brief) {
  const {
    businessName,
    industry,
    description,
    services,
    primaryColor,
    secondaryColor,
    style,
    references,
    sections,
    phone,
    email
  } = brief;

  const styleNote = STYLE_GUIDANCE[style] || STYLE_GUIDANCE.professional;
  const industryNote = INDUSTRY_HINTS[industry] || INDUSTRY_HINTS.other;
  const sectionList = (sections && sections.length > 0) ? sections : ["Hero", "About", "Services", "Contact"];

  return [
    `Generate a complete single-file HTML website for the following Mongolian business. Output ONLY the HTML.`,
    ``,
    `## Client brief`,
    `- Business name: ${businessName}`,
    `- Industry: ${industry}`,
    `- Description: ${description}`,
    `- Services / products: ${services}`,
    `- Reference sites they like: ${references && references.trim() ? references : "none specified"}`,
    `- Primary contact phone: ${phone}`,
    `- Primary contact email: ${email}`,
    ``,
    `## Brand colors`,
    `- Primary: ${primaryColor}`,
    `- Secondary: ${secondaryColor}`,
    `Use these as the actual palette. Derive tinted neutrals from the primary hue. Avoid pure black or pure white.`,
    ``,
    `## Visual style`,
    `Selected: ${style}`,
    `Direction: ${styleNote}`,
    ``,
    `## Industry direction`,
    industryNote,
    ``,
    `## Sections to include (in this order)`,
    sectionList.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    `Hero is mandatory and is always first. Include a sticky header with smooth-scroll links to each section.`,
    `The Contact section MUST display the phone number ${phone} prominently and include the email ${email}.`,
    ``,
    `## Copy`,
    `Write all visible copy in Mongolian (Cyrillic). Use realistic, specific copy that fits "${businessName}" and the description above. Do not use placeholder names like "Service One" or "Lorem ipsum". Invent plausible service names, prices, testimonials, and details that match this business.`,
    ``,
    `## Output format reminder`,
    `Return ONLY the HTML. Start with <!doctype html>. End with </html>. No markdown fences, no explanation.`
  ].join("\n");
}

module.exports = { buildSystemPrompt, buildUserPrompt };
