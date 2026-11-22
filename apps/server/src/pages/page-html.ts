import { ALLOWED_SCRIPTS } from "./design-guide.js";

export const MAX_PAGE_BYTES = 200 * 1024;

const FORBIDDEN_TAGS = /<(iframe|object|embed|base|frame|frameset|applet)\b/i;
const REFRESH = /http-equiv\s*=\s*["']?refresh/i;

/** The HTML document inside a model reply, from `<!doctype html>` to the last `</html>`. */
export function extractHtml(reply: string): string | undefined {
  const start = reply.search(/<!doctype html/i);
  const end = reply.toLowerCase().lastIndexOf("</html>");
  if (start < 0 || end < start) return undefined;
  return reply.slice(start, end + "</html>".length);
}

/** Problems that keep a generated page from being published; empty when it is fine. */
export function pageProblems(html: string): string[] {
  const problems: string[] = [];
  if (Buffer.byteLength(html) > MAX_PAGE_BYTES) problems.push(`pesa más de ${MAX_PAGE_BYTES / 1024} KB`);
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    if (!(ALLOWED_SCRIPTS as readonly string[]).includes(match[1] as string)) problems.push(`carga un script no permitido: ${match[1]}`);
  }
  for (const match of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const href = match[1] as string;
    if (/rel\s*=\s*["']?stylesheet/i.test(match[0]) && !href.startsWith("https://fonts.googleapis.com/")) problems.push(`carga una hoja de estilos no permitida: ${href}`);
  }
  if (FORBIDDEN_TAGS.test(html)) problems.push("usa iframe, object, embed o base");
  if (REFRESH.test(html)) problems.push("usa una redirección automática");
  return problems;
}

/** The small runtime every page gets: `jarvis.submit(data)` posts answers to the page server. */
export function withRuntime(html: string, slug: string): string {
  const runtime = `<script>window.jarvis=Object.freeze({submit:async(d)=>{const r=await fetch("/r/${slug}",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(d)});if(!r.ok)throw new Error("submit failed");}});</script>`;
  const head = html.search(/<head[^>]*>/i);
  if (head < 0) return runtime + html;
  const after = html.indexOf(">", head) + 1;
  return `${html.slice(0, after)}${runtime}${html.slice(after)}`;
}
