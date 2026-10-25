import { z } from "zod";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const optionalText = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional();

const VapidEnv = z.object({
  VAPID_PUBLIC_KEY: optionalText,
  VAPID_PRIVATE_KEY: optionalText,
  VAPID_SUBJECT: optionalText,
});

/** VAPID settings from the environment, or undefined when push is not configured. Partial settings are an error. */
export function loadVapidConfig(env: NodeJS.ProcessEnv = process.env): VapidConfig | undefined {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = VapidEnv.parse(env);
  if (!publicKey && !privateKey && !subject) return undefined;
  if (!publicKey || !privateKey || !subject) {
    throw new Error("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set together");
  }
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
    throw new Error("VAPID_SUBJECT must be a mailto: or https:// URL");
  }
  return { publicKey, privateKey, subject };
}
