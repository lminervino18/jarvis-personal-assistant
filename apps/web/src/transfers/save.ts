import { useCallback, useEffect, useRef, useState } from "react";
import { contentUrl, type TransferFile } from "./api.js";

/**
 * Whether this device keeps files through the share sheet: on an iPhone (and most phones) a plain
 * download from an installed web app goes nowhere, while sharing the file offers «Guardar video» and «Guardar en Archivos».
 */
export function savesBySharing(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.canShare !== "function") return false;
  if (!window.matchMedia?.("(pointer: coarse)").matches) return false;
  try {
    return navigator.canShare({ files: [new File([""], "prueba.jpg", { type: "image/jpeg" })] });
  } catch {
    return false;
  }
}

/** Downloads a Transferencias file into the page, untouched, reporting how much arrived. */
export async function fetchFile(item: Pick<TransferFile, "id" | "name" | "mediaType">, onProgress: (fraction: number) => void): Promise<File> {
  const response = await fetch(contentUrl(item.id), { credentials: "same-origin" });
  if (!response.ok || !response.body) throw new Error("download failed");
  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (total) onProgress(Math.min(1, received / total));
        controller.enqueue(chunk);
      },
    }),
  );
  const blob = await new Response(counted).blob();
  return new File([blob], item.name, { type: item.mediaType || "application/octet-stream" });
}

export type SaveState = { phase: "idle" } | { phase: "preparing"; progress: number } | { phase: "ready" } | { phase: "saved" } | { phase: "failed" };

/**
 * Saving a Transferencias file on a phone: the first tap brings the original into the page and opens
 * the share sheet; when the download took too long for the browser to allow it, the next tap opens it right away.
 */
export function useSaveToDevice(item: Pick<TransferFile, "id" | "name" | "mediaType">) {
  const [state, setState] = useState<SaveState>({ phase: "idle" });
  const file = useRef<File | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      file.current = null;
    };
  }, []);

  const share = useCallback(async (ready: File) => {
    try {
      await navigator.share({ files: [ready] });
      if (alive.current) setState({ phase: "saved" });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (alive.current) setState(name === "AbortError" || name === "NotAllowedError" ? { phase: "ready" } : { phase: "failed" });
    }
  }, []);

  const save = useCallback(async () => {
    if (file.current) return share(file.current);
    if (state.phase === "preparing") return;
    setState({ phase: "preparing", progress: 0 });
    try {
      file.current = await fetchFile(item, (progress) => alive.current && setState({ phase: "preparing", progress }));
    } catch {
      if (alive.current) setState({ phase: "failed" });
      return;
    }
    if (alive.current) await share(file.current);
  }, [item, share, state.phase]);

  return { state, save };
}
