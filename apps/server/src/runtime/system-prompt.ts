import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AssistantContext {
  prompt: string;
  /** Short hash of the loaded instructions and profile, used to verify the model received them. */
  fingerprint: string;
  profileSource: "private" | "example" | "builtin";
}

export interface AssistantContextPaths {
  instructionsPath: string;
  privateProfilePath: string;
  exampleProfilePath: string;
  allowExampleProfile: boolean;
  ownerDisplayName: string;
  timezone: string;
}

export function defaultAssistantDir(cwd = process.cwd()): string {
  const candidates = [resolve(cwd, "assistant"), resolve(cwd, "../../assistant")];
  const found = candidates.find((dir) => existsSync(resolve(dir, "CLAUDE.md")));
  if (!found) throw new Error("assistant/CLAUDE.md not found; set ASSISTANT_DIR");
  return found;
}

function builtinProfile(ownerDisplayName: string, timezone: string): string {
  return `# Perfil del dueño\n\n- Nombre preferido: ${ownerDisplayName}\n- Idioma: español rioplatense\n- Zona horaria: ${timezone}\n`;
}

export function loadAssistantContext(paths: AssistantContextPaths): AssistantContext {
  const instructions = readFileSync(paths.instructionsPath, "utf8").trim();
  let profile: string;
  let profileSource: AssistantContext["profileSource"];
  if (existsSync(paths.privateProfilePath)) {
    profile = readFileSync(paths.privateProfilePath, "utf8").trim();
    profileSource = "private";
  } else if (paths.allowExampleProfile && existsSync(paths.exampleProfilePath)) {
    profile = readFileSync(paths.exampleProfilePath, "utf8").trim();
    profileSource = "example";
  } else {
    profile = builtinProfile(paths.ownerDisplayName, paths.timezone);
    profileSource = "builtin";
  }

  const fingerprint = createHash("sha256").update(instructions).update("\0").update(profile).digest("hex").slice(0, 12);
  const prompt = [
    instructions,
    "## Perfil del dueño",
    profile,
    "## Verificación de contexto",
    `Huella de contexto: ${fingerprint}. Si el dueño o el sistema te pide la huella de contexto, respondé solo con ese valor.`,
  ].join("\n\n");

  return { prompt, fingerprint, profileSource };
}
