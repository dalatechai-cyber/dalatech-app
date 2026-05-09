"use strict";

// Pick a Google Font pairing that matches the requested visual register.
const FONT_PAIRINGS = {
  minimal: {
    heading: "DM Sans",
    body: "DM Sans",
    href: "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap"
  },
  bold: {
    heading: "Space Grotesk",
    body: "Inter",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap"
  },
  elegant: {
    heading: "Playfair Display",
    body: "Inter",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Playfair+Display:ital,wght@0,500;0,600;0,700;1,500&display=swap"
  },
  playful: {
    heading: "Fraunces",
    body: "Inter",
    href: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700;9..144,900&family=Inter:wght@400;500;600&display=swap"
  },
  professional: {
    heading: "Inter",
    body: "Inter",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
  }
};

const STYLE_GUIDANCE = {
  minimal:
    "Generous whitespace. Restrained typography in DM Sans. Tinted neutrals plus a single accent occupying ≤10% of the surface. Editorial pacing, hairline rules, careful asymmetry. Reference points: Linear marketing pages, Apple product pages, Stripe documentation, Vercel changelog.",
  bold:
    "Display-scale Space Grotesk headlines, Inter for body. Confident negative space, large type contrast, saturated brand color carrying 30 to 60 percent of the surface. Reference points: Vercel ship pages, Mercury, Notion launch posts, Framer pages.",
  elegant:
    "Playfair Display headlines paired with Inter body. Italic display variants used sparingly for emphasis. Refined hairlines, generous line-height, restrained motion. Reference points: The New York Times Magazine, Aesop, Hermès, Loewe.",
  playful:
    "Fraunces (with optical sizing) for headlines, Inter for body. Warm, embodied curves. Vibrant brand color, friendly micro-interactions. Reference points: Linear changelog illustrations, Vercel campaign pages, Arc Browser, Ramp.",
  professional:
    "Inter throughout with strong hierarchy from weight contrast. Conservative palette, structured grid, generous breathing room. Reference points: Stripe enterprise, HubSpot product pages, Mercury Treasury, Watershed."
};

const INDUSTRY_HINTS = {
  restaurant:
    "Lead with a single evocative dish description, an ambience line, the address, and hours. Reservation CTA. Visuals should evoke warmth and appetite without using stock photography clichés. Mention real Mongolian neighborhoods if location is relevant.",
  salon:
    "Lead with the experience, not the price. Show featured services with concrete prices in tugriks. Stylist names if appropriate. Booking CTA. Visuals should feel calm, premium, tactile, like the work itself.",
  retail:
    "Lead with the brand story. Show featured products with concrete prices. Explain what makes the goods specific to this shop. Online/in-store ordering CTA. Visuals should feel curated, not catalog-style.",
  service:
    "Lead with the outcome the client gets. Concrete process steps. Real testimonials with named businesses if plausible. Pricing tiers if appropriate. Visuals should feel trustworthy and concrete.",
  tech:
    "Lead with the problem solved and how. Capability list. Integration list if relevant. Pricing if appropriate, otherwise demo/contact. Visuals should feel modern and precise.",
  other:
    "Read the business description carefully and write copy that fits. Avoid generic SaaS phrasing."
};

