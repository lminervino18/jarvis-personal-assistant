export type UploadOutcome = { ok: true; id: string; name: string } | { ok: false; message: string };

const MAX_BYTES = 10 * 1024 * 1024;

/** The marker the assistant reads to pass attachment ids to task_create. */
export function attachmentLine(id: string, name: string): string {
  return `[adjunto ${id} ${name}]`;
}

export function uploadMessage(status: number): string {
  if (status === 401) return "La sesión venció. Volvé a entrar.";
  if (status === 404) return "Las tareas delegadas no están configuradas en el servidor.";
  if (status === 413) return "El archivo es demasiado grande (máximo 10 MB).";
  return "No pude subir el archivo.";
}

/** Uploads a file for a future task. It stays unassigned until a task_create uses its id. */
export async function uploadAttachment(file: File): Promise<UploadOutcome> {
  if (file.size === 0) return { ok: false, message: "El archivo está vacío." };
  if (file.size > MAX_BYTES) return { ok: false, message: uploadMessage(413) };
  try {
    const response = await fetch(`/api/tasks/attachments?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!response.ok) return { ok: false, message: uploadMessage(response.status) };
    const body = (await response.json()) as { id: string; name: string };
    return { ok: true, id: body.id, name: body.name };
  } catch {
    return { ok: false, message: "No hay conexión con el servidor." };
  }
}
