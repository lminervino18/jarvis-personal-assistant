import { MemoryStore, type Memory } from "../memory/memory-store.js";
import { fail, ok } from "./envelope.js";
import { defineTool } from "./types.js";

const SOURCE = { provider: "memory" };

function present(memory: Memory) {
  return {
    id: memory.id,
    content: memory.content,
    category: memory.category,
    status: memory.status,
    provenance: { type: memory.sourceType, ref: memory.sourceRef, account: memory.account },
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

export const memorySearch = defineTool({
  name: "memory_search",
  description:
    "Busca memorias guardadas sobre el dueño (preferencias, hechos, personas, rutinas). Devuelve fragmentos con procedencia. Usá texto libre; para listar todo, usá una consulta general como 'todo'.",
  async execute(ctx, input) {
    const store = new MemoryStore(ctx.services.db);
    const memories = store.search(input.query, { category: input.category, limit: input.limit });
    return ok(SOURCE, memories.map(present), {
      coverage: { note: "Memorias guardadas en la base. El perfil base del dueño está en el prompt de sistema." },
    });
  },
});

export const memoryUpdate = defineTool({
  name: "memory_update",
  description:
    "Guarda o corrige una memoria cuando el dueño lo pide explícitamente ('acordate de que…', 'anotá que…'). Guardá solo lo que dijo el dueño. Para corregir una existente, pasá replacesMemoryId.",
  describe(_ctx, input) {
    return {
      title: input.replacesMemoryId ? "Corregir memoria" : "Guardar memoria",
      summary: input.content,
      details: [{ label: "Categoría", value: input.category }],
    };
  },
  async execute(ctx, input) {
    const store = new MemoryStore(ctx.services.db);
    if (input.replacesMemoryId) {
      const updated = store.update(input.replacesMemoryId, input.content, ctx.turnId, ctx.now());
      if (!updated) return fail("not_found", "No existe una memoria con ese id.");
      return ok(SOURCE, [present(updated)], { note: "Memoria actualizada con historial de cambios." });
    }
    const duplicate = store.findDuplicate(input.content);
    if (duplicate) return ok(SOURCE, [present(duplicate)], { note: "Ya estaba guardada; no se duplicó." });
    const created = store.create(
      { content: input.content, category: input.category, sourceType: "owner_statement", sourceRef: ctx.turnId, turnId: ctx.turnId },
      ctx.now(),
    );
    return ok(SOURCE, [present(created)], { note: "Memoria guardada." });
  },
});

export const memoryForget = defineTool({
  name: "memory_forget",
  description:
    "Elimina una memoria cuando el dueño pide olvidarla. Primero identificala con memory_search; si hay varias candidatas, preguntá cuál.",
  describe(ctx, input) {
    const memory = new MemoryStore(ctx.services.db).get(input.memoryId);
    return {
      title: "Olvidar memoria",
      summary: memory?.content ?? "Memoria inexistente",
      details: input.reason ? [{ label: "Motivo", value: input.reason }] : [],
    };
  },
  async execute(ctx, input) {
    const store = new MemoryStore(ctx.services.db);
    const forgotten = store.forget(input.memoryId, input.reason, ctx.turnId, ctx.now());
    if (!forgotten) return fail("not_found", "No existe una memoria con ese id.");
    return ok(SOURCE, [{ id: forgotten.id, forgotten: true }], {
      note:
        `Memoria eliminada de la base y su texto borrado del historial de auditoría. ` +
        `Las fuentes originales (correos o chats) no se tocan. ` +
        `Los backups cifrados existentes la conservan hasta su rotación (${ctx.services.backupRetentionDays} días).`,
    });
  },
});

export const memoryTools = [memorySearch, memoryUpdate, memoryForget];
