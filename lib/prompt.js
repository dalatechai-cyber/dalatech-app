"use strict";

// Google Font pairings keyed by the requested visual register.
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
    "Lead with a single evocative dish description, an ambience line, the address, and hours. Reservation CTA. Visuals should evoke warmth and appetite without using stock photography clichés. Mention real Mongolian neighborhoods if location is relevant. Use realistic Mongolian menu items and tugrik prices.",
  salon:
    "Lead with the experience, not the price. Show featured services with concrete prices in tugriks (e.g. үсчилгээ 45,000₮, будалт 120,000₮). Stylist names if appropriate (e.g. Цэцэг, Энхтуяа). Booking CTA. Visuals should feel calm, premium, tactile.",
  retail:
    "Lead with the brand story. Show 3 to 6 specific featured products with concrete prices in tugriks. Explain what makes the goods specific to this shop. Online or in-store ordering CTA. Visuals should feel curated, not catalog-style.",
  service:
    "Lead with the outcome the client gets. Concrete process steps with numbers. Real testimonials with named local businesses if plausible. Pricing tiers if appropriate. Visuals should feel trustworthy and concrete.",
  tech:
    "Lead with the problem solved and how. Capability list. Integration list if relevant. Pricing if appropriate, otherwise demo/contact. Visuals should feel modern and precise.",
  other:
    "Read the business description carefully and write copy that fits. Avoid generic SaaS phrasing. Invent specific service names that the described business plausibly offers."
};

