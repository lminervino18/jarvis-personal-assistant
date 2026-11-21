import type { AssistantState } from "@jarvis/contracts";
import { useEffect, useRef, type KeyboardEvent } from "react";
import type { LevelReading } from "./core-style.js";
import { startCoreLoop } from "./loop.js";

interface Props {
  state: AssistantState;
  label: string;
  getLevels(): LevelReading;
  /** Makes the core a control, for example to start a call. */
  onActivate?(): void;
  activateLabel?: string;
}

export function Core({ state, label, getLevels, onActivate, activateLabel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return startCoreLoop({ canvas, readState: () => stateRef.current, readLevels: getLevels });
  }, [getLevels]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onActivate?.();
  };

  const control = onActivate
    ? { role: "button", tabIndex: 0, onClick: onActivate, onKeyDown, "aria-label": activateLabel ?? `J.A.R.V.IS: ${label}` }
    : { role: "img", "aria-label": `J.A.R.V.IS: ${label}` };

  return (
    <div className={`core${onActivate ? " core-active" : ""}`} data-state={state} {...control}>
      <canvas ref={canvasRef} className="core-canvas" />
    </div>
  );
}
