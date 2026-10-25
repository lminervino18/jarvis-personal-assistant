import type { AssistantState } from "@jarvis/contracts";
import { useEffect, useRef } from "react";
import type { LevelReading } from "./core-style.js";
import { startCoreLoop } from "./loop.js";

interface Props {
  state: AssistantState;
  label: string;
  getLevels(): LevelReading;
}

export function Core({ state, label, getLevels }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return startCoreLoop({ canvas, readState: () => stateRef.current, readLevels: getLevels });
  }, [getLevels]);

  return (
    <div className="core" data-state={state} role="img" aria-label={`J.A.R.V.I.S.: ${label}`}>
      <canvas ref={canvasRef} className="core-canvas" />
    </div>
  );
}
