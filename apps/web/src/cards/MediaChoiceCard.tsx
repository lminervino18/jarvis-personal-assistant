import { useState } from "react";
import { chooseOption, type ChoiceCard } from "../transfers/api.js";

const FORMAT_NAMES: Record<ChoiceCard["format"], string> = { iphone: "video para el iPhone", max: "video en máxima calidad", mp3: "audio MP3", m4a: "audio M4A" };
const ERRORS: Record<string, string> = {
  expired: "Esta propuesta venció. Pedímela de nuevo.",
  chosen: "Ya elegiste una.",
  not_found: "Ya no encuentro esta propuesta.",
};

function clock(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const rest = `${Math.floor((seconds % 3600) / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return hours ? `${hours}:${rest.padStart(5, "0")}` : rest;
}

/** Up to three videos that may be what the owner asked for: tapping one downloads it to Transferencias. */
export function MediaChoiceCard({ card: initial }: { card: ChoiceCard }) {
  const [card, setCard] = useState(initial);
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const chosen = card.chosen;
  const expired = chosen === undefined && Date.parse(card.expiresAt) <= Date.now();

  const choose = async (option: number) => {
    setBusy(option);
    setMessage(null);
    const result = await chooseOption(card.choiceId, option);
    setBusy(null);
    if (result?.card) setCard(result.card);
    if (!result) return setMessage("No pude conectarme. Probá de nuevo.");
    if (result.error) setMessage(ERRORS[result.error] ?? "No pude empezar la descarga. Probá de nuevo.");
  };

  return (
    <section className="card choice-card" aria-label="Opciones para bajar">
      <p className="card-meta">
        {chosen === undefined ? "¿Cuál es?" : "Elegiste"} · {FORMAT_NAMES[card.format]}
        {card.sendTo ? ` · después se lo mando a ${card.sendTo}` : ""}
      </p>
      <ol className="choice-list">
        {card.options.map((option, index) => (
          <li key={option.videoId} className="choice-option" data-state={chosen === undefined ? "open" : chosen === index ? "chosen" : "other"}>
            <img src={option.thumbnailUrl} alt="" loading="lazy" width="96" height="54" />
            <span className="choice-text">
              <strong>{option.title}</strong>
              <small>{[option.channel, option.duration ? clock(option.duration) : null].filter(Boolean).join(" · ")}</small>
            </span>
            {chosen === undefined && !expired ? (
              <button type="button" className="button primary" disabled={busy !== null} aria-label={`Bajar ${option.title}`} onClick={() => void choose(index)}>
                {busy === index ? "…" : "Bajar"}
              </button>
            ) : (
              chosen === index && <span className="choice-done">Elegida</span>
            )}
          </li>
        ))}
      </ol>
      {expired && <p className="card-meta">Esta propuesta venció.</p>}
      {message && (
        <p className="card-meta" role="alert">
          {message}
        </p>
      )}
    </section>
  );
}
