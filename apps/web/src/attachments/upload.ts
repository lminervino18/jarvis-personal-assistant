import type { Card } from "@jarvis/contracts";

export type AttachmentCard = Extract<Card, { kind: "attachment" }>;
export type ChatUpload = { ok: true; card: AttachmentCard } | { ok: false; message: string };

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_SIDE = 1600;
const SHRINK_ABOVE_BYTES = 1.5 * 1024 * 1024;
const JPEG_QUALITY = 0.85;
const SHRINKABLE = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

function uploadMessage(status: number): string {
  if (status === 401) return "La sesión venció. Volvé a entrar.";
  if (status === 413) return "El archivo es demasiado grande (máximo 10 MB).";
  return "No pude subir el archivo.";
}

function jpegName(name: string): string {
  return `${name.replace(/\.[^.]+$/, "") || "foto"}.jpg`;
}

/**
 * Phone photos are large: an image wider than 1600 px or heavier than 1.5 MB is redrawn as a
 * JPEG, which uploads faster and costs the model fewer tokens. Anything else goes as is.
 */
export async function shrinkImage(file: File): Promise<File> {
  if (!SHRINKABLE.has(file.type) || typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= SHRINK_ABOVE_BYTES && file.type !== "image/heic" && file.type !== "image/heif") return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    return blob ? new File([blob], jpegName(file.name), { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

/** Uploads a file the owner attaches in the chat and returns the card that shows it. */
export async function uploadChatAttachment(original: File): Promise<ChatUpload> {
  if (original.size === 0) return { ok: false, message: "El archivo está vacío." };
  const file = await shrinkImage(original);
  if (file.size > MAX_BYTES) return { ok: false, message: uploadMessage(413) };
  try {
    const response = await fetch(`/api/attachments?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!response.ok) return { ok: false, message: uploadMessage(response.status) };
    const body = (await response.json()) as { id: string; name: string; mediaType: string; size: number };
    return { ok: true, card: { kind: "attachment", attachmentId: body.id, name: body.name, mediaType: body.mediaType, size: body.size } };
  } catch {
    return { ok: false, message: "No hay conexión con el servidor." };
  }
}
