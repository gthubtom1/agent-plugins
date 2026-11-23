/**
 * One-time migration from the fork's persona layout to "the file name is the
 * persona".
 *
 * The fork stored personas as generated ids (`p_k1udshge.md`) plus a metadata
 * file that held the display name, so a directory listing said nothing. This
 * package reads the name from the file name, so the ids have to become names
 * once, or every persona would be listed as `p_k1udshge`.
 *
 * The plan below is pure — it takes the old index and the files on disk and
 * returns the renames to perform — so the script that applies it can run with
 * `--dry-run` and the decision can be tested without touching a real directory.
 */

export interface LegacyPersonaEntry {
  id?: unknown;
  name?: unknown;
}

export interface LegacyIndex {
  version?: unknown;
  defaultPersonaId?: unknown;
  personas?: unknown;
  /** New layout setting, accepted so a re-run does not lose it. */
  defaultId?: unknown;
  mode?: unknown;
}

export interface Rename {
  from: string;
  to: string;
}

export interface MigrationPlan {
  renames: Rename[];
  /** Legacy entries whose file is missing; reported, never silently dropped. */
  unmapped: Array<{ id: string; name: string }>;
  defaultId: string | null;
  mode: "cached" | "every-turn";
  /** True when the index is already in the new shape and nothing must be renamed. */
  upToDate: boolean;
}

const INVALID_NAME_CHARS = /[/\\:*?"<>|\u0000-\u001f]/g;
const MAX_NAME_LENGTH = 60;

/**
 * A persona name becomes a file name, so it has to survive one: no separators,
 * no characters Windows refuses, no leading dot (which would hide the file), and
 * no trailing dot or space (which Windows strips).
 */
export function sanitizePersonaName(name: unknown, fallback: string): string {
  const raw = typeof name === "string" ? name : "";
  const cleaned = raw
    .replace(INVALID_NAME_CHARS, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return cleaned || fallback;
}

function personaEntries(index: LegacyIndex): Array<{ id: string; name: string }> {
  const raw = index.personas;
  if (!Array.isArray(raw)) return [];
  const entries: Array<{ id: string; name: string }> = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const { id, name } = item as LegacyPersonaEntry;
    if (typeof id !== "string" || id.trim() === "") continue;
    entries.push({ id: id.trim(), name: typeof name === "string" ? name : id });
  }
  return entries;
}

/**
 * @param legacy      Parsed `<agentDir>/personas.json` (old or new shape).
 * @param files       Persona ids currently on disk, i.e. file names without `.md`.
 * @param legacyMode  `mode` from the fork's `persona-inject.json`, when present.
 */
export function planMigration(
  legacy: LegacyIndex | null | undefined,
  files: readonly string[],
  legacyMode?: unknown,
): MigrationPlan {
  const index = legacy ?? {};
  const mode = (legacyMode === "every-turn" || index.mode === "every-turn") ? "every-turn" : "cached";
  const entries = personaEntries(index);
  const onDisk = new Set(files);

  const defaultSource = typeof index.defaultPersonaId === "string"
    ? index.defaultPersonaId
    : typeof index.defaultId === "string"
      ? index.defaultId
      : null;

  // Already migrated (or never had ids): nothing to rename, keep the stored default.
  if (entries.length === 0) {
    return {
      renames: [],
      unmapped: [],
      defaultId: defaultSource && onDisk.has(defaultSource) ? defaultSource : null,
      mode,
      upToDate: true,
    };
  }

  const taken = new Set<string>();
  const idToTarget = new Map<string, string>();
  const renames: Rename[] = [];
  const unmapped: Array<{ id: string; name: string }> = [];

  for (const entry of entries) {
    if (!onDisk.has(entry.id)) {
      unmapped.push({ id: entry.id, name: entry.name });
      continue;
    }
    const base = sanitizePersonaName(entry.name, entry.id);
    let target = base;
    let suffix = 2;
    while (taken.has(target)) target = `${base}-${suffix++}`;
    taken.add(target);
    idToTarget.set(entry.id, target);
    if (target !== entry.id) renames.push({ from: entry.id, to: target });
  }

  const mappedDefault = defaultSource ? idToTarget.get(defaultSource) ?? null : null;

  return { renames, unmapped, defaultId: mappedDefault, mode, upToDate: false };
}
