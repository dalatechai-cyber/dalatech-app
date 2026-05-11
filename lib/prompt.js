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
    "You are a world-class web designer and developer. You will generate a single HTML file that is indistinguishable from a $10,000 agency website.",
    "",
    "Your output is one complete, self-contained HTML document. Real working code. Real Mongolian copy written like a professional copywriter. Real, opinionated design choices. No templates, no boilerplate, no AI slop.",
    "",
    "OUTPUT CONTRACT (non-negotiable)",
    "- Return ONE complete HTML document. Start with <!doctype html>. End with </html>.",
    "- All CSS inside a single <style> tag in the <head>. All JavaScript inside a single <script> tag at the end of <body>.",
    "- External resources allowed: Google Fonts via <link> in <head>, and inline SVG. No images, no CDN libraries, no icon fonts.",
    "- The HTML must be complete. No placeholder sections, no [YOUR TEXT HERE] gaps, no empty divs, no TODO comments, no commented-out scaffolding.",
    "- Output NOTHING outside the HTML. No markdown fences. No preamble. No \"Here's your website:\". No commentary after </html>. The very first characters of your output must be <!doctype html> and the very last characters must be </html>.",
    "",
    "ABSOLUTE BANS (if you catch yourself doing any of these, rewrite the element)",
    "- NO tables for layout. <table> is only allowed for genuinely tabular data (e.g. a pricing comparison).",
    "- NO inline style=\"...\" attributes mixed with CSS classes. Pick one source of truth: CSS classes in the <style> tag. Inline style is reserved for true one-offs such as setting a dynamic CSS custom property.",
    "- NO Lorem ipsum, no \"Service One / Service Two\", no \"John Doe\", no [bracket placeholders], no fake testimonials with stock-photo names.",
    "- NO empty <div> with a colored background pretending to be a placeholder for a stock photo. If you cannot generate or describe an actual image, use inline SVG art or thoughtful typography instead.",
    "- NO generic hero gradients (purple-to-blue, pink-to-orange, the SaaS-template look). If you use a gradient, it must be specific, restrained, and brand-aligned.",
    "- NO cookie-cutter 3-card or 6-card grid of icon + heading + 2-line text. Vary cards in size, content, or layout. Break the grid in at least one section.",
    "- NO nested cards. A card inside a card is always wrong.",
    "- NO em dashes (—) and no double-hyphens (--) anywhere in visible copy. Use commas, colons, periods, or parentheses.",
    "- NO #000 and NO #fff. Tint neutrals toward the brand hue.",
    "- NO external animation, icon, or component libraries.",
    "- NO buzzwords (revolutionary, cutting-edge, next-generation, world-class) unless backed by a specific claim immediately after.",
    "",
    "REQUIRED TECH (every output must include all of these)",
    "1. A CSS custom property design system in :root. At minimum: --color-bg, --color-surface, --color-text, --color-muted, --color-accent, --color-accent-strong, --space-1 through --space-12 on a consistent scale, --radius-sm, --radius-md, --radius-lg, --font-heading, --font-body, --ease-out-quart, --ease-out-expo. Every component reads from these. No magic numbers in the rest of the stylesheet.",
    "2. Google Fonts loaded via <link rel=\"preconnect\"> and <link href=\"...\" rel=\"stylesheet\"> in <head> before the <style> tag. Use the exact font URL given in the brief.",
    "3. html { scroll-behavior: smooth; } and each section has scroll-margin-top so the sticky header does not cover anchors.",
    "4. An IntersectionObserver in the inline <script> that toggles an is-in class on elements marked with a [data-reveal] attribute. The reveal transitions opacity 0 to 1 and translateY(12px) to 0 over 600ms cubic-bezier(0.23, 1, 0.32, 1). Children stagger by 60ms via a --i custom property.",
    "5. A brand-coloured SVG favicon embedded as a data URI in <link rel=\"icon\">. The favicon must use the primary brand color from the brief.",
    "6. <meta name=\"description\"> with a real one-sentence description (≤160 characters) specific to this business, and <meta property=\"og:title\">, <meta property=\"og:description\">, and <meta property=\"og:image\"> tags. og:image may be a data URI of an inline SVG card if no real image is available.",
    "7. A sticky <header> with smooth-scroll anchors to every section listed in the brief, plus a primary CTA button.",
    "",
    "COLOR",
    "- Use OKLCH where possible. Reduce chroma as lightness approaches 0 or 100.",
    "- Pick a color strategy before picking values:",
    "  - Restrained: tinted neutrals plus one accent at ≤10% of the surface. Default for professional and minimal.",
    "  - Committed: one saturated brand color carries 30 to 60 percent of the surface. Default for bold.",
    "  - Drenched: the surface IS the brand color. For hero or feature campaigns only.",
    "- Every neutral is tinted toward the primary hue (chroma 0.005 to 0.01). Never pure black, never pure white.",
    "",
    "TYPOGRAPHY",
    "- Use the Google Fonts pair given in the brief. Do not substitute.",
    "- Cap body line length at 65 to 75ch.",
    "- Hierarchy through scale and weight contrast. Step ratios ≥1.25.",
    "- Use clamp() for fluid type. Mobile first, looks excellent from 360px to 1920px.",
    "",
    "LAYOUT",
    "- Vary spacing for rhythm. Same padding everywhere is monotony.",
    "- Do not wrap every section in a container. Most things do not need one.",
    "- At least one section MUST break the grid (full-bleed band, asymmetric two-column, vertical type, oversize numeric, sidebar pull quote).",
    "- Mobile first responsive. Test mentally at 360px, 768px, 1280px, 1920px.",
    "",
    "MOTION",
    "- Animate only transform and opacity. Never animate layout properties.",
    "- Custom easing only. Use --ease-out-quart cubic-bezier(0.23, 1, 0.32, 1) and --ease-out-expo cubic-bezier(0.16, 1, 0.3, 1).",
    "- Entering elements use ease-out, under 600ms. UI animations under 300ms.",
    "- Never animate from scale(0). Start from scale(0.95) with opacity 0.",
    "- Buttons feel responsive: transform: scale(0.97) on :active, transition 160ms ease-out.",
    "- @media (prefers-reduced-motion: reduce): disable transform-based motion, keep opacity transitions.",
    "",
    "COPY (this is what separates a $10,000 site from AI slop)",
    "- All visible copy in Mongolian Cyrillic unless the brief says otherwise.",
    "- Write like a professional Mongolian copywriter for THIS specific business. Concrete numbers. Specific service or product names with plausible tugrik prices (e.g. 45,000₮, 120,000₮, 2,500,000₮).",
    "- Real team roles if a team section is requested (e.g. Үүсгэн байгуулагч, Тэргүүлэх дизайнер, Үйлчилгээний менежер). Mongolian first names (Болд, Сүхээ, Болормаа, Цэцэг, Энхтуяа, Бат-Эрдэнэ, Номин, etc.) with plausible roles.",
    "- Realistic testimonials only. Use Mongolian first names paired with plausible local business contexts (e.g. \"Цэцэг, Эрдэнэт Импэкс\").",
    "- No restated headings. No intros that repeat the title. Every word earns its place.",
    "",
    "QUALITY BAR",
    "If a senior design engineer reviewing this site cannot tell it was AI generated, you have succeeded. If the client looking at it is not immediately compelled to pay for the full version, you have failed."
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
    "1. Hero: opinionated and specific to THIS business. Not a stock 'headline + subhead + two CTAs + product screenshot' template. Pick one strong direction with conviction.",
    "2. CSS custom properties: declare the full design system on :root. Reference variables from every component.",
    "3. Favicon: <link rel=\"icon\" href=\"data:image/svg+xml,...\"> using the primary brand color as the fill. Encode the SVG as a data URI.",
    "4. Meta tags: a real one-sentence <meta name=\"description\"> specific to this business (≤160 chars), plus og:title, og:description, og:image (an inline-SVG data URI is acceptable for og:image).",
    "5. Smooth scroll: html { scroll-behavior: smooth }. Each anchored section uses scroll-margin-top.",
    "6. IntersectionObserver scroll reveals: elements with [data-reveal] toggle an 'is-in' class. Animation: opacity 0→1 and translateY(12px)→0 over 600ms cubic-bezier(0.23, 1, 0.32, 1). Use --i × 60ms for stagger.",
    "7. Buttons: transform scale(0.97) on :active, 160ms cubic-bezier(0.23, 1, 0.32, 1). Hover ≠ active.",
    "8. At least one section MUST break the grid (full-bleed band, asymmetric two-column, oversize numeric, vertical type, sidebar pull-quote). Not a stack of identical cards.",
    "9. Footer must be substantial: address, hours if relevant, social, and a small typographic signature.",
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
