import type { AssistantState } from "@jarvis/contracts";
import { useState } from "react";
import { Core } from "../core/Core.js";
import type { LevelReading } from "../core/core-style.js";
import type { Subtitle } from "../conversation/subtitle.js";
import type { SessionSnapshot } from "../conversation/session.js";
import { useElapsed } from "../hooks.js";
import { Waveform } from "./DictationBar.js";
import { HoldToTalk } from "./HoldToTalk.js";
import { HangUpIcon, MicIcon, PhoneIcon } from "./icons.js";

interface Props {
  state: AssistantState;
  label: string;
  getLevels(): LevelReading;
  greeting: string;
  /** The server can transcribe and the connection is up. */
  canTalk: boolean;
  callActive: boolean;
  callMuted: boolean;
  voiceNote: SessionSnapshot["voiceNote"];
  subtitle: Subtitle | null;
  onCall(): void;
  onHangUp(): void;
  onMute(): void;
  onOpenChat(): void;
  onNoteStart(): void;
  onNoteFinish(): void;
  onNoteCancel(): void;
}

function CallClock() {
  return <span className="voice-clock">{useElapsed()}</span>;
}

function Caption({ subtitle, onOpenChat }: { subtitle: Subtitle | null; onOpenChat(): void }) {
  if (!subtitle) return <p className="voice-caption voice-caption-empty">Tocá el núcleo para llamarme o mantené el micrófono para mandarme un audio.</p>;
  return (
    <div className="voice-caption" data-speaker={subtitle.speaker}>
      {subtitle.text && <p>{subtitle.text}</p>}
      {subtitle.cards && (
        <button type="button" className="voice-more" onClick={onOpenChat}>
          Ver en el chat
        </button>
      )}
    </div>
  );
}

/** The voice-first screen: the core, a live caption of the conversation, and the call and voice note controls. */
export function VoicePanel(props: Props) {
  const { state, label, getLevels, greeting, canTalk, callActive, callMuted, voiceNote, subtitle, onCall, onHangUp, onMute, onOpenChat } = props;
  const [cancelling, setCancelling] = useState(false);
  const recording = voiceNote !== "idle";

  return (
    <section className="voice" aria-label="Llamada" data-state={state}>
      <div className="voice-core">
        <Core state={state} label={label} getLevels={getLevels} onActivate={canTalk && !callActive && !recording ? onCall : undefined} activateLabel="Llamar a Jarvis" />
      </div>

      <p className="voice-status" role="status" data-state={state}>
        {callActive ? (
          <>
            {callMuted ? "Micrófono silenciado" : label} · <CallClock />
          </>
        ) : recording ? (
          cancelling ? "Soltá para cancelar" : "Grabando · deslizá a la izquierda para cancelar"
        ) : (
          greeting
        )}
      </p>

      {recording ? (
        <div className="voice-recording" data-cancelling={cancelling} aria-hidden="true">
          <Waveform levels={getLevels} />
        </div>
      ) : (
        <Caption subtitle={subtitle} onOpenChat={onOpenChat} />
      )}

      <div className="voice-controls">
        {callActive ? (
          <>
            <button type="button" className="call-button glass" aria-pressed={callMuted} aria-label={callMuted ? "Activar micrófono" : "Silenciar micrófono"} onClick={onMute}>
              <MicIcon muted={callMuted} size={28} />
            </button>
            <button type="button" className="call-button call-hangup" aria-label="Colgar" onClick={onHangUp}>
              <HangUpIcon />
            </button>
          </>
        ) : (
          <>
            <HoldToTalk disabled={!canTalk} onStart={props.onNoteStart} onFinish={props.onNoteFinish} onCancel={props.onNoteCancel} onCancelling={setCancelling} />
            <div className="hold">
              <button type="button" className="call-button call-start" aria-label="Llamar a Jarvis" disabled={!canTalk || recording} onClick={onCall}>
                <PhoneIcon />
              </button>
              <span className="hold-label">Llamar</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
