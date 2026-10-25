import { useState, type FormEvent } from "react";
import { login } from "../auth/api.js";

export function Login({ onAuthenticated }: { onAuthenticated(): void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const outcome = await login(password);
    setBusy(false);
    if (outcome.ok) onAuthenticated();
    else setError(outcome.message);
  };

  return (
    <main className="login">
      <img className="login-mark" src="/icon-192.png" alt="" width={96} height={96} />
      <h1 className="wordmark">J.A.R.V.I.S.</h1>
      <form className="login-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="password">Contraseña</label>
        <input
          id="password"
          type="password"
          name="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error ? "login-error" : undefined}
        />
        {error && (
          <p id="login-error" className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button primary" disabled={!password || busy}>
          {busy ? "Entrando" : "Entrar"}
        </button>
      </form>
    </main>
  );
}
