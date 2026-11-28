import type { AssistantState } from "@jarvis/contracts";
import type { ActivityStore } from "../activity/activity-store.js";
import { Core } from "../core/Core.js";
import type { LevelReading } from "../core/core-style.js";
import { useElapsed } from "../hooks.js";
import { ActivityLive } from "./ActivityGroup.js";
import { HangUpIcon, MicIcon } from "./icons.js";

interface Props {
  state: AssistantState;
  label: string;
  muted: boolean;
  activity: ActivityStore;
  getLevels(): LevelReading;
  onMute(): void;
  onHangUp(): void;
}

/** The call on a phone: only the core moving with the voices, mute and hang up; no text. Everything said is saved in the chat. */
export function CallScreen({ state, label, muted, activity, getLevels, onMute, onHangUp }: Props) {
  const elapsed = useElapsed();
  return (
    <div className="call" role="dialog" aria-modal="true" aria-label="Llamada con Jarvis" data-state={state}>
      <ActivityLive store={activity} />
      <div className="call-core">
        <Core state={state} label={label} getLevels={getLevels} />
      </div>
      <p className="call-status" role="status" data-state={state}>
        {muted ? "Micrófono silenciado" : label} · <span className="call-clock">{elapsed}</span>
      </p>
      <div className="call-controls">
        <button type="button" className="call-button glass" aria-pressed={muted} aria-label={muted ? "Activar micrófono" : "Silenciar micrófono"} onClick={onMute}>
          <MicIcon muted={muted} size={28} />
        </button>
        <button type="button" className="call-button call-hangup" aria-label="Colgar" onClick={onHangUp}>
          <HangUpIcon />
        </button>
      </div>
    </div>
  );
}
