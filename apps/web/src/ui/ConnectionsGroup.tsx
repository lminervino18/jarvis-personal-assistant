import { useEffect, useState, type FormEvent } from "react";
import { disconnect, fetchConnections, GITHUB_CONNECT_URL, gmailConnectUrl, saveVercelToken, VERCEL_TOKENS_URL, type ConnectionsState } from "../connections/api.js";

const GMAIL_LABELS = [
  { label: "personal", name: "Gmail personal" },
  { label: "work", name: "Gmail de trabajo" },
] as const;

/** Gmail, GitHub and Vercel: each one connects with a link, or with a pasted token for Vercel. */
export function ConnectionsGroup({ online }: { online: boolean }) {
  const [state, setState] = useState<ConnectionsState | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => void fetchConnections().then(setState);
  useEffect(refresh, []);

  const saveToken = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const outcome = await saveVercelToken(token.trim());
    setBusy(false);
    setMessage(outcome.ok ? null : outcome.message);
    if (outcome.ok) setToken("");
    refresh();
  };

  const remove = async (provider: "github" | "vercel") => {
    await disconnect(provider);
    refresh();
  };

  if (!state) return null;
  const { gmail, github, vercel } = state;

  return (
    <div className="group">
      {gmail.available &&
        GMAIL_LABELS.map(({ label, name }) => {
          const account = gmail.accounts.find((item) => item.label === label);
          return (
            <div key={label} className="row">
              <span>{name}</span>
              {account?.status === "connected" ? (
                <span className="row-value" data-status="on">
                  {account.email}
                </span>
              ) : (
                <a className="row-link" href={gmailConnectUrl(label)}>
                  {account ? "Reconectar" : "Conectar"}
                </a>
              )}
            </div>
          );
        })}
      <div className="row">
        <span>GitHub</span>
        {github.account ? (
          <span className="row-value" data-status="on">
            {github.account}
          </span>
        ) : github.available ? (
          <a className="row-link" href={GITHUB_CONNECT_URL}>
            Conectar
          </a>
        ) : (
          <span className="row-value">No configurado</span>
        )}
      </div>
      {github.account && (
        <button type="button" className="row row-action row-danger" onClick={() => void remove("github")}>
          Desconectar GitHub
        </button>
      )}

      <div className="row">
        <span>Vercel</span>
        <span className="row-value" data-status={vercel.account ? "on" : "off"}>
          {vercel.account ?? "Sin conectar"}
        </span>
      </div>
      {vercel.account ? (
        <button type="button" className="row row-action row-danger" onClick={() => void remove("vercel")}>
          Desconectar Vercel
        </button>
      ) : (
        vercel.available && (
          <form className="row row-form" onSubmit={(event) => void saveToken(event)}>
            <input type="password" autoComplete="off" placeholder="Token de Vercel" aria-label="Token de Vercel" value={token} onChange={(event) => setToken(event.target.value)} />
            <button type="submit" className="row-link" disabled={busy || !online || token.trim().length < 10}>
              {busy ? "Guardando…" : "Guardar"}
            </button>
          </form>
        )
      )}
      <p className="group-footer" role="status">
        {message ??
          (vercel.account
            ? `Publico los proyectos en ${vercel.domain ? `<nombre>.${vercel.domain}` : "vercel.app"}, siempre después de que lo apruebes.`
            : (
              <>
                Creá un token en{" "}
                <a href={VERCEL_TOKENS_URL} target="_blank" rel="noreferrer">
                  Vercel › Tokens
                </a>{" "}
                con el alcance de tu equipo y pegalo acá.
              </>
            ))}
      </p>
    </div>
  );
}
