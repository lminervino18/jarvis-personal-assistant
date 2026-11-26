import { memo } from "react";
import type { CardActions } from "../cards/actions.js";
import { CardView } from "../cards/Cards.js";
import type { ThreadMessage } from "../conversation/thread.js";
import { Markdown } from "../conversation/markdown.js";
import { formatTime } from "../format.js";

const speakers = { user: "Vos", assistant: "J.A.R.V.IS", system: "Aviso" } as const;

export const MessageView = memo(function MessageView({ message, actions }: { message: ThreadMessage; actions: CardActions }) {
  const speaker = speakers[message.role];
  return (
    <li className={`message message-${message.role}`}>
      <article aria-label={speaker}>
        {message.text && message.role === "user" && (
          <p className="message-text">
            <span className="sr-only">{speaker}: </span>
            {message.text}
          </p>
        )}
        {message.text && message.role !== "user" && (
          <div className="message-text markdown">
            <span className="sr-only">{speaker}: </span>
            <Markdown text={message.text} tail={message.streaming ? <span className="cursor" aria-hidden="true" /> : null} />
          </div>
        )}
        {message.cards.map((card, index) => (
          <CardView key={`${card.kind}:${index}`} card={card} actions={actions} />
        ))}
        <footer className="message-meta">
          <time dateTime={message.at}>{formatTime(message.at)}</time>
          {message.interrupted && <span> · Interrumpido</span>}
          {message.unsent && <span className="unsent"> · No se envió</span>}
        </footer>
      </article>
    </li>
  );
});
