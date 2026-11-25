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

function DisconnectButton({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className="row-link row-link-danger" onClick={onClick}>
      Desconectar
    </button>
  );
}

const whatsappLabels: Record<string, string> = {
  connected: "Conectado",
  needs_action: "Hay que vincularlo",
  disconnected: "Desconectado",
  error: "Con problemas",
  disabled: "Desactivado",
};

/** One line per service: whether it is connected, and connect or disconnect right there. */
export function ConnectionsGroup() {
  const [state, setState] = useState<ConnectionsState | null>(null);

  const refresh = () => void fetchConnections().then(setState);
  useEffect(refresh, []);

  const remove = async (provider: "github" | "gmail-personal" | "gmail-work") => {
    await disconnect(provider);
    refresh();
  };

  if (!state) return null;
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
              {connected ? <DisconnectButton onClick={() => void remove(`gmail-${label}`)} /> : <ConnectLink href={gmailConnectUrl(label)} />}
            </ConnectionRow>
          );
        })}

      <ConnectionRow name="GitHub" logo="github" account={github.account} connected={Boolean(github.account)}>
        {github.account ? <DisconnectButton onClick={() => void remove("github")} /> : github.available && <ConnectLink href={GITHUB_CONNECT_URL} />}
      </ConnectionRow>

      <p className="group-footer" role="status">
        {whatsapp && whatsapp.status !== "connected"
          ? whatsapp.detail
          : "Jarvis usa estas cuentas solo para lo que le pedís; lo que publica o manda en tu nombre siempre pasa por tu aprobación."}
      </p>
    </div>
  );
}
