import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentDir } from "./agent-dir.ts";

/**
 * Personas are plain Markdown files. The file name is the persona name.
 * Adding, renaming, or removing a persona only requires a file operation.
 */
export const PERSONAS_DIR_NAME = "personas";
export const PERSONAS_SETTINGS_NAME = "personas.json";
export const PERSONA_FILE_EXTENSION = ".md";

export interface PersonaFile {
  id: string;
  name: string;
  path: string;
}

export interface PersonaSettings {
  /** Persona for a new conversation. `null` means no default persona. */
  defaultId: string | null;
}

const DEFAULTS: PersonaSettings = { defaultId: null };
const MAX_PERSONA_BYTES = 512 * 1024;

export function personasDir(agentDir: string = resolveAgentDir()): string {
  return join(agentDir, PERSONAS_DIR_NAME);
}

export function settingsPath(agentDir: string = resolveAgentDir()): string {
  return join(agentDir, PERSONAS_SETTINGS_NAME);
}

/** A persona id is a file name without its extension, so it must survive a path join. */
export function isValidPersonaId(id: unknown): id is string {
  return typeof id === "string"
    && id.length > 0
    && id.length <= 120
    && id === id.trim()
    && !/[/\\:*?"<>|\u0000-\u001f]/.test(id)
    && !id.startsWith(".")
    && !id.endsWith(PERSONA_FILE_EXTENSION);
}

function isPersonaFile(name: string): boolean {
  return name.endsWith(PERSONA_FILE_EXTENSION)
    && name.length > PERSONA_FILE_EXTENSION.length
    && !name.startsWith(".");
}

export function listPersonas(agentDir: string = resolveAgentDir()): PersonaFile[] {
  const dir = personasDir(agentDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const personas: PersonaFile[] = [];
  for (const name of names) {
    if (!isPersonaFile(name)) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const id = name.slice(0, -PERSONA_FILE_EXTENSION.length);
    if (isValidPersonaId(id)) personas.push({ id, name: id, path });
  }
  return personas.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

/** The persona text, or null when the file is missing, invalid, or too large. */
export function readPersonaText(agentDir: string, id: string | null | undefined): string | null {
  if (!id || !isValidPersonaId(id)) return null;
  const path = join(personasDir(agentDir), `${id}${PERSONA_FILE_EXTENSION}`);
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_PERSONA_BYTES) return null;
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function normalizeSettings(input: unknown): PersonaSettings {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ...DEFAULTS };
  const raw = input as Record<string, unknown>;
  return { defaultId: isValidPersonaId(raw.defaultId) ? raw.defaultId : null };
}

export function readSettings(agentDir: string = resolveAgentDir()): PersonaSettings {
  try {
    return normalizeSettings(JSON.parse(readFileSync(settingsPath(agentDir), "utf8")));
  } catch {
    return { ...DEFAULTS };
  }
}
