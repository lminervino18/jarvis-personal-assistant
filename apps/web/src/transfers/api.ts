export interface TransferFile {
  id: string;
  origin: "phone" | "computer" | "link";
  sender?: string;
  name: string;
  mediaType: string;
  size: number;
  createdAt: string;
  expiresAt: string;
  /** Whether the server can show it small: a photo or a video. */
  preview: "image" | "video" | null;
}

export interface UploadLink {
  id: string;
  label?: string;
  createdAt: string;
  expiresAt: string;
}

export interface TransfersState {
  items: TransferFile[];
  links: UploadLink[];
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
  json<{ name: string; mediaType: string; size: number; expiresAt: string; ownerName: string; preview: "image" | "video" | null }>(`/api/public/files/${encodeURIComponent(token)}`);

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
