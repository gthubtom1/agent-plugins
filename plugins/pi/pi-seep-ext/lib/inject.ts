/**
 * Which identity reaches the model, and how it leaves again.
 *
 * Two modes, because the cost profile differs:
 *
 * - `cached` writes the persona as a structured prompt *section*. Pi diffs
 *   sections against the transcript, so the text is byte-identical turn to turn
 *   and the provider's prompt cache keeps working — the persona costs tokens
 *   once, not every turn.
 * - `every-turn` forces the persona into the run's system prompt. It survives
 *   anything another extension does to the prompt, and it costs the cache.
 *
 * The bug this module exists to prevent: with `cached`, a section that was
 * written once is only replaced, never removed, so picking "no persona" used to
 * leave the old identity in the prompt while the UI said none was active. Pi's
 * `diffSystemPromptSections` does support removal — it records `{name: null}`
 * when a previously present section is missing — so clearing means *deleting
 * the key*, and deleting is only safe for a section this extension wrote.
 */

export const PERSONALITY_SECTION = "personality";
export const RULES_SECTION = "generic-rules";

export type InjectMode = "every-turn" | "cached";

export interface InjectionParts {
  personality: string | null;
  rules: string | null;
}

/** Wrap the raw texts the way a prompt section reads. */
export function buildInjection(parts: InjectionParts): { personality: string | null; rules: string | null } {
  return {
    personality: parts.personality?.trim()
      ? `<personality>\n${parts.personality.trim()}\n</personality>`
      : null,
    rules: parts.rules?.trim()
      ? `<generic-rules>\n${parts.rules.trim()}\n</generic-rules>`
      : null,
  };
}

/** The text a forced prompt leads with, or null when there is nothing to inject. */
export function buildForcedPrefix(injection: { personality: string | null; rules: string | null }): string | null {
  const blocks = [injection.personality, injection.rules].filter((block): block is string => Boolean(block));
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

const PERSONALITY_BLOCK = /<personality>[\s\S]*?<\/personality>\s*/gi;

/**
 * Remove a `<personality>` block someone else mounted (pi's prompt plugins mount
 * `PERSONALITY.md`), so a picked persona replaces it and the model sees exactly
 * one identity. Our own block is stripped the same way, which is what keeps the
 * forced prompt from growing a second copy each turn.
 */
export function stripPersonalityBlocks(prompt: string): string {
  return prompt.replace(PERSONALITY_BLOCK, "").trim();
}

export interface SectionPatchInput {
  /** The sections the run is about to build from, mutated in place. */
  sections: Record<string, string | null>;
  injection: { personality: string | null; rules: string | null };
  /** Section names this session's earlier turns wrote, i.e. safe to delete. */
  owned: ReadonlySet<string>;
}

export interface SectionPatchResult {
  /** Section names to add to `owned`, because this call wrote them. */
  claimed: string[];
  /** Section names to drop from `owned`, because this call removed them. */
  released: string[];
  changed: boolean;
}

/**
 * Apply the persona and rules to a run's sections.
 *
 * Setting is unconditional; deleting is not. A section this extension never
 * wrote belongs to somebody else (another extension's `PERSONALITY.md`, say) and
 * is left alone, so clearing our persona does not silently delete their work.
 */
export function patchSections({ sections, injection, owned }: SectionPatchInput): SectionPatchResult {
  const claimed: string[] = [];
  const released: string[] = [];
  let changed = false;

  const apply = (name: string, value: string | null) => {
    if (value) {
      if (sections[name] !== value) {
        sections[name] = value;
        changed = true;
      }
      claimed.push(name);
      return;
    }
    if (owned.has(name) && name in sections) {
      delete sections[name];
      changed = true;
      released.push(name);
    }
  };

  apply(PERSONALITY_SECTION, injection.personality);
  apply(RULES_SECTION, injection.rules);
  return { claimed, released, changed };
}

/** A message as pi hands it to a `context` handler. */
export interface ContextMessageLike {
  role?: string;
  content?: unknown;
}

interface TextBlockLike {
  type?: string;
  text?: string;
}

/**
 * Remove every `<personality>…</personality>` block from the transcript that is
 * about to be sent to the provider.
 *
 * A persona belongs to the system prompt, where this extension replaces and
 * deletes it. Copies of an old persona can still sit inside conversation
 * messages — a compaction summary that quoted the instructions, a custom message
 * from an earlier implementation, an assistant reply that echoed them. Those are
 * instruction text, not history worth keeping, so they are scrubbed on the way
 * out: the session file is never rewritten, only what the model is shown.
 *
 * What this deliberately does *not* touch: the model's own earlier replies. They
 * carry the persona's *style*, not its text, and removing them is a different
 * decision (dropping turns), made by `/rewind`.
 */
export function stripPersonalityFromMessages<T extends ContextMessageLike>(messages: T[]): boolean {
  let changed = false;

  const scrub = (text: string): string => {
    const next = text.replace(PERSONALITY_BLOCK, "");
    if (next === text) return text;
    changed = true;
    return next;
  };

  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string") {
      const next = scrub(content);
      if (next !== content) message.content = next;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as TextBlockLike[]) {
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      const next = scrub(block.text);
      if (next !== block.text) block.text = next;
    }
  }

  return changed;
}