function buildSystemPrompt() {
  return [
    "You are a senior design engineer. You ship interfaces at the level of Linear, Vercel, Stripe, Apple, Aesop, and Mercury.",
    "Your output is one self-contained HTML document. Real working code, real copy, real design choices. No templates, no boilerplate, no SaaS slop.",
    "",
    "OUTPUT CONTRACT (non-negotiable)",
    "- Return ONE complete HTML document. Start with <!doctype html>. End with </html>.",
    "- Inline ALL CSS in a single <style> tag. Inline ALL JS in a single <script> tag.",
    "- ONLY external resource allowed: Google Fonts via <link> in <head>, and inline SVG. No images, no CDN libraries, no icon fonts.",
    "- Output NOTHING outside the HTML. No markdown fences. No preamble. No commentary. No closing remarks.",
    "",
    "ABSOLUTE BANS, match and refuse. If you catch yourself doing any of these, rewrite the element.",
    "- No side-stripe borders (border-left or border-right > 1px as a colored accent on cards, list items, callouts, alerts).",
    "- No gradient text (background-clip: text on a gradient background). Use a single solid color. Emphasis via weight or size.",
    "- No glassmorphism by default. Blur and translucent surfaces only when they serve the brand on a single, purposeful element.",
    "- No identical card grids of icon + heading + 2-line text repeated 3 or 6 times. Vary cards in size, content, or layout.",
    "- No nested cards. A card inside a card is always wrong.",
    "- No hero-metric template (giant number, small label, supporting stat, gradient accent). It is the most-overused SaaS cliché.",
    "- No em dashes (—) and no double-hyphens (--) anywhere. Use commas, colons, semicolons, periods, or parentheses.",
    "- No #000 or #fff. Tint neutrals toward the brand hue (chroma 0.005 to 0.01 in OKLCH).",
    "- No external animation libraries, icon libraries, or component libraries.",
    "- No Lorem ipsum, no 'Service One / Service Two', no placeholder names, no fake testimonials with stock-photo names like 'John Doe'.",
    "",
    "COLOR (impeccable rules)",
    "- Use OKLCH where possible. Reduce chroma as lightness approaches 0 or 100 to avoid garish extremes.",
    "- Pick a color strategy before picking colors:",
    "  - Restrained: tinted neutrals plus one accent at ≤10% of the surface. Default for professional and minimal.",
    "  - Committed: one saturated brand color carries 30 to 60 percent of the surface. Default for bold.",
    "  - Drenched: the surface IS the brand color. For hero / feature campaigns only.",
    "- Tint every neutral toward the primary hue. Never use #000 or #fff anywhere.",
    "",
    "TYPOGRAPHY",
    "- Use the Google Fonts pair given in the brief. Do not substitute.",
    "- Cap body line length at 65 to 75ch.",
    "- Hierarchy through scale and weight contrast. Step ratios ≥1.25. Avoid flat scales.",
    "- Use clamp() for fluid type. Mobile first. Looks excellent from 360px to 1920px.",
    "",
    "LAYOUT",
    "- Vary spacing for rhythm. Same padding everywhere is monotony.",
    "- Don't wrap everything in a container. Most things don't need one.",
    "- Cards are the lazy answer. Use them only when they are truly the best affordance.",
    "- Mobile first responsive. Test mentally at 360px, 768px, 1280px, 1920px.",
    "",
    "MOTION (emil-design-eng)",
    "- Animate only transform and opacity. Never animate layout properties.",
    "- Use custom easing curves. The built-in CSS easings are too weak.",
    "  - --ease-out-quart: cubic-bezier(0.23, 1, 0.32, 1)",
    "  - --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1)",
    "  - --ease-in-out-quart: cubic-bezier(0.77, 0, 0.175, 1)",
    "- Entering elements use ease-out. UI animations stay under 300ms.",
    "- Never animate from scale(0). Start from scale(0.95) with opacity 0. Nothing in the real world appears from nothing.",
    "- Buttons must feel responsive: transform: scale(0.97) on :active, transition 160ms ease-out.",
    "- Editorial scroll reveals: an IntersectionObserver toggles a class that animates opacity and a small translateY. Stagger children by 30 to 80ms.",
    "- No bounce, no elastic, no rubber-band easings. They feel cheap.",
    "- @media (prefers-reduced-motion: reduce): disable transform-based motion, keep opacity transitions.",
    "",
    "COPY",
    "- Every word earns its place. No restated headings, no intros that repeat the title.",
    "- Write like a senior copywriter for the specific business. Concrete numbers, specific service names, plausible prices in tugriks (₮).",
    "- All visible copy is in Mongolian (Cyrillic) unless the brief says otherwise.",
    "- Realistic testimonials only. Use Mongolian first names (Болд, Сүхээ, Болормаа, Цэцэг, Энхтуяа, etc.) with plausible local business names.",
    "",
    "QUALITY BAR",
    "A senior design engineer reviewing this should not be able to tell it was AI generated. The site should feel like it was built by an agency charging $10,000 to $25,000. If the client looks at it and is not immediately compelled to pay for the full version, you have failed."
  ].join("\n");
}

