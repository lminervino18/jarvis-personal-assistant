import type { Card } from "@jarvis/contracts";
import { useState } from "react";
import type { CardActions } from "./actions.js";

type PersonChoice = Extract<Card, { kind: "person_choice" }>;

/** How the owner's pick reads in the chat, with the id Jarvis needs to send to that person. */
export function personPick(option: PersonChoice["options"][number]): string {
  const id = option.chatId.endsWith("@s.whatsapp.net") ? `+${option.chatId.split("@")[0]}` : option.chatId;
  return `Es ${option.name} (${id}).`;
}

/** The people the owner may have meant by a name: tapping one tells Jarvis which, as if the owner had said it. */
export function PersonChoiceCard({ card, actions }: { card: PersonChoice; actions: CardActions }) {
  const [chosen, setChosen] = useState<number | null>(null);

  const choose = (index: number) => {
    const option = card.options[index];
    if (!option) return;
    setChosen(index);
    actions.say(personPick(option));
  };

  return (
    <section className="card choice-card person-choice" aria-label={`¿Quién es ${card.query}?`}>
      <p className="card-meta">{chosen === null ? `¿Cuál ${card.query}?` : "Elegiste"}</p>
      <ol className="choice-list">
        {card.options.map((option, index) => (
          <li key={option.chatId} className="choice-option" data-state={chosen === null ? "open" : chosen === index ? "chosen" : "other"}>
            <span className="choice-text">
              <strong>{option.name}</strong>
              <small>{option.detail}</small>
            </span>
            {chosen === null ? (
              <button type="button" className="button primary" aria-label={`Es ${option.name}`} onClick={() => choose(index)}>
                Es esta
              </button>
            ) : (
              chosen === index && <span className="choice-done">Elegida</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
