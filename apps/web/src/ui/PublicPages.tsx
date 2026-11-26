import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { Core } from "../core/Core.js";
import { fetchSharedFile, fetchUploadLink, formatSize, sharedContentUrl, sharedPreviewUrl } from "../transfers/api.js";
import { UploadQueue } from "../transfers/uploads.js";
import { formatDateTime } from "../format.js";
import { UploadProgress } from "./TransfersScreen.js";

const QUIET = () => ({ input: 0, output: 0 });

/** Which public page a path asks for: someone uploading with a link, or downloading a shared file. */
export function publicRoute(pathname: string): { page: "upload" | "download"; token: string } | undefined {
  const match = pathname.match(/^\/(subir|bajar)\/([\w-]{20,40})\/?$/);
  if (!match) return undefined;
  return { page: match[1] === "subir" ? "upload" : "download", token: match[2] as string };
}

function Expired({ text }: { text: string }) {
  return (
    <main className="public-page">
      <div className="public-card">
        <Core state="idle" label="Jarvis" getLevels={QUIET} />
        <h1>Este link ya no sirve</h1>
        <p>{text}</p>
      </div>
    </main>
  );
}

/** The page someone opens to send files to the owner in their original quality, without an account. */
export function PublicUpload({ token }: { token: string }) {
  const [link, setLink] = useState<{ ownerName: string; expiresAt: string } | null | "loading">("loading");
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const queue = useMemo(() => new UploadQueue(() => ({ "upload-link": token })), [token]);
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const uploading = items.some((item) => item.status === "uploading");
  const done = items.filter((item) => item.status === "done").length;

  useEffect(() => void fetchUploadLink(token).then(setLink), [token]);

  if (link === "loading") return <main className="public-page" aria-busy="true" />;
  if (!link) return <Expired text="Venció o lo revocaron. Pedile uno nuevo a quien te lo mandó." />;

  const add = (files: readonly File[]) => files.length > 0 && queue.add(files);
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    add([...event.dataTransfer.files]);
  };

  return (
    <main
      className="public-page"
      data-dragging={dragging}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => event.currentTarget === event.target && setDragging(false)}
      onDrop={drop}
    >
      <div className="public-card">
        <Core state={uploading ? "thinking" : "idle"} label={uploading ? "Subiendo" : "Listo para recibir"} getLevels={QUIET} />
        <h1>Mandale archivos a {link.ownerName}</h1>
        <p>Fotos, videos o lo que quieras, en calidad original. El link vence el {formatDateTime(link.expiresAt)}.</p>
        <button type="button" className="button primary public-pick" onClick={() => picker.current?.click()}>
          {items.length > 0 ? "Elegir más archivos" : "Elegir archivos"}
        </button>
        <input ref={picker} type="file" multiple hidden onChange={(event) => (add([...(event.target.files ?? [])]), (event.target.value = ""))} />
        <p className="public-hint" role="status">
          {uploading
            ? "Dejá esta página abierta hasta que termine. Si se corta, volvé a elegir el mismo archivo y sigue desde donde quedó."
            : done > 0
              ? `${done === 1 ? "Llegó 1 archivo" : `Llegaron ${done} archivos`}. ¡Gracias!`
              : dragging
                ? "Soltalos acá"
                : "También podés arrastrarlos a esta página."}
        </p>
        <UploadProgress queue={queue} />
      </div>
    </main>
  );
}

/** The page someone opens to download a file the owner shared, in its original quality. */
export function PublicDownload({ token }: { token: string }) {
  const [file, setFile] = useState<Awaited<ReturnType<typeof fetchSharedFile>> | "loading">("loading");
  useEffect(() => void fetchSharedFile(token).then(setFile), [token]);

  if (file === "loading") return <main className="public-page" aria-busy="true" />;
  if (!file) return <Expired text="El archivo se borró: los archivos compartidos duran 24 horas." />;

  return (
    <main className="public-page">
      <div className="public-card public-file">
        {file.preview === "image" && <img src={sharedPreviewUrl(token)} alt={file.name} />}
        {file.preview === "video" && <video src={sharedContentUrl(token)} controls playsInline preload="metadata" />}
        {file.preview === "audio" && <audio src={sharedContentUrl(token)} controls preload="metadata" />}
        {(!file.preview || file.preview === "audio") && <Core state="idle" label="Jarvis" getLevels={QUIET} />}
        <h1>{file.name}</h1>
        <p>
          {formatSize(file.size)} · te lo compartió {file.ownerName} · disponible hasta el {formatDateTime(file.expiresAt)}
        </p>
        <a className="button primary public-pick" href={sharedContentUrl(token)} download={file.name}>
          Descargar original
        </a>
      </div>
    </main>
  );
}
