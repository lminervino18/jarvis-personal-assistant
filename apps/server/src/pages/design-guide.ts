/** Exact script URLs a generated page may load. The page server's CSP allows nothing else. */
export const ALLOWED_SCRIPTS = [
  "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js",
  "https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js",
] as const;

const ORB = `<canvas id="orb" aria-hidden="true"></canvas>
<script src="${ALLOWED_SCRIPTS[0]}"></script>
<script>
(() => {
  const canvas = document.getElementById("orb");
  if (!window.THREE) return;
  const small = matchMedia("(max-width: 600px)").matches;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !small, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, small ? 1.5 : 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.z = 6;
  const geometry = new THREE.IcosahedronGeometry(2.2, small ? 3 : 5);
  const base = geometry.attributes.position.array.slice();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x5b2bff, wireframe: true, transparent: true, opacity: 0.35 }));
  const glow = new THREE.Mesh(new THREE.SphereGeometry(1.7, 32, 32), new THREE.MeshBasicMaterial({ color: 0xc9b8ff, transparent: true, opacity: 0.35 }));
  scene.add(glow, mesh);
  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.x = w < 600 ? 0 : -1.2;
    camera.updateProjectionMatrix();
  };
  addEventListener("resize", resize);
  resize();
  const p = geometry.attributes.position;
  let running = true;
  document.addEventListener("visibilitychange", () => { running = !document.hidden; if (running && !still) requestAnimationFrame(frame); });
  function frame(time) {
    const t = time / 1000;
    for (let i = 0; i < p.count; i++) {
      const x = base[i * 3], y = base[i * 3 + 1], z = base[i * 3 + 2];
      const k = 1 + 0.06 * Math.sin(x * 1.8 + t * 1.3) * Math.cos(y * 1.6 + t);
      p.setXYZ(i, x * k, y * k, z * k);
    }
    p.needsUpdate = true;
    mesh.rotation.y = t * 0.12;
    renderer.render(scene, camera);
    if (running && !still) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
</script>`;

const REFERENCE_CSS = `:root {
  --white: #ffffff; --ink: #0b0a12; --uv: #5b2bff; --uv-deep: #3a12d6; --uv-mist: #f1ecff; --muted: #5d5873; --line: #e4e0f0;
  --display: "Space Grotesk", "Inter", system-ui, sans-serif; --text: "Inter", system-ui, -apple-system, sans-serif;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; min-height: 100svh; background: var(--white); color: var(--ink); font: 16px/1.5 var(--text); }
#orb { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 0; }
.stage { position: relative; z-index: 1; max-width: 560px; margin: 0 auto;
  padding: calc(env(safe-area-inset-top) + 40px) max(16px, env(safe-area-inset-right)) calc(env(safe-area-inset-bottom) + 40px) max(16px, env(safe-area-inset-left)); }
.card { display: grid; gap: 22px; padding: 28px 22px; border: 1px solid rgba(91, 43, 255, .18); border-radius: 28px;
  background: rgba(255, 255, 255, .8); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); box-shadow: 0 30px 80px -30px rgba(58, 18, 214, .35); }
.kicker { margin: 0; font: 500 13px/1 var(--display); letter-spacing: .1em; text-transform: uppercase; color: var(--uv-deep); }
h1 { margin: 0; font: 700 clamp(34px, 10vw, 56px)/1 var(--display); letter-spacing: -.03em; text-wrap: balance; }
.pills { display: flex; flex-wrap: wrap; gap: 8px; }
.pill { padding: 6px 12px; border-radius: 999px; background: var(--uv-mist); color: var(--uv-deep); font: 500 14px/1.3 var(--display); }
.q { margin: 0 0 8px; font: 500 17px/1.3 var(--display); }
.seg { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: 4px; padding: 4px; border-radius: 16px; background: var(--uv-mist); }
.seg input { position: absolute; opacity: 0; }
.seg span { display: grid; place-items: center; min-height: 44px; padding: 0 8px; border-radius: 12px; text-align: center; cursor: pointer; transition: background .25s, color .25s, box-shadow .25s; }
.seg input:checked + span { background: var(--white); color: var(--uv-deep); box-shadow: 0 4px 14px -6px rgba(58, 18, 214, .5); }
input[type=text], input[type=email], input[type=tel], input[type=number], textarea, select {
  width: 100%; min-height: 48px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 14px; background: var(--white); font: inherit; font-size: 16px; }
.btn { width: 100%; min-height: 52px; border: 0; border-radius: 16px; background: linear-gradient(135deg, var(--uv), var(--uv-deep)); color: var(--white); font: 600 16px/1 var(--display); cursor: pointer; }
.btn:disabled { opacity: .6; }
:focus-visible { outline: 2px solid var(--uv); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }`;

/**
 * System prompt for the page writer: the owner's "Pulso" identity (white, ultraviolet and
 * black, a breathing three.js orb behind a glass card), phone-first rules, the allowed
 * libraries and the response contract the page server provides.
 */
export const PAGE_SYSTEM_PROMPT = `You design and code single-file web pages for one person, the owner of the J.A.R.V.IS assistant. People open them on their phones from a WhatsApp link. Reply with ONE complete HTML document and nothing else: start with <!doctype html>, end with </html>, no markdown fences, no comments about it.

# Visual identity: "Pulso" (always)
- White page, black text, ultraviolet details. Simple and calm, never busy.
- Background: the ultraviolet three.js orb below, fixed behind the content. Keep it unless the brief asks for no animation.
- Content sits in one glass card (or a short stack of them) centered on a column of max 560px.
- Fonts: Space Grotesk for headings and buttons, Inter for text, from Google Fonts only:
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;700&display=swap">
- Start from this CSS and extend it; keep its tokens and components (kicker, h1, pills, segmented choices .seg, inputs, .btn):
<style>
${REFERENCE_CSS}
</style>
- The orb (copy it as is, right after <body>):
${ORB}

# Phone first
- Design for a 390px-wide phone first; it must also look good on a laptop. One column, no horizontal scroll, safe-area padding as in .stage.
- Tap targets at least 44px tall; form fields at 16px font (so iOS does not zoom); labels above fields; native inputs (date, time, email, tel) when they fit.
- The first screen shows the title and the main action without scrolling when possible. Short copy.
- Keep it light: total HTML under 120 KB, no images unless the brief gives a URL; use CSS, SVG or the orb instead.
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
