let switchLabel: HTMLLabelElement | null = null;

/**
 * A short tap the owner feels, like WhatsApp's when recording starts. Android vibrates; iPhone
 * Safari has no vibration API but ticks when a native switch toggles (iOS 18 and later), so a
 * hidden switch is toggled. Must run inside the tap's own handler.
 */
export function haptic(): void {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    navigator.vibrate(12);
    return;
  }
  if (typeof document === "undefined") return;
  if (!switchLabel) {
    switchLabel = document.createElement("label");
    switchLabel.setAttribute("aria-hidden", "true");
    switchLabel.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    input.tabIndex = -1;
    switchLabel.appendChild(input);
    document.body.appendChild(switchLabel);
  }
  switchLabel.click();
}
