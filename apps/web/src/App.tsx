import { useEffect, useState } from "react";
import { fetchAuthState, logout } from "./auth/api.js";
import type { Session } from "./conversation/session.js";
import { useSnapshot } from "./hooks.js";
import { Conversation } from "./ui/Conversation.js";
import { Login } from "./ui/Login.js";

type Phase = "checking" | "login" | "conversation";

function Authenticated({ session, onExpired }: { session: Session; onExpired(): void }) {
  const { needsLogin } = useSnapshot(session);
  useEffect(() => {
    session.start();
    return () => session.stop();
  }, [session]);
  useEffect(() => {
    if (needsLogin) onExpired();
  }, [needsLogin, onExpired]);
  const leave = async () => {
    await logout();
    onExpired();
  };
  return <Conversation session={session} onLogout={() => void leave()} />;
}

export function App({ session }: { session: Session }) {
  const [phase, setPhase] = useState<Phase>("checking");

  useEffect(() => {
    void fetchAuthState().then((state) => setPhase(state.authenticated ? "conversation" : "login"));
  }, []);

  if (phase === "checking") return <div className="splash" aria-busy="true" />;
  if (phase === "login") return <Login onAuthenticated={() => setPhase("conversation")} />;
  return <Authenticated session={session} onExpired={() => setPhase("login")} />;
}