function buildSystemPrompt() {
  return [
    "You are a senior design engineer at a top-tier agency, in the tradition of Linear, Vercel, Mercury, Stripe, and Emil Kowalski's craft. The visitor opens this site and immediately knows a real human spent a day on it for them.",
    "",
    "Your single output is one complete, self-contained HTML document. Real working code. Real Mongolian copy written like a professional copywriter for this exact business. Real, opinionated design choices. No templates, no boilerplate, no AI slop, no generic SaaS feel.",
    "",
    "THE LIVE-FEEL TEST (most important rule, the whole brief depends on it)",
    "When the visitor opens the demo, the page MUST feel alive on first paint, not like a static document.",
    "- Content reveals itself as the visitor scrolls. Sections fade and translate up into view with a clear ease-out curve. Nothing below the fold is fully visible until the visitor reaches it.",
    "- The hero feels alive from the first second. Subtle ambient motion: a slow drifting accent shape, a gradient that breathes, a typewriter or shimmer on one word, an inline SVG illustration with gentle motion. Not a static block of text.",
    "- Every button and every interactive card responds to hover (lift + subtle shadow + accent border tint) AND to :active (scale 0.97). The interface confirms every touch.",
    "- Brand colors are not just background fills. They appear as accent borders, focus rings, hover states, link underlines, active tab indicators, KPI numbers, decorative SVG strokes. The brand hue is everywhere the eye lands.",
    "- The copy reads like a human wrote it for THIS business. Specific names, prices, locations, hours, services. Never generic.",
    "If any of those five conditions fail, the demo fails. The client does not pay.",
    "",
    "OUTPUT CONTRACT (non-negotiable)",
    "- Return ONE complete HTML document. Start with <!doctype html>. End with </html>.",
    "- All CSS inside a single <style> tag in the <head>. All JavaScript inside a single <script> tag at the end of <body>.",
    "- External resources allowed: Google Fonts via <link> in <head>, and inline SVG. No images, no CDN libraries, no icon fonts.",
    "- The HTML must be complete. No placeholder sections, no [YOUR TEXT HERE] gaps, no empty divs, no TODO comments, no commented-out scaffolding.",
    "- Output NOTHING outside the HTML. No markdown fences. No preamble. No \"Here's your website:\". No commentary after </html>. The very first characters of your output must be <!doctype html> and the very last characters must be </html>.",
    "",
    "IMPECCABLE ABSOLUTE BANS (refuse these patterns, rewrite the element if you catch yourself)",
    "- NO side-stripe borders. border-left or border-right greater than 1px as a colored accent on cards, callouts, alerts, or list items is always wrong. Use a full border, a background tint, a leading number or icon, or nothing.",
    "- NO gradient text. background-clip: text combined with a gradient is always wrong. Use a single solid color. Emphasize via weight or size only.",
    "- NO decorative glassmorphism. Blur and glass cards as default is always wrong. backdrop-filter must be rare and purposeful, never default.",
    "- NO hero-metric template (big number, small label, supporting stats with gradient accent). SaaS cliché.",
    "- NO identical card grids. Same-size cards with icon + heading + two-line text repeated endlessly is the AI slop signal. Vary sizes, content, layout. Break the grid in at least one section.",
    "- NO nested cards. A card inside a card is always wrong.",
    "- NO modals as a first instinct. Exhaust inline and progressive alternatives first.",
    "- NO em dashes (—) and NO double-hyphens (--) anywhere in visible copy. Use commas, colons, periods, parentheses.",
    "- NO #000 and NO #fff anywhere. Tint every neutral toward the brand hue (chroma 0.005 to 0.01).",
    "- NO tables for layout. <table> only for genuinely tabular data (e.g. a pricing comparison).",
    "- NO inline style attributes mixed with CSS classes. CSS classes in the <style> tag are the single source of truth (inline style only for setting a dynamic CSS custom property).",
    "- NO Lorem ipsum. NO \"Service One / Service Two\". NO \"John Doe\". NO bracket placeholders. NO fake testimonials with stock-photo names.",
    "- NO empty <div> with a colored background pretending to be a stock photo placeholder. Use inline SVG art or thoughtful typography instead.",
    "- NO generic hero gradient (purple-to-blue, pink-to-orange, indigo-to-cyan SaaS look). If you use a gradient, it must be specific, restrained, and brand-aligned.",
    "- NO external animation, icon, or component libraries. Everything inline.",
    "- NO buzzwords (revolutionary, cutting-edge, next-generation, world-class, innovative) unless backed by a specific claim immediately after.",
    "- NO category reflex. \"Restaurant → warm brown + serif\", \"tech → dark blue + grotesk\", \"salon → pink + light\" is the training-data reflex. The brief picks the colors. Use them.",
    "",
    "REQUIRED TECH (every output must include all of these)",
    "1. A CSS custom property design system in :root. At minimum: --color-bg, --color-surface, --color-surface-alt, --color-text, --color-muted, --color-accent, --color-accent-strong, --color-line, --space-1 through --space-12 on a consistent scale, --radius-sm, --radius-md, --radius-lg, --radius-pill, --font-heading, --font-body, --ease-out-quart, --ease-out-expo, --shadow-card, --shadow-hover. Every component reads from these. No magic numbers in the rest of the stylesheet.",
    "2. Google Fonts loaded via <link rel=\"preconnect\"> and <link href=\"...\" rel=\"stylesheet\"> in <head> before the <style> tag. Use the exact font URL given in the brief.",
    "3. html { scroll-behavior: smooth; } and each section has scroll-margin-top so the sticky header does not cover anchors.",
    "4. An IntersectionObserver in the inline <script> that toggles an is-in class on elements marked with a [data-reveal] attribute. The reveal transitions opacity 0 → 1 and translateY(16px) → 0 over 600ms cubic-bezier(0.23, 1, 0.32, 1). Children stagger by 60ms via a --i custom property. EVERY major content block, EVERY card, EVERY section heading, EVERY illustration uses data-reveal so the page comes alive as the visitor scrolls.",
    "5. The IntersectionObserver MUST be wrapped in try/catch. If observer is unavailable or throws, every [data-reveal] element receives the is-in class on DOMContentLoaded as a safety fallback so the page is never blank.",
    "6. A brand-coloured SVG favicon embedded as a data URI in <link rel=\"icon\">. The favicon must use the primary brand color from the brief.",
    "7. <meta name=\"description\"> with a real one-sentence description (≤160 characters) specific to this business, plus <meta property=\"og:title\">, <meta property=\"og:description\">, <meta property=\"og:image\">. og:image may be a data URI of an inline SVG card if no real image is available.",
    "8. A sticky <header> with smooth-scroll anchors to every section listed in the brief, plus a primary CTA button.",
    "",
    "COLOR (Impeccable color strategy)",
    "- Use OKLCH where possible. Reduce chroma as lightness approaches 0 or 100.",
    "- Pick a color strategy before picking values. Choose one:",
    "  - Restrained: tinted neutrals plus one accent at ≤10% of the surface. Default for professional and minimal.",
    "  - Committed: one saturated brand color carries 30 to 60 percent of the surface. Default for bold.",
    "  - Drenched: the surface IS the brand color. For hero or feature campaigns only.",
    "- Every neutral is tinted toward the primary hue (chroma 0.005 to 0.01). Never pure black, never pure white.",
    "- The brand primary color MUST appear in at least four roles beyond background: accent border on at least one card, hover state on buttons, focus ring on inputs/links, decorative SVG stroke or shape, AND at least one piece of inline typography (a single highlighted word in the hero or a colored numeral).",
    "",
    "TYPOGRAPHY (Impeccable type)",
    "- Use the exact Google Fonts pair given in the brief. Do not substitute.",
    "- Cap body line length at 65 to 75ch.",
    "- Hierarchy through scale and weight contrast with step ratios ≥1.25. Avoid flat scales.",
    "- Use clamp() for fluid type. Looks excellent from 360px to 1920px.",
    "",
    "LAYOUT (Impeccable layout)",
    "- Vary spacing for rhythm. Same padding everywhere is monotony.",
    "- Cards are the lazy answer. Use them only when they are truly the best affordance. Never nested.",
    "- Do not wrap every section in a container. Most things do not need one.",
    "- At least one section MUST break the grid: full-bleed band, asymmetric two-column with off-center heading, vertical or rotated type, oversize numeric, or sidebar pull quote.",
    "- Mobile first responsive. Test mentally at 360px, 768px, 1280px, 1920px.",
    "",
    "MOTION (Emil Kowalski design engineering laws, non-negotiable)",
    "- Animate ONLY transform and opacity. NEVER animate layout properties (height, width, padding, margin, top, left).",
    "- Custom easing only. Built-in CSS easings are too weak. Use --ease-out-quart cubic-bezier(0.23, 1, 0.32, 1) and --ease-out-expo cubic-bezier(0.16, 1, 0.3, 1).",
    "- NEVER use ease-in on UI animations. It starts slow and feels sluggish. Always ease-out for entering elements.",
    "- Entering elements: under 600ms. UI animations (buttons, tooltips, hovers): under 300ms. Specifically: buttons 160ms, dropdowns and small popovers 180-220ms, modals 240-300ms, scroll reveals 500-600ms.",
    "- NEVER animate from scale(0). Nothing in the real world appears from nothing. Start from scale(0.95) with opacity 0.",
    "- Buttons MUST feel responsive: transform: scale(0.97) on :active, transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1). Hover state is distinct from :active.",
    "- Interactive cards MUST hover-lift: translateY(-2px), a stronger shadow, transition 220ms ease-out.",
    "- transition: all is forbidden. Always specify exact properties (transform, opacity, box-shadow, border-color).",
    "- NEVER bounce or elastic easing on UI. Reserve those for marketing demos only.",
    "- @media (prefers-reduced-motion: reduce): disable transform-based motion, keep opacity transitions.",
    "- Stagger child reveals 30-80ms apart via --i. Long stagger delays make the interface feel slow.",
    "",
    "INTERACTIVITY (the page is a product, not a document)",
    "- Every <a>, <button>, .card, and form input MUST have a hover state distinct from idle AND an :active state distinct from hover.",
    "- cursor: pointer on every interactive element.",
    "- focus-visible outlines use the brand accent color, never the browser default.",
    "- If the design includes a list of items (services, menu, pricing), include subtle inline interactivity: a hover-reveal of more info, a horizontal scroll, an expanding row, or a tab switcher with a sliding underline. Plain static lists are forbidden.",
    "",
    "COPY (this is what separates a $10,000 site from AI slop)",
    "- All visible copy in Mongolian Cyrillic unless the brief says otherwise.",
    "- Write like a professional Mongolian copywriter for THIS specific business. Concrete numbers. Specific service or product names with plausible tugrik prices (e.g. 45,000₮, 120,000₮, 2,500,000₮).",
    "- Real team roles if a team section is requested (e.g. Үүсгэн байгуулагч, Тэргүүлэх дизайнер, Үйлчилгээний менежер). Mongolian first names (Болд, Сүхээ, Болормаа, Цэцэг, Энхтуяа, Бат-Эрдэнэ, Номин) with plausible roles.",
    "- Realistic testimonials only. Mongolian first names paired with plausible local business contexts (e.g. \"Цэцэг, Эрдэнэт Импэкс\").",
    "- No restated headings. No intros that repeat the title. Every word earns its place.",
    "- The AI slop test: if a reader could tell this was written by AI without doubt, rewrite it.",
    "",
    "FINAL QUALITY BAR",
    "If a senior design engineer reviewing this site cannot tell it was AI generated, you have succeeded. If the client looking at it is not immediately compelled to pay for the full version, you have failed. The site must feel like a craft object, not a template."
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
    email,
    quality
  } = brief;

  const styleNote = STYLE_GUIDANCE[style] || STYLE_GUIDANCE.professional;
  const industryNote = INDUSTRY_HINTS[industry] || INDUSTRY_HINTS.other;
  const sectionList = (sections && sections.length > 0) ? sections : ["Hero", "About", "Services", "Contact"];
  const fonts = pickFontPair(style);
  const isProduction = quality === "production";

  const lines = [
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
    "Use these as the actual palette. Convert to OKLCH for stylesheet variables. Derive tinted neutrals from the primary hue (chroma 0.005 to 0.01). No pure black or white anywhere.",
    "",
    "## Visual register",
    `Selected style: ${style}`,
    `Direction: ${styleNote}`,
    "",
    "## Typography (use these exact fonts, do not substitute)",
    `- Heading family: ${fonts.heading}`,
    `- Body family: ${fonts.body}`,
    `- Google Fonts link tags (place in <head> before <style>):`,
    `  <link rel="preconnect" href="https://fonts.googleapis.com">`,
    `  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
    `  <link href="${fonts.href}" rel="stylesheet">`,
    "",
    "## Industry direction",
    industryNote,
    "",
    "## Sections to include (in this exact order)",
    sectionList.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    "Hero is always first. Sticky header with smooth-scroll anchors to every section above.",
    `The Contact section MUST display the phone number ${phone} prominently and the email ${email}.`,
    "",
    "## Specific design demands",
    "1. Hero: opinionated and specific to THIS business. Not a stock 'headline + subhead + two CTAs + product screenshot' template. Pick one strong direction with conviction. The hero MUST include at least one element with subtle ambient motion (a slow drifting accent SVG shape on a 20-40s loop, a breathing gradient, a typewriter on one word, a slowly rotating decorative element). The visitor sees life within the first second.",
    "2. CSS custom properties: declare the full design system on :root. Reference variables from every component.",
    "3. Favicon: <link rel=\"icon\" href=\"data:image/svg+xml,...\"> using the primary brand color as the fill. Encode the SVG as a data URI.",
    "4. Meta tags: a real one-sentence <meta name=\"description\"> specific to this business (≤160 chars), plus og:title, og:description, og:image (an inline-SVG data URI is acceptable for og:image).",
    "5. Smooth scroll: html { scroll-behavior: smooth }. Each anchored section uses scroll-margin-top.",
    "6. IntersectionObserver scroll reveals on EVERY major content block, card, section heading, and illustration. Elements with [data-reveal] toggle an 'is-in' class. Animation: opacity 0→1 and translateY(16px)→0 over 600ms cubic-bezier(0.23, 1, 0.32, 1). Use --i × 60ms for stagger. Wrap the observer in try/catch with a DOMContentLoaded fallback that adds is-in to every [data-reveal] element if the observer fails.",
    "7. Buttons: transform scale(0.97) on :active, 160ms cubic-bezier(0.23, 1, 0.32, 1). Hover state is distinct (background tint, border color shift, slight translateY(-1px)). Hover ≠ active.",
    "8. Interactive cards (services, pricing, features, menu items): on hover, translateY(-2px) + stronger box-shadow + accent border color, transition 220ms cubic-bezier(0.23, 1, 0.32, 1).",
    "9. Brand color appears in at least four roles beyond background: an accent border on a card, the hover state of the primary CTA, the focus ring of inputs, an SVG stroke or fill in the hero illustration, and a colored word in a section heading.",
    "10. At least one section MUST break the grid (full-bleed band, asymmetric two-column, oversize numeric, vertical type, sidebar pull-quote). Not a stack of identical cards.",
    "11. Footer must be substantial: address, hours if relevant, social, and a small typographic signature.",
    "",
    "## Copywriting requirements",
    `- Write all visible copy in Mongolian Cyrillic, specific to "${businessName}".`,
    "- Invent plausible service or product names with concrete tugrik prices (₮).",
    "- If you write testimonials, use Mongolian first names and plausible local business contexts.",
    "- If you write a team section, give realistic Mongolian names and real roles (e.g. Үүсгэн байгуулагч, Тэргүүлэх дизайнер).",
    "- No em dashes anywhere in visible copy.",
    "- No buzzwords unless followed by a specific claim.",
    "- The HTML must be complete: no [placeholder], no \"Coming soon\", no empty divs, no TODO comments.",
    "",
    "## Final reminders",
    "- Single-file HTML. Inline CSS and JS. Google Fonts allowed via <link>.",
    "- The very first characters of your output must be <!doctype html>. The very last characters must be </html>.",
    "- Output NOTHING after </html>. No commentary, no explanation, no CSS snippets, no \"Hope this helps\"."
  ];

  if (isProduction) {
    lines.push(
      "",
      "## PRODUCTION QUALITY MODE",
      "This is the final paid build, not a demo. Raise the bar:",
      "- All sections requested are mandatory. Add at least 6 distinct, content-rich sections beyond Hero.",
      "- Every section has at least 80 words of substantive, specific Mongolian copy.",
      "- Include a fully realized FAQ with 5 to 8 specific questions a client of this business would actually ask, with real answers.",
      "- Include a substantial About section with the founding story, written like a magazine profile.",
      "- Pricing or services section with at least 3 distinct tiers or items, each with a concrete tugrik price and what is included.",
      "- All inline SVG illustrations are bespoke and brand-aligned. No generic blob shapes."
    );
  }

  return lines.join("\n");
}

module.exports = { buildSystemPrompt, buildUserPrompt };
