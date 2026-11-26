import { memo, useId, useMemo, useState, useSyncExternalStore } from "react";
import type { ActivityStore } from "../activity/activity-store.js";
import { GlyphIcon, toneGlyphs, VisualIcon } from "../activity/glyphs.js";
import { describeActivity, type ActivityTone, type ActivityView } from "../activity/view.js";

const ANNOUNCEMENTS: Partial<Record<ActivityTone, string>> = {
  working: "Jarvis está trabajando en tu pedido.",
  problem: "Hubo un problema con una acción.",
};

function ToneMark({ tone }: { tone: ActivityTone }) {
  if (tone === "working") return <span className="activity-spinner" aria-hidden="true" />;
  const path = tone === "done" ? toneGlyphs.done : tone === "problem" ? toneGlyphs.problem : tone === "approval" ? toneGlyphs.approval : tone === "offline" ? toneGlyphs.offline : toneGlyphs.cancelled;
  return (
    <span className="activity-mark" aria-hidden="true">
      <GlyphIcon path={path} size={14} />
    </span>
  );
}

function Visuals({ view }: { view: ActivityView }) {
  if (view.visuals.length === 0) return null;
  return (
    <span className="activity-visuals" aria-hidden="true">
      {view.visuals.map((visual, index) => (
        <span key={index} className="activity-visual">
          <VisualIcon visual={visual} />
        </span>
      ))}
    </span>
  );
}

function Line({ view }: { view: ActivityView }) {
  return (
    <>
      <Visuals view={view} />
      <span className="activity-title">{view.title}</span>
      <ToneMark tone={view.tone} />
    </>
  );
}

/** A compact line for what Jarvis is doing, with the detail one tap away when there is more than one action. */
export function ActivityRow({ view }: { view: ActivityView }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const expandable = view.items.length > 1;
  return (
    <div className="activity" data-tone={view.tone}>
      {expandable ? (
        <button type="button" className="activity-head" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
          <Line view={view} />
          <span className="activity-chevron" aria-hidden="true">
            <GlyphIcon path={toneGlyphs.chevron} size={16} />
          </span>
        </button>
      ) : (
        <div className="activity-head">
          <Line view={view} />
        </div>
      )}
      {expandable && (
        <ul id={listId} className="activity-items" hidden={!open}>
          {view.items.map((item) => (
            <li key={item.id} data-tone={item.tone}>
              <span className="activity-visual" aria-hidden="true">
                <VisualIcon visual={item.visual} size={16} />
              </span>
              <span className="activity-title">{item.label}</span>
              <ToneMark tone={item.tone} />
            </li>
          ))}
        </ul>
      )}
      <span className="sr-only" role="status">
        {ANNOUNCEMENTS[view.tone] ?? ""}
      </span>
    </div>
  );
}

function useTurn(store: ActivityStore, turnId: string) {
  return useSyncExternalStore(store.subscribe, () => store.turn(turnId));
}

/** The activity of one turn, in the thread. Only this turn re-renders when it changes. */
export const ActivityGroup = memo(function ActivityGroup({ store, turnId }: { store: ActivityStore; turnId: string }) {
  const turn = useTurn(store, turnId);
  const view = useMemo(() => (turn ? describeActivity(turn) : null), [turn]);
  if (!view) return null;
  return (
    <li className="message message-activity">
      <ActivityRow view={view} />
    </li>
  );
});

/** What Jarvis is doing right now, for the call screen, where there is no thread. Shown only while it works. */
export function ActivityLive({ store }: { store: ActivityStore }) {
  const turn = useSyncExternalStore(store.subscribe, store.current);
  const view = useMemo(() => (turn ? describeActivity(turn) : null), [turn]);
  if (!view || (view.tone !== "working" && view.tone !== "problem")) return <div className="call-activity" />;
  return (
    <div className="call-activity">
      <ActivityRow view={{ ...view, items: [] }} />
    </div>
  );
}