function pickFontPair(style) {
  return FONT_PAIRINGS[style] || FONT_PAIRINGS.professional;
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
  const fonts = pickFontPair(style);

  return [
    "Generate a complete single-file HTML website for the following Mongolian business. Output ONLY the HTML.",
    "",
    "## Client brief",
    `- Business name: ${businessName}`,
    `- Industry: ${industry}`,
    `- Description: ${description}`,
    `- Services / products: ${services}`,
    `- Reference sites the client likes: ${references && references.trim() ? references : "none specified"}`,
    `- Primary contact phone: ${phone}`,
    `- Primary contact email: ${email}`,
    "",
    "## Brand colors",
    `- Primary: ${primaryColor}`,
    `- Secondary: ${secondaryColor}`,
    "Use these as the actual palette. Convert to OKLCH for stylesheet variables. Derive tinted neutrals from the primary hue (very low chroma, 0.005 to 0.01). Avoid pure black or pure white.",
    "",
    "## Visual register",
    `Selected style: ${style}`,
    `Direction: ${styleNote}`,
    "",
    "## Typography (use these exact fonts)",
    `- Heading family: ${fonts.heading}`,
    `- Body family: ${fonts.body}`,
    `- Google Fonts link: <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="${fonts.href}" rel="stylesheet">`,
    "Do not substitute fonts. Place the link in <head> before the <style> tag.",
    "",
    "## Industry direction",
    industryNote,
    "",
    "## Sections to include (in this order)",
    sectionList.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    "Hero is mandatory and is always first. Include a sticky header with smooth-scroll anchors to each section.",
    `The Contact section MUST display the phone number ${phone} prominently and the email ${email}.`,
    "",
    "## Specific design demands",
    "1. Hero: opinionated and specific to this business. Not a stock 'headline + subhead + two CTAs + product screenshot' template. Consider: a single arresting line of copy with one accent word, an offset ambient shape made from inline SVG, a sticky bottom marquee of services, or a split layout with type on one side and a vertical detail strip on the other. Pick one direction with conviction.",
    "2. Smooth scroll: html { scroll-behavior: smooth }. Each section uses scroll-margin-top so the sticky header doesn't cover anchors.",
    "3. Scroll reveals: IntersectionObserver with rootMargin '-80px 0px'. Add class 'is-in' that animates opacity 0 to 1 and translateY(12px) to 0 with 600ms cubic-bezier(0.23, 1, 0.32, 1). Stagger children with --i custom property × 60ms.",
    "4. Buttons: transform scale(0.97) on :active, 160ms cubic-bezier(0.23, 1, 0.32, 1). Hover state ≠ active state.",
    "5. At least one section MUST break the grid (full bleed image-less section, asymmetric two column, sidebar pull quote, vertical type, or oversize numeric display). No site should be a stack of equal-height cards.",
    "6. Footer must be substantial: address, hours if relevant, social, and a small typographic signature.",
    "",
    "## Copywriting requirements",
    `- Write all visible copy in Mongolian Cyrillic, specific to "${businessName}".`,
    "- Invent plausible service names, real-feeling prices in tugriks (₮), and concrete details that fit the description.",
    "- If you write testimonials, use Mongolian first names and plausible local business contexts.",
    "- No em dashes anywhere in the copy. Replace with commas, colons, periods, or parentheses.",
    "- No buzzwords like 'revolutionary', 'cutting-edge', 'next-generation', 'world-class' unless backed by specifics.",
    "",
    "## Final reminders",
    "- Single-file HTML. Inline CSS and JS. Google Fonts allowed via <link>.",
    "- Start with <!doctype html>. End with </html>.",
    "- No markdown fences. No commentary. Output ONLY the HTML."
  ].join("\n");
}

module.exports = { buildSystemPrompt, buildUserPrompt };
