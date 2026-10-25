import type { ClientMessage } from "@jarvis/contracts";
import type { PushResult } from "../conversation/session.js";
import { isIos, readPlatform } from "./platform.js";

type Subscription = Extract<ClientMessage, { type: "push.subscribe" }>["subscription"];

export function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const INSTALL_FIRST = "En iPhone, primero agregá J.A.R.V.I.S. a la pantalla de inicio: Compartir → Agregar a inicio.";

/** Must be called from a tap: the permission prompt needs a user gesture. */
export async function subscribeToPush(publicKey: string): Promise<PushResult & { subscription?: Subscription }> {
  const platform = readPlatform();
  if (isIos(platform) && !platform.standalone) return { ok: false, message: INSTALL_FIRST };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return { ok: false, message: "Este navegador no permite notificaciones." };
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, message: "Las notificaciones están bloqueadas. Podés habilitarlas desde los ajustes del sitio." };
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) }));
    const json = subscription.toJSON();
    const { p256dh, auth } = json.keys ?? {};
    if (!json.endpoint || !p256dh || !auth) return { ok: false, message: "No se pudo activar en este dispositivo." };
    return { ok: true, subscription: { endpoint: json.endpoint, keys: { p256dh, auth } } };
  } catch {
    return { ok: false, message: "No se pudo activar en este dispositivo." };
  }
}
