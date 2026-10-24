import { ContactStore } from "../agenda/contacts-store.js";
import { ok } from "./envelope.js";
import { defineTool } from "./types.js";

const SOURCE = { provider: "contacts" };
const COVERAGE = { note: "Agenda de contactos interna: alias del dueño, WhatsApp, Gmail e importaciones." };

function noteFor(count: number, name: string): string | undefined {
  if (count === 0) return `No hay contactos que coincidan con "${name}". No inventes datos de contacto.`;
  if (count > 1) {
    return `Hay ${count} personas posibles para "${name}". Preguntá al dueño a cuál se refiere antes de cualquier acción y no las combines.`;
  }
  return undefined;
}

export const contactsResolve = defineTool({
  name: "contacts_resolve",
  description:
    "Busca personas en la agenda de contactos por nombre, alias o apodo (ignora tildes y mayúsculas). Devuelve todas las candidatas con sus alias e identidades; si hay más de una, preguntá a cuál se refiere el dueño antes de actuar.",
  async execute(ctx, input) {
    const matches = new ContactStore(ctx.services.db).resolve(input.name);
    const note = noteFor(matches.length, input.name);
    return ok(SOURCE, matches, { coverage: COVERAGE, ...(note ? { note } : {}) });
  },
});

export const contactsTools = [contactsResolve];
