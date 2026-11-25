import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

interface Props {
  disabled: boolean;
  onStart(): void;
  onFinish(): void;
  onCancel(): void;
  /** Changes while the owner slides away to cancel, so the screen can say "release to cancel". */
  onCancelling(cancelling: boolean): void;
}

const CANCEL_PX = 90;
const MIN_HOLD_MS = 350;

/** Hold to record a voice note, release to send it, slide left to drop it (like WhatsApp). */
export function HoldToTalk({ disabled, onStart, onFinish, onCancel, onCancelling }: Props) {
  const press = useRef<{ x: number; at: number; cancelling: boolean } | null>(null);
  const [holding, setHolding] = useState(false);
  const [hint, setHint] = useState(false);

  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(false), 2500);
    return () => clearTimeout(timer);
  }, [hint]);

  const begin = (x: number) => {
    press.current = { x, at: Date.now(), cancelling: false };
    setHolding(true);
    setHint(false);
    onStart();
  };

  const end = (cancelled: boolean) => {
    const current = press.current;
    press.current = null;
    setHolding(false);
    onCancelling(false);
    if (!current) return;
    const tooShort = Date.now() - current.at < MIN_HOLD_MS;
    if (cancelled || current.cancelling || tooShort) {
      onCancel();
      if (tooShort && !current.cancelling) setHint(true);
      return;
    }
    onFinish();
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (disabled || press.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    begin(event.clientX);
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = press.current;
    if (!current) return;
    const cancelling = current.x - event.clientX > CANCEL_PX;
    if (cancelling === current.cancelling) return;
    current.cancelling = cancelling;
    onCancelling(cancelling);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === " " || event.key === "Enter") && !event.repeat && !press.current && !disabled) {
      event.preventDefault();
      begin(0);
    }
  };

  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === " " || event.key === "Enter") end(false);
  };

  return (
    <div className="hold">
      <button
        type="button"
        className="hold-button glass"
        data-holding={holding}
        aria-label="Mantené apretado para mandar un audio"
        disabled={disabled}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => end(false)}
        onPointerCancel={() => end(true)}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onContextMenu={(event) => event.preventDefault()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" width="30" height="30">
          <path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12h-2Z" />
        </svg>
      </button>
      <span className="hold-label" role={hint ? "status" : undefined}>
        {hint ? "Mantenelo apretado mientras hablás" : "Audio"}
      </span>
    </div>
  );
}
