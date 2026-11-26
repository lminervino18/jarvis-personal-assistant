export interface TransferFile {
  id: string;
  origin: "phone" | "computer" | "link" | "download";
  sender?: string;
  name: string;
  mediaType: string;
  size: number;
  createdAt: string;
  expiresAt: string;
  /** How it can be shown: a photo or video has a small preview, music plays; anything else only downloads. */
  preview: "image" | "video" | "audio" | null;
}

export interface UploadLink {
  id: string;
  label?: string;
  createdAt: string;
  expiresAt: string;
}

/** What a job produces: a video the iPhone keeps in Photos, the best the site has, or only the audio. */
export type MediaFormat = "iphone" | "max" | "mp3" | "m4a";

/** A download from YouTube, X or Instagram, or the conversion of a file already in Transferencias. */
export interface MediaJob {
  id: string;
  source: "link" | "search" | "transfer";
  /** The link, the words searched, or the id of the file being converted. */
  target: string;
  /** What the owner reads: the link without its prefix, the words searched, or the file's name. */
  label: string;
  site: string;
  format: MediaFormat;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  error?: string;
  /** When a download YouTube blocked is tried again. */
  retryAt?: string;
  /** Who gets the file when it is ready. */
  sendTo?: string;
}

export interface TransfersState {
  items: TransferFile[];
  links: UploadLink[];
  /** Downloads and conversions; null when the server cannot do them. */
  jobs: MediaJob[] | null;
}

export const contentUrl = (id: string) => `/api/transfers/${id}/content`;
export const previewUrl = (id: string, size: "thumb" | "large") => `/api/transfers/${id}/preview?size=${size}`;

async function json<T>(url: string, init: RequestInit = {}): Promise<T | null> {
  const response = await fetch(url, { credentials: "same-origin", ...init }).catch(() => null);
  return response?.ok ? ((await response.json()) as T) : null;
}

export const fetchTransfers = () => json<TransfersState>("/api/transfers");

export async function deleteTransfer(id: string): Promise<boolean> {
  return (await json<{ ok: boolean }>(`/api/transfers/${id}`, { method: "DELETE" })) !== null;
}

export const shareTransfer = (id: string) => json<{ url: string; expiresAt: string }>(`/api/transfers/${id}/share`, { method: "POST" });

export const createUploadLink = (label: string | undefined) =>
  json<{ url: string; link: UploadLink }>("/api/transfers/links", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(label ? { label } : {}) });

export async function revokeUploadLink(id: string): Promise<boolean> {
  return (await json<{ ok: boolean }>(`/api/transfers/links/${id}`, { method: "DELETE" })) !== null;
}

export const fetchUploadLink = (token: string) => json<{ ownerName: string; expiresAt: string }>(`/api/public/upload-links/${encodeURIComponent(token)}`);

export const fetchSharedFile = (token: string) =>
  json<{ name: string; mediaType: string; size: number; expiresAt: string; ownerName: string; preview: "image" | "video" | "audio" | null }>(`/api/public/files/${encodeURIComponent(token)}`);

export const sharedContentUrl = (token: string) => `/api/public/files/${encodeURIComponent(token)}/content`;
export const sharedPreviewUrl = (token: string) => `/api/public/files/${encodeURIComponent(token)}/preview?size=large`;

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toLocaleString("es-AR", { maximumFractionDigits: 1 })} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toLocaleString("es-AR", { maximumFractionDigits: 1 })} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** «se borra en 3 h», «se borra en 20 min». */
export function timeLeft(expiresAt: string, now: Date): string {
  const minutes = Math.max(0, Math.round((Date.parse(expiresAt) - now.getTime()) / 60_000));
  return minutes >= 60 ? `${Math.round(minutes / 60)} h` : `${Math.max(1, minutes)} min`;
}

/** A link to download, or else words to search on YouTube. */
export function downloadRequest(text: string): { url: string } | { search: string } {
  const value = text.trim();
  return /^https?:\/\//i.test(value) ? { url: value } : { search: value };
}

async function post(url: string, body: object): Promise<Response | null> {
  return fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
}

/** Asks the server to download a video or its audio; answers an error to show, or null when it started. */
export async function startDownload(text: string, format: MediaFormat): Promise<string | null> {
  const response = await post("/api/transfers/downloads", { ...downloadRequest(text), format });
  if (response?.ok) return null;
  if (response?.status === 400) return "Ese link no es de YouTube, X ni Instagram.";
  return "No pude empezar la descarga. Probá de nuevo.";
}

/** Asks the server to convert a file; answers an error to show, or null when it started. */
export async function convertTransfer(id: string, format: Exclude<MediaFormat, "max">): Promise<string | null> {
  const response = await post(`/api/transfers/${id}/convert`, { format });
  return response?.ok ? null : "No pude empezar la conversión. Probá de nuevo.";
}

export async function cancelDownload(id: string): Promise<boolean> {
  return (await json<{ ok: boolean }>(`/api/transfers/downloads/${id}`, { method: "DELETE" })) !== null;
}
