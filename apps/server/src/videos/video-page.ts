import { REFERENCE_CSS } from "../pages/design-guide.js";
import type { VideoVersion } from "./video-store.js";

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function key(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "opcion"
  );
}

const SCRIPT = `
document.querySelector("form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const status = form.querySelector("[role=status]");
  const data = Object.fromEntries(new FormData(form));
  if (!data.opcion && !String(data.respuesta || "").trim()) { status.textContent = "Elegí una opción o escribí una respuesta."; return; }
  button.disabled = true; button.textContent = "Enviando…"; status.textContent = "";
  try {
    await jarvis.submit(data);
    form.innerHTML = '<p class="q">¡Gracias! Tu respuesta le llegó a Jarvis.</p>';
  } catch {
    button.disabled = false; button.textContent = "Enviar respuesta"; status.textContent = "No se pudo enviar. Probá de nuevo.";
  }
});`;

/**
 * The interactive version of a video: the MP4 with real buttons around it (pick an option, answer,
 * open the sources, read the facts). Answers carry the video version they refer to and only reach
 * the owner as page answers; nothing here can approve anything.
 */
export function videoPageHtml(version: VideoVersion, owner: string, files: { video: string; poster?: string }): string {
  const { brief } = version;
  const question = brief.scenes.find((scene) => scene.type === "question");
  const options = question?.type === "question" ? question.options : [];
  const vertical = brief.format === "vertical";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escape(brief.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;700&display=swap">
<style>
${REFERENCE_CSS}
body { background: radial-gradient(120% 60% at 10% 0%, var(--uv-mist), var(--white) 60%); }
video { display: block; width: 100%; ${vertical ? "max-height: 72svh; aspect-ratio: 9 / 16;" : "aspect-ratio: 16 / 9;"} object-fit: contain; border-radius: 22px; background: var(--uv-mist); }
.lead { margin: 0; color: var(--muted); font-size: 17px; }
.links { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.links a { display: flex; align-items: center; min-height: 44px; padding: 0 14px; border: 1px solid var(--line); border-radius: 14px; color: var(--uv-deep); font: 500 16px/1.3 var(--display); text-decoration: none; }
details { border-top: 1px solid var(--line); padding-top: 14px; }
summary { cursor: pointer; font: 500 16px/1.3 var(--display); color: var(--uv-deep); min-height: 32px; }
details ul { margin: 10px 0 0; padding-left: 20px; color: var(--muted); }
.foot { margin: 0; color: var(--muted); font-size: 13px; text-align: center; }
[role=status] { margin: 0; color: var(--uv-deep); font-size: 14px; min-height: 1em; }
</style>
</head>
<body>
<main class="stage">
<section class="card">
<p class="kicker">Jarvis · para ${escape(brief.audience)}</p>
<h1>${escape(brief.title)}</h1>
<video src="${escape(files.video)}"${files.poster ? ` poster="${escape(files.poster)}"` : ""} controls playsinline preload="metadata"></video>
<p class="lead">${escape(brief.message)}</p>
<form>
<input type="hidden" name="video_version" value="${version.version}">
${
  options.length && question?.type === "question"
    ? `<p class="q">${escape(question.question)}</p>
<div class="seg">${options.map((option) => `<label><input type="radio" name="opcion" value="${escape(key(option.label))}"><span>${escape(`${option.emoji ? `${option.emoji} ` : ""}${option.label}`)}</span></label>`).join("")}</div>`
    : ""
}
<label><span class="q">${options.length ? "¿Algo más?" : "Tu respuesta"}</span>
<textarea name="respuesta" rows="2" maxlength="500"></textarea></label>
<button class="btn" type="submit">Enviar respuesta</button>
<p role="status"></p>
</form>
${brief.links.length ? `<ul class="links">${brief.links.map((link) => `<li><a href="${escape(link.url)}" target="_blank" rel="noopener noreferrer">${escape(link.label)} ↗</a></li>`).join("")}</ul>` : ""}
${brief.facts.length ? `<details><summary>Más información</summary><ul>${brief.facts.map((fact) => `<li>${escape(fact)}</li>`).join("")}</ul></details>` : ""}
<p class="foot">Mensaje preparado por Jarvis, el asistente personal de ${escape(owner)}.</p>
</section>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
