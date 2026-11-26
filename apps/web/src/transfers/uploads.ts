import { Upload, type DetailedError } from "tus-js-client";

const ENDPOINT = "/api/transfers/uploads";
/** Fired on window when one of the owner's uploads finished, so an open Transferencias can refresh. */
export const TRANSFER_ARRIVED = "jarvis:transfer-arrived";
/** Small enough for a slow mobile connection to send each chunk well within the proxy's 3-minute body timeout. */
const CHUNK_BYTES = 4 * 1024 * 1024;
const RETRY_DELAYS = [0, 1000, 3000, 5000, 10_000, 20_000, 30_000];

export type UploadStatus = "uploading" | "done" | "failed";

export interface UploadItem {
  key: string;
  name: string;
  size: number;
  /** Share already on the server, 0 to 1. */
  progress: number;
  status: UploadStatus;
  error?: string;
}

function failure(error: Error): string {
  const status = (error as DetailedError).originalResponse?.getStatus();
  if (status === 507) return "El servidor no tiene lugar para este archivo ahora.";
  if (status === 413) return "Es demasiado grande para subirlo acá.";
  if (status === 401) return "El link venció o ya no sirve.";
  return "Se cortó la subida. Tocá «Reintentar» y sigue desde donde quedó.";
}

/**
 * Files on their way to Transferencias, byte for byte: resumable chunks that survive a dropped
 * connection, a minimized app or a reload (choosing the same file again resumes it). The queue lives
 * outside any screen, so closing one does not stop the uploads.
 */
export class UploadQueue {
  private items: UploadItem[] = [];
  private readonly uploads = new Map<string, Upload>();
  private readonly listeners = new Set<() => void>();

  /** `headers` say who is uploading: the owner's device, or the token of a public upload link. */
  constructor(private readonly headers: () => Record<string, string>) {
    if (typeof document === "undefined") return;
    window.addEventListener("beforeunload", (event) => {
      if (this.busy()) event.preventDefault();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") for (const item of this.items) if (item.status === "failed") this.retry(item.key);
    });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.items;

  /** Whether something is still going up, to warn before leaving the page. */
  busy(): boolean {
    return this.items.some((item) => item.status === "uploading");
  }

  add(files: readonly File[], onDone?: () => void): void {
    for (const file of files) {
      const key = crypto.randomUUID();
      this.items = [{ key, name: file.name, size: file.size, progress: 0, status: "uploading" }, ...this.items];
      const upload = new Upload(file, {
        endpoint: ENDPOINT,
        chunkSize: CHUNK_BYTES,
        retryDelays: RETRY_DELAYS,
        headers: this.headers(),
        metadata: { filename: file.name, filetype: file.type || "application/octet-stream" },
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,
        onProgress: (sent, total) => this.update(key, { progress: total > 0 ? sent / total : 0 }),
        onSuccess: () => {
          this.update(key, { status: "done", progress: 1 });
          onDone?.();
        },
        onError: (error) => this.update(key, { status: "failed", error: failure(error) }),
      });
      this.uploads.set(key, upload);
      void this.begin(upload);
    }
    this.emit();
  }

  retry(key: string): void {
    const upload = this.uploads.get(key);
    if (!upload) return;
    this.update(key, { status: "uploading", error: undefined });
    void this.begin(upload);
  }

  /** Forgets the uploads that already finished. */
  clearDone(): void {
    this.items = this.items.filter((item) => item.status !== "done");
    this.emit();
  }

  private async begin(upload: Upload): Promise<void> {
    const previous = await upload.findPreviousUploads().catch(() => []);
    if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
    upload.start();
  }

  private update(key: string, patch: Partial<UploadItem>): void {
    this.items = this.items.map((item) => (item.key === key ? { ...item, ...patch } : item));
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The owner's own uploads, marked as coming from a computer or from the phone, so only the computer's notify the phone. */
export const ownerUploads = new UploadQueue(() => ({
  "upload-device": typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches ? "computer" : "phone",
}));
