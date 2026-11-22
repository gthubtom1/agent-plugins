import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

export type PersonaInjectMode = "cached" | "every-turn";

export interface PersonaSettings {
  /** Persona for a new conversation. `null` means no default persona. */
  defaultId: string | null;
  /** How Pi sends the selected persona to the model. */
  mode: PersonaInjectMode;
  /** Whether to show a larger status widget above the composer. */
  showBadge: boolean;
}

const DEFAULTS: PersonaSettings = { defaultId: null, mode: "cached", showBadge: false };
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

export function ensurePersonasDir(agentDir: string = resolveAgentDir()): string {
  const dir = personasDir(agentDir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a persona file without replacing an existing persona. */
export function createPersonaFile(agentDir: string, id: string, text: string): void {
  if (!isValidPersonaId(id)) throw new Error("人设名称包含无效字符");
  const body = `${text.trim()}\n`;
  if (!text.trim()) throw new Error("人设正文不能为空");
  if (Buffer.byteLength(body, "utf8") > MAX_PERSONA_BYTES) throw new Error("人设正文不能超过 512 KiB");
  const dir = ensurePersonasDir(agentDir);
  writeFileSync(join(dir, `${id}${PERSONA_FILE_EXTENSION}`), body, {
    encoding: "utf8",
    flag: "wx",
  });
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
  return {
    defaultId: isValidPersonaId(raw.defaultId) ? raw.defaultId : null,
    mode: raw.mode === "every-turn" ? "every-turn" : "cached",
    showBadge: raw.showBadge === true,
  };
}

export function readSettings(agentDir: string = resolveAgentDir()): PersonaSettings {
  try {
    return normalizeSettings(JSON.parse(readFileSync(settingsPath(agentDir), "utf8")));
  } catch {
    return { ...DEFAULTS };
  }
}

/** Merge known settings while preserving fields written by a newer version. */
export function writeSettings(patch: Partial<PersonaSettings>, agentDir: string = resolveAgentDir()): PersonaSettings {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(agentDir), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("personas.json must contain an object");
    }
    stored = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const current = normalizeSettings(stored);
  const next: PersonaSettings = {
    defaultId: patch.defaultId === undefined ? current.defaultId : patch.defaultId,
    mode: patch.mode === undefined ? current.mode : patch.mode,
    showBadge: patch.showBadge === undefined ? current.showBadge : patch.showBadge,
  };
  const merged = { ...stored, ...next };
  mkdirSync(agentDir, { recursive: true });
  const temporary = `${settingsPath(agentDir)}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, settingsPath(agentDir));
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return next;
}
