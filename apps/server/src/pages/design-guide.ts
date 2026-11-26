/** Exact script URLs a generated page may load. The page server's CSP allows nothing else. */
export const ALLOWED_SCRIPTS = [
  "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js",
  "https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js",
] as const;

/** A point on a circle around the core's center, (100, 100) in its 200 × 200 drawing. */
function polar(radius: number, degrees: number): string {
  const angle = ((degrees - 90) * Math.PI) / 180;
  return `${(100 + radius * Math.cos(angle)).toFixed(1)} ${(100 + radius * Math.sin(angle)).toFixed(1)}`;
}

function arc(radius: number, from: number, to: number): string {
  return `M${polar(radius, from)}A${radius} ${radius} 0 0 1 ${polar(radius, to)}`;
}

const ring = (radius: number, attributes: string) => `<circle cx="100" cy="100" r="${radius}" ${attributes}/>`;

/** JARVIS's core as inline SVG behind the content, animated with CSS only (no script), still when reduced motion is set. */
export const CORE = `<div class="core" aria-hidden="true"><svg viewBox="0 0 200 200">
<defs><radialGradient id="heart"><stop offset="0" stop-color="#fff"/><stop offset=".35" stop-color="#8cf2ff" stop-opacity=".95"/><stop offset="1" stop-color="#3fe0ff" stop-opacity="0"/></radialGradient></defs>
<g class="spin">${ring(96, 'stroke-width="3" stroke-dasharray="3.14 3.14" opacity=".45"')}</g>
${ring(89, 'stroke-width=".8" opacity=".35"')}
${ring(84, 'stroke-width="5" stroke-dasharray=".7 6.6" opacity=".45"')}
<g class="spin-back">${[0, 120, 240].map((start) => `<path d="${arc(70, start, start + 78)}" stroke="#8cf2ff" stroke-width="4" stroke-linecap="round" opacity=".85"/>`).join("")}</g>
<g class="spin-fast">${[40, 220].map((start) => `<path d="${arc(62, start, start + 110)}" stroke-width="1.4" opacity=".6"/>`).join("")}</g>
${ring(40, 'stroke-width="1.4" opacity=".5"')}
<g class="spin-back">${ring(30, 'stroke="#8cf2ff" stroke-width="7" stroke-dasharray="13.6 5.25" opacity=".7"')}</g>
<g class="pulse">${ring(21, 'fill="url(#heart)" stroke="none"')}</g>
${ring(9, 'fill="#fff" stroke="none" opacity=".9"')}
</svg></div>`;

export const REFERENCE_CSS = `:root {
  --bg: #02070d; --bg-glow: #06293a; --panel: rgba(5, 22, 33, .74); --text: #e8fbff; --muted: #8db2c3;
  --accent: #3fe0ff; --accent-strong: #8cf2ff; --accent-soft: rgba(63, 224, 255, .12); --line: rgba(63, 224, 255, .3); --on-accent: #00141c;
  --display: "Space Grotesk", "Inter", system-ui, sans-serif; --text-font: "Inter", system-ui, -apple-system, sans-serif;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; color-scheme: dark; }
body { margin: 0; min-height: 100svh; color: var(--text); font: 16px/1.5 var(--text-font);
  background: linear-gradient(var(--accent-soft) 1px, transparent 1px) 0 0 / 44px 44px, linear-gradient(90deg, var(--accent-soft) 1px, transparent 1px) 0 0 / 44px 44px,
    radial-gradient(90% 60% at 50% 30%, var(--bg-glow), var(--bg) 72%) fixed; background-color: var(--bg); }
.core { position: fixed; z-index: 0; left: 50%; top: 40%; width: min(130vw, 760px); aspect-ratio: 1; translate: -50% -50%; opacity: .5; pointer-events: none; }
.core svg { width: 100%; height: 100%; overflow: visible; fill: none; stroke: var(--accent); }
.core g { transform-box: view-box; transform-origin: 50% 50%; }
.spin { animation: spin 26s linear infinite; } .spin-back { animation: spin 18s linear infinite reverse; } .spin-fast { animation: spin 11s linear infinite; }
.pulse { animation: pulse 2.6s ease-in-out infinite; }
@keyframes spin { to { rotate: 360deg; } } @keyframes pulse { 50% { scale: 1.12; opacity: .8; } }
.stage { position: relative; z-index: 1; max-width: 560px; margin: 0 auto;
  padding: calc(env(safe-area-inset-top) + 40px) max(16px, env(safe-area-inset-right)) calc(env(safe-area-inset-bottom) + 40px) max(16px, env(safe-area-inset-left)); }
.card { display: grid; gap: 22px; padding: 28px 22px; border: 1px solid var(--line); border-radius: 16px;
  background: linear-gradient(var(--accent), var(--accent)) top left / 22px 2px no-repeat, linear-gradient(var(--accent), var(--accent)) top left / 2px 22px no-repeat,
    linear-gradient(var(--accent), var(--accent)) top right / 22px 2px no-repeat, linear-gradient(var(--accent), var(--accent)) top right / 2px 22px no-repeat,
    linear-gradient(var(--accent), var(--accent)) bottom left / 22px 2px no-repeat, linear-gradient(var(--accent), var(--accent)) bottom left / 2px 22px no-repeat,
    linear-gradient(var(--accent), var(--accent)) bottom right / 22px 2px no-repeat, linear-gradient(var(--accent), var(--accent)) bottom right / 2px 22px no-repeat, var(--panel);
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); box-shadow: 0 0 70px -28px rgba(63, 224, 255, .45), inset 0 0 50px rgba(63, 224, 255, .05); }
.kicker { display: flex; align-items: center; gap: 8px; margin: 0; font: 500 12px/1 var(--display); letter-spacing: .18em; text-transform: uppercase; color: var(--accent); }
.kicker::before { content: ""; width: 7px; height: 7px; background: var(--accent); box-shadow: 0 0 10px var(--accent); }
h1 { margin: 0; font: 700 clamp(34px, 10vw, 56px)/1 var(--display); letter-spacing: -.03em; text-wrap: balance; }
.pills { display: flex; flex-wrap: wrap; gap: 8px; }
.pill { padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--accent-soft); color: var(--accent-strong); font: 500 14px/1.3 var(--display); }
.q { margin: 0 0 8px; font: 500 17px/1.3 var(--display); }
.seg { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: 4px; padding: 4px; border: 1px solid var(--line); border-radius: 14px; background: var(--accent-soft); }
.seg input { position: absolute; opacity: 0; }
.seg span { display: grid; place-items: center; min-height: 44px; padding: 0 8px; border-radius: 10px; text-align: center; cursor: pointer; transition: background .25s, color .25s, box-shadow .25s; }
.seg input:checked + span { background: var(--accent); color: var(--on-accent); box-shadow: 0 0 18px -4px var(--accent); }
input[type=text], input[type=email], input[type=tel], input[type=number], input[type=date], input[type=time], textarea, select {
  width: 100%; min-height: 48px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: rgba(2, 10, 16, .7); color: var(--text); font: inherit; font-size: 16px; }
.btn { width: 100%; min-height: 52px; border: 0; border-radius: 12px; background: linear-gradient(135deg, var(--accent-strong), var(--accent)); color: var(--on-accent); font: 700 16px/1 var(--display); cursor: pointer; box-shadow: 0 0 30px -8px var(--accent); }
.btn:disabled { opacity: .6; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }`;

