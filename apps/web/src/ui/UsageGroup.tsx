import { useEffect, useState } from "react";

interface PlanWindow {
  utilization: number;
  resetsAt: string;
}

export interface PlanUsage {
  session: PlanWindow;
  week: PlanWindow;
  allowed: boolean;
}

export async function fetchUsage(): Promise<PlanUsage | null> {
  try {
    const response = await fetch("/api/usage", { credentials: "same-origin" });
    return response.ok ? ((await response.json()) as PlanUsage) : null;
  } catch {
    return null;
  }
}

/** When a window starts over, in the owner's words: «a las 14:20» today, «el dom 01:40» later. */
export function resetLabel(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (at.toDateString() === now.toDateString()) return `a las ${time}`;
  const day = at.toLocaleDateString("es-AR", { weekday: "short" }).replace(".", "");
  return `el ${day} ${time}`;
}

function UsageRow({ label, window }: { label: string; window: PlanWindow }) {
  const percent = Math.round(window.utilization * 100);
  const level = percent >= 90 ? "high" : percent >= 70 ? "mid" : "low";
  return (
    <div className="row usage-row">
      <div className="usage-head">
        <span>{label}</span>
        <span className="row-value">
          {percent} % · se renueva {resetLabel(window.resetsAt)}
        </span>
      </div>
      <div className="usage-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="usage-fill" data-level={level} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/** How much of the Claude plan is used: the 5-hour session and the week. */
export function UsageGroup() {
  const [usage, setUsage] = useState<PlanUsage | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void fetchUsage().then((next) => alive && setUsage(next));
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div className="group">
      {usage ? (
        <>
          <UsageRow label="Sesión (5 h)" window={usage.session} />
          <UsageRow label="Semana" window={usage.week} />
        </>
      ) : (
        <div className="row">
          <span>Uso de Claude</span>
          <span className="row-value">{usage === undefined ? "…" : "No disponible"}</span>
        </div>
      )}
      <p className="group-footer">{usage && !usage.allowed ? "Se llegó al límite: Jarvis vuelve cuando se renueve." : "Uso del plan de Claude que comparten el chat, las llamadas y Construir."}</p>
    </div>
  );
}
