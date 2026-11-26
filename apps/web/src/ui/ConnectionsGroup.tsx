import { useEffect, useState, type ReactNode } from "react";
import type { CardActions } from "../cards/actions.js";
import { CardView } from "../cards/Cards.js";
import { disconnect, fetchConnections, GITHUB_CONNECT_URL, gmailConnectUrl, type ConnectionsState } from "../connections/api.js";

const GMAIL_LABELS = [
  { label: "personal", name: "Gmail personal" },
  { label: "work", name: "Gmail de trabajo" },
] as const;

const NO_ACTIONS: CardActions = {
  decide: () => {},
  taskAction: () => {},
  registerPlayer: () => () => {},
  reportPlayer: () => {},
  enablePush: async () => ({ ok: true }),
};

function ConnectionRow({ name, logo, account, connected, children }: { name: string; logo: string; account?: string | null; connected: boolean; children?: ReactNode }) {
  return (
    <div className="row connection-row">
      <img className="connection-logo" src={`/logos/${logo}.png`} alt="" width={30} height={30} data-on={connected} />
      <span className="connection-name">
        <span>{name}</span>
        {account && <small>{account}</small>}
      </span>
      {children}
    </div>
  );
}

function ConnectLink({ href }: { href: string }) {
  return (
    <a className="row-link" href={href}>
      Conectar
    </a>
  );
}

function DisconnectButton({ step, onClick }: { step: "idle" | "armed" | "busy"; onClick(): void }) {
  return (
    <button type="button" className="row-link row-link-danger" disabled={step === "busy"} onClick={onClick}>
      {step === "busy" ? "Desconectando…" : step === "armed" ? "Confirmar" : "Desconectar"}
    </button>
  );
}

type Provider = "github" | "gmail-personal" | "gmail-work";

const ARMED_MS = 4000;

const whatsappLabels: Record<string, string> = {
  connected: "Conectado",
  needs_action: "Hay que vincularlo",
  disconnected: "Desconectado",
  error: "Con problemas",
  disabled: "Desactivado",
};

/** One line per service: whether it is connected, and connect or disconnect right there. */
export function ConnectionsGroup() {
  const [state, setState] = useState<ConnectionsState | "loading" | "failed">("loading");
  const [armed, setArmed] = useState<Provider | null>(null);
  const [busy, setBusy] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => void fetchConnections().then((next) => setState(next ?? "failed"));
  useEffect(refresh, []);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const remove = async (provider: Provider) => {
    if (busy) return;
    if (armed !== provider) return setArmed(provider);
    setArmed(null);
    setBusy(provider);
    setError(null);
    const done = await disconnect(provider);
    setBusy(null);
    if (!done) setError("No pude desconectarla. Probá de nuevo.");
    refresh();
  };
  const step = (provider: Provider) => (busy === provider ? "busy" : armed === provider ? "armed" : "idle");

  if (state === "loading") {
    return (
      <div className="group">
        <p className="row row-muted">Cargando conexiones…</p>
      </div>
    );
  }
  if (state === "failed") {
    return (
      <div className="group">
        <div className="row">
          <span className="row-muted">No pude ver las conexiones.</span>
          <button type="button" className="row-link" onClick={() => (setState("loading"), refresh())}>
            Reintentar
          </button>
        </div>
      </div>
    );
  }
  const { whatsapp, gmail, github } = state;

  return (
    <div className="group">
      {whatsapp && (
        <ConnectionRow name="WhatsApp" logo="whatsapp" account={whatsappLabels[whatsapp.status] ?? whatsapp.status} connected={whatsapp.status === "connected"} />
      )}
      {whatsapp?.pairing && <CardView card={whatsapp.pairing} actions={NO_ACTIONS} />}

      {gmail.available &&
        GMAIL_LABELS.map(({ label, name }) => {
          const account = gmail.accounts.find((item) => item.label === label);
          const connected = account?.status === "connected";
          return (
            <ConnectionRow key={label} name={name} logo="gmail" account={account?.email} connected={connected}>
              {connected ? <DisconnectButton step={step(`gmail-${label}`)} onClick={() => void remove(`gmail-${label}`)} /> : <ConnectLink href={gmailConnectUrl(label)} />}
            </ConnectionRow>
          );
        })}

      {gmail.available && (() => {
        const personal = gmail.accounts.find((item) => item.label === "personal");
        const connected = personal?.status === "connected" && personal.drive;
        return (
          <ConnectionRow name="Google Drive" logo="drive" account={connected ? personal.email : null} connected={connected === true}>
            {!connected && <ConnectLink href={gmailConnectUrl("personal")} />}
          </ConnectionRow>
        );
      })()}

      <ConnectionRow name="GitHub" logo="github" account={github.account} connected={Boolean(github.account)}>
        {github.account ? <DisconnectButton step={step("github")} onClick={() => void remove("github")} /> : github.available && <ConnectLink href={GITHUB_CONNECT_URL} />}
      </ConnectionRow>

      <p className="group-footer" role="status">
        {error ?? (armed ? "Tocá «Confirmar» para desconectarla. Después hay que volver a conectarla." : null) ?? (whatsapp && whatsapp.status !== "connected"
          ? whatsapp.detail
          : "Jarvis usa estas cuentas solo para lo que le pedís.")}
      </p>
    </div>
  );
}
