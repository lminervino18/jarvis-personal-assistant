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

type Provider = "github" | "gmail-personal" | "gmail-work" | "drive" | "whatsapp";
type Step = "idle" | "armed" | "busy";
type Status = "connected" | "warning" | "off";

const ARMED_MS = 4000;

const STATUS_TEXT: Record<Status, string> = { connected: "Conectado", warning: "Con problemas", off: "Sin conectar" };

const whatsappStatus: Record<string, { status: Status; text: string }> = {
  connected: { status: "connected", text: "Conectado" },
  needs_action: { status: "warning", text: "Hay que vincularlo" },
  disconnected: { status: "warning", text: "Reconectando" },
  error: { status: "warning", text: "Con problemas" },
  disabled: { status: "off", text: "Sin conectar" },
};

/** What the footer explains while a «Desconectar» waits for its second tap. */
const ARMED_HELP: Record<Provider, string> = {
  github: "Tocá «Confirmar» para desconectar GitHub. Después hay que volver a conectarlo.",
  "gmail-personal": "Tocá «Confirmar» para desconectar tu Google personal: Gmail personal y Drive van juntos.",
  "gmail-work": "Tocá «Confirmar» para desconectar el Gmail de trabajo.",
  drive: "Drive usa tu Google personal: «Confirmar» desconecta Gmail personal y Drive juntos.",
  whatsapp:
    "WhatsApp se desvincula desde el celu: WhatsApp › Dispositivos vinculados › Jarvis › Cerrar sesión. Vincular y desvincular seguido puede hacer que WhatsApp restrinja la cuenta.",
};

/** One account, laid out the same for every service: logo, account, status underneath, and one small button. */
function ConnectionRow({ logo, app, account, status, statusText, action }: { logo: string; app: string; account?: string | null; status: Status; statusText?: string; action?: ReactNode }) {
  return (
    <div className="row connection-row">
      <img className="connection-logo" src={`/logos/${logo}.png`} alt={app} width={30} height={30} data-on={status === "connected"} />
      <span className="connection-name">
        <span className="connection-account">{account || app}</span>
        <small className="connection-status" data-status={status}>
          {statusText ?? STATUS_TEXT[status]}
        </small>
      </span>
      {action}
    </div>
  );
}

function ConnectButton({ href }: { href: string }) {
  return (
    <a className="connection-button" href={href}>
      Conectar
    </a>
  );
}

function DisconnectButton({ app, step, onClick }: { app: string; step: Step; onClick(): void }) {
  return (
    <button type="button" className="connection-button" data-danger="true" data-armed={step === "armed"} disabled={step === "busy"} aria-label={`Desconectar ${app}`} onClick={onClick}>
      {step === "busy" ? "…" : step === "armed" ? "Confirmar" : "Desconectar"}
    </button>
  );
}

/** One line per account: whether it is connected, and connect or disconnect right there. */
export function ConnectionsGroup() {
  const [state, setState] = useState<ConnectionsState | "loading" | "failed">("loading");
  const [armed, setArmed] = useState<Provider | null>(null);
  const [busy, setBusy] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => void fetchConnections().then((next) => setState(next ?? "failed"));
  useEffect(refresh, []);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), armed === "whatsapp" ? 3 * ARMED_MS : ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const remove = async (provider: Provider) => {
    if (busy) return;
    if (armed !== provider || provider === "whatsapp") return setArmed(provider);
    setArmed(null);
    setBusy(provider);
    setError(null);
    const done = await disconnect(provider === "drive" ? "gmail-personal" : provider);
    setBusy(null);
    if (!done) setError("No pude desconectarla. Probá de nuevo.");
    refresh();
  };
  const step = (provider: Provider): Step => (busy === provider ? "busy" : armed === provider && provider !== "whatsapp" ? "armed" : "idle");

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
  const whatsappShown = whatsapp ? (whatsappStatus[whatsapp.status] ?? { status: "warning" as const, text: whatsapp.status }) : undefined;
  const whatsappAccount = whatsapp?.account ? (whatsapp.account.name ? `${whatsapp.account.name} · +${whatsapp.account.number}` : `+${whatsapp.account.number}`) : null;
  const personal = gmail.accounts.find((item) => item.label === "personal");
  const driveConnected = personal?.status === "connected" && personal.drive;

  return (
    <div className="group">
      {whatsapp && whatsappShown && (
        <ConnectionRow
          logo="whatsapp"
          app="WhatsApp"
          account={whatsappAccount}
          status={whatsappShown.status}
          statusText={whatsappShown.text}
          action={whatsappShown.status === "connected" && <DisconnectButton app="WhatsApp" step={step("whatsapp")} onClick={() => void remove("whatsapp")} />}
        />
      )}
      {whatsapp?.pairing && <CardView card={whatsapp.pairing} actions={NO_ACTIONS} />}

      {gmail.available &&
        GMAIL_LABELS.map(({ label, name }) => {
          const account = gmail.accounts.find((item) => item.label === label);
          const connected = account?.status === "connected";
          return (
            <ConnectionRow
              key={label}
              logo="gmail"
              app={name}
              account={account?.email}
              status={connected ? "connected" : account ? "warning" : "off"}
              action={connected ? <DisconnectButton app={name} step={step(`gmail-${label}`)} onClick={() => void remove(`gmail-${label}`)} /> : <ConnectButton href={gmailConnectUrl(label)} />}
            />
          );
        })}

      {gmail.available && (
        <ConnectionRow
          logo="drive"
          app="Google Drive"
          account={driveConnected ? personal.email : null}
          status={driveConnected ? "connected" : "off"}
          action={driveConnected ? <DisconnectButton app="Google Drive" step={step("drive")} onClick={() => void remove("drive")} /> : <ConnectButton href={gmailConnectUrl("personal")} />}
        />
      )}

      <ConnectionRow
        logo="github"
        app="GitHub"
        account={github.account}
        status={github.account ? "connected" : "off"}
        action={github.account ? <DisconnectButton app="GitHub" step={step("github")} onClick={() => void remove("github")} /> : github.available && <ConnectButton href={GITHUB_CONNECT_URL} />}
      />

      <p className="group-footer" role="status">
        {error ?? (armed ? ARMED_HELP[armed] : null) ?? (whatsapp && whatsapp.status !== "connected" ? whatsapp.detail : "Jarvis usa estas cuentas solo para lo que le pedís.")}
      </p>
    </div>
  );
}