/**
 * System prompt for the page writer: the JARVIS HUD identity (deep navy, cyan light, HUD
 * panels and JARVIS's core behind them), phone-first rules, the allowed libraries and the
 * response contract the page server provides.
 */
export const PAGE_SYSTEM_PROMPT = `You design and code single-file web pages for one person, the owner of the J.A.R.V.IS assistant. People open them on their phones from a WhatsApp link. Reply with ONE complete HTML document and nothing else: start with <!doctype html>, end with </html>, no markdown fences, no comments about it.

# Visual identity: JARVIS HUD (always)
- Like JARVIS's interface in Iron Man: deep navy background with a faint grid, cyan light, white text. Clean and precise, never busy.
- Background: JARVIS's core below, fixed behind the content and animated with CSS. Keep it unless the brief asks for no animation.
- Content sits in one HUD panel (.card, dark glass with cyan corner brackets) or a short stack of them, centered on a column of max 560px.
- Fonts: Space Grotesk for headings, kickers and buttons, Inter for text, from Google Fonts only:
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;700&display=swap">
- Start from this CSS and extend it; keep its tokens and components (kicker, h1, pills, segmented choices .seg, inputs, .btn). Keep everything dark: no white backgrounds.
<style>
${REFERENCE_CSS}
</style>
- The core (copy it as is, right after <body>):
${CORE}

# Phone first
- Design for a 390px-wide phone first; it must also look good on a laptop. One column, no horizontal scroll, safe-area padding as in .stage.
- Tap targets at least 44px tall; form fields at 16px font (so iOS does not zoom); labels above fields; native inputs (date, time, email, tel) when they fit.
- The first screen shows the title and the main action without scrolling when possible. Short copy.
- Keep it light: total HTML under 120 KB, no images unless the brief gives a URL; use CSS, SVG or the core instead.
- Animations: subtle, transform/opacity only, and none when prefers-reduced-motion is set.

# Scripts
- Only these script URLs are allowed (anything else is blocked):
${ALLOWED_SCRIPTS.map((url) => `  - ${url}`).join("\n")}
- Inline <script> is fine. No other hosts, no iframes, no analytics, no external stylesheets except Google Fonts.

# Forms and answers
- If the page asks anything (RSVP, survey, sign-up, poll), send answers with \`await jarvis.submit(data)\`. The page server defines \`jarvis.submit\`; do not define it. It returns a promise and rejects on failure.
- \`data\` is a flat object with snake_case Spanish keys (for example { nombre, viene, trae, comentario }). Values are strings, numbers, booleans or arrays of strings.
- While sending, disable the button and show "Enviando…". On success, replace the form with a short thank-you state (canvas-confetti is allowed for a small celebration). On failure, keep the answers and show "No se pudo enviar. Probá de nuevo." with the button enabled again.
- Ask for a name only when the brief implies answers from several people. Never ask for passwords, card numbers, documents or other sensitive data.

# Content
- Write in Rioplatense Spanish with voseo, warm and short, as the owner would.
- Use only facts from the brief (dates, places, names). If something is missing, leave it out or phrase it neutrally; never invent addresses, prices or times.
- No links unless the brief gives them. Set <html lang="es">, a real <title>, and <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">.

# Updates
- When you get the current page and a change request, return the full updated page, keeping everything the change does not touch.`;
