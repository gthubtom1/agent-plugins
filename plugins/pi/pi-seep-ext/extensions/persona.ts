import { resolveAgentDir } from "../lib/agent-dir.ts";
import {
  PERSONALITY_SECTION,
  RULES_SECTION,
  buildForcedPrefix,
  buildInjection,
  patchSections,
  stripPersonalityBlocks,
  stripPersonalityFromMessages,
} from "../lib/inject.ts";
import type {
  BeforeAgentStartEvent,
  CommandContext,
  ContextEvent,
  ContextWithSystemEvent,
  ExtensionApi,
  SessionEntryLike,
} from "../lib/pi-api.ts";
import {
  PERSONAS_DIR_NAME,
  listPersonas,
  personasDir,
  readPersonaText,
  readRulesText,
  readSettings,
  writeSettings,
  type PersonaInjectMode,
  type PersonaSettings,
} from "../lib/personas.ts";
import { PERSONA_STATE_TYPE, isPersonaStateType, readPersonaState } from "../lib/session-state.ts";

/**
 * Per-conversation personas, as a pi extension.
 *
 * The persona set is a directory (`<agentDir>/personas/*.md`); the file name is
 * the persona's name, so adding, renaming and retiring personas is done in a
 * file manager. Which persona a conversation uses is stored *in that
 * conversation* (an append-only session entry), which is what makes the choice
 * per-conversation rather than global, and what makes a rewind restore the
 * persona that was in force at that point in the branch.
 *
 * Entry points, in the order a person meets them:
 *
 * - the status line shows the current persona as a button (`人设 · 破甲v2`),
 *   because a slash command alone leaves you guessing which persona is active;
 * - clicking it, or typing `/persona`, opens a picker with a `无人设` row and a
 *   row that switches the injection mode;
 * - `/persona <name>` and `/persona off` skip the picker.
 */
export default function personaExtension(pi: ExtensionApi): void {
  const agentDir = resolveAgentDir();
  const STATUS_KEY = "command:/persona";
  const WIDGET_KEY = "persona";

  /**
   * Every entry the session has ever appended, in append order — *not* the
   * current branch.
   *
   * The persona is a setting of the conversation, so the last choice must win.
   * Reading only the branch made an undo resurrect a persona the user had just
   * switched off: rewinding to a message sent before the switch also rewound the
   * switch itself, and the old identity came back on the next turn. Entries stay
   * append-only and branch-shaped for everything else; this is the one place
   * that deliberately ignores the branch.
   */
  const sessionEntriesOf = (ctx: { sessionManager: { getEntries?(): SessionEntryLike[]; getBranch(): SessionEntryLike[] } }): SessionEntryLike[] => {
    try {
      const { sessionManager } = ctx;
      if (typeof sessionManager.getEntries === "function") return sessionManager.getEntries();
      return sessionManager.getBranch();
    } catch {
      return [];
    }
  };

  /**
   * The persona a branch is using: an explicit session entry wins (including an
   * explicit "none"), otherwise the configured default, and a default whose file
   * has since been deleted counts as none.
   */
  function currentPersona(branch: readonly SessionEntryLike[], settings: PersonaSettings): string | null {
    const recorded = readPersonaState(branch);
    if (recorded !== undefined) {
      return recorded && readPersonaText(agentDir, recorded) ? recorded : null;
    }
    if (!settings.defaultId) return null;
    return readPersonaText(agentDir, settings.defaultId) ? settings.defaultId : null;
  }

  /**
   * A section belongs to this extension once the branch carries one of its
   * entries. Before that it may be another extension's `PERSONALITY.md`, which
   * this extension must not delete when its own persona is cleared.
   */
  function ownedSections(branch: readonly SessionEntryLike[]): Set<string> {
    const used = branch.some((entry) => entry.type === "custom" && isPersonaStateType(entry.customType));
    return used ? new Set([PERSONALITY_SECTION, RULES_SECTION]) : new Set<string>();
  }

  function injectionFor(branch: readonly SessionEntryLike[], settings: PersonaSettings) {
    return buildInjection({
      personality: readPersonaText(agentDir, currentPersona(branch, settings)),
      rules: readRulesText(agentDir),
    });
  }

  /**
   * Where the current persona shows up, using only what an extension may paint:
   *
   * - a status cell under the composer. pi-web renders a `command:` key as a
   *   button that sends that slash command, so the label doubles as the entry
   *   point (`人设：色情破甲` → click → picker), on upstream pi-web as well;
   * - optionally a widget line in the same shelf, for people who want it bigger
   *   (`/persona badge on`). Widgets are display-only, so the status cell stays
   *   the clickable one.
   *
   * Nothing here needs a pi-web change: both are plain `ctx.ui` calls, and the
   * TUI shows the same status text.
   */
  function updateIndicators(
    ctx: { ui: { setStatus(key: string, text?: string): void; setWidget?(key: string, content?: string[]): void }; sessionManager: { getEntries?(): SessionEntryLike[]; getBranch(): SessionEntryLike[] } },
    settings: PersonaSettings = readSettings(agentDir),
  ): void {
    const personaId = currentPersona(sessionEntriesOf(ctx), settings);
    ctx.ui.setStatus(STATUS_KEY, personaId ? `🧑‍🎤 人设：${personaId}` : "🧑‍🎤 人设：无");
    if (typeof ctx.ui.setWidget === "function") {
      ctx.ui.setWidget(
        WIDGET_KEY,
        settings.showBadge && personaId ? [`🧑‍🎤 当前人设：${personaId}　·　输入 /persona 切换`] : undefined,
      );
    }
  }

  function recordPersona(ctx: CommandContext, personaId: string | null): void {
    pi.appendEntry(PERSONA_STATE_TYPE, { personaId });
    updateIndicators(ctx);
    ctx.ui.notify(personaId ? `人设：${personaId}（本对话）` : "人设：无（本对话）", "info");
  }

  async function pickMode(ctx: CommandContext, settings: PersonaSettings): Promise<void> {
    const labels: Record<PersonaInjectMode, string> = {
      cached: "cached（省 token，走提示词缓存）",
      "every-turn": "every-turn（每轮强制写进系统提示词）",
    };
    const options = (Object.keys(labels) as PersonaInjectMode[]).map(
      (mode) => (settings.mode === mode ? `● ${labels[mode]}` : labels[mode]),
    );
    const choice = await ctx.ui.select("注入模式（全局，影响所有人设）", options);
    if (choice === undefined) return;
    const mode: PersonaInjectMode = choice.includes("cached") ? "cached" : "every-turn";
    writeSettings({ mode }, agentDir);
    ctx.ui.notify(`注入模式：${mode}`, "info");
  }

  async function pickPersona(ctx: CommandContext): Promise<void> {
    const settings = readSettings(agentDir);
    const current = currentPersona(sessionEntriesOf(ctx), settings);
    const personas = listPersonas(agentDir);
    const modeLabel = `⚙ 注入模式（当前 ${settings.mode}）`;
    const options = [
      current ? "无人设" : "● 无人设",
      ...personas.map((persona) => (persona.id === current ? `● ${persona.name}` : persona.name)),
      modeLabel,
    ];
    if (personas.length === 0) {
      ctx.ui.notify(`还没放人设文件：把 <名字>.md 放进 ${personasDir(agentDir)} 就会出现`, "info");
    }
    const choice = await ctx.ui.select("选择人设（本对话）", options);
    if (choice === undefined) return; // Esc: change nothing, rather than silently clearing.
    if (choice === modeLabel) return pickMode(ctx, settings);
    const name = choice.replace(/^● /, "");
    if (name === "无人设") return recordPersona(ctx, null);
    const found = personas.find((persona) => persona.name === name || persona.id === name);
    if (!found) {
      ctx.ui.notify(`没有「${name}」这个人设文件了`, "warning");
      return;
    }
    recordPersona(ctx, found.id);
  }

  pi.on("session_start", (_event, ctx) => {
    updateIndicators(ctx as unknown as CommandContext);
  });

  pi.registerCommand("persona", {
    description: "选择本对话的人设（无人设 / 各 personas 文件）、切换注入模式",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "" || arg === "pick") return pickPersona(ctx);

      const settings = readSettings(agentDir);
      if (arg === "off" || arg === "none" || arg === "无" || arg === "无人设") return recordPersona(ctx, null);
      if (arg === "mode") return pickMode(ctx, settings);
      if (arg === "badge") {
        const showBadge = !settings.showBadge;
        writeSettings({ showBadge }, agentDir);
        updateIndicators(ctx);
        ctx.ui.notify(showBadge ? "已显示人设徽标（输入框上方一行）" : "已隐藏人设徽标", "info");
        return;
      }
      if (arg === "list") {
        const personas = listPersonas(agentDir);
        const current = currentPersona(sessionEntriesOf(ctx), settings);
        ctx.ui.notify(
          personas.length === 0
            ? `personas 目录为空：${agentDir}/personas`
            : `人设：${personas.map((persona) => (persona.id === current ? `●${persona.name}` : persona.name)).join("、")}（当前：${current ?? "无"}，模式：${settings.mode}）`,
          "info",
        );
        return;
      }

      const found = listPersonas(agentDir).find((persona) => persona.id === arg || persona.name === arg);
      if (!found) {
        const names = listPersonas(agentDir).map((persona) => persona.name);
        ctx.ui.notify(
          `没有「${arg}」这个人设。${names.length ? `可用：${names.join("、")}` : `请先在 ${agentDir}/${PERSONAS_DIR_NAME}/ 放一个 <名字>.md`}`,
          "warning",
        );
        return;
      }
      return recordPersona(ctx, found.id);
    },
  });

  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx) => {
    try {
      const branch = sessionEntriesOf(ctx as unknown as CommandContext);
      const settings = readSettings(agentDir);
      const injection = injectionFor(branch, settings);
      const owned = ownedSections(branch);

      if (settings.mode === "every-turn") {
        // Drop any section this extension wrote in cached mode, so the forced
        // prompt is the only copy of the persona.
        const sections = event.systemPromptOptions?.sections;
        if (sections) patchSections({ sections, injection: { personality: null, rules: null }, owned });

        const prefix = buildForcedPrefix(injection);
        if (!prefix) return undefined;
        const base = injection.personality
          ? stripPersonalityBlocks(event.systemPrompt || "")
          : (event.systemPrompt || "").trim();
        return { systemPrompt: base ? `${prefix}\n\n${base}` : prefix };
      }

      // cached: the persona lives in structured sections, which pi diffs against
      // the transcript, so the prompt stays byte-identical between turns and the
      // provider's cache keeps working. Clearing the persona deletes the section
      // (pi records `{personality: null}`), which is what makes "无人设" real.
      const options = event.systemPromptOptions ?? (event.systemPromptOptions = {});
      options.sections = options.sections ?? {};
      patchSections({ sections: options.sections, injection, owned });

      // Another extension may force an opaque prompt; sections would be dropped
      // silently, so force the same text into that prompt as well.
      if (options.forceSystemPrompt !== undefined) {
        const prefix = buildForcedPrefix(injection);
        if (!prefix) return undefined;
        const base = injection.personality
          ? stripPersonalityBlocks(event.systemPrompt || options.forceSystemPrompt)
          : (event.systemPrompt || options.forceSystemPrompt).trim();
        return { systemPrompt: base ? `${prefix}\n\n${base}` : prefix };
      }
      return undefined;
    } catch {
      // A prompt hook must never break a run: fall back to pi's own prompt.
      return undefined;
    }
  });

  /**
   * History carries no persona *text*.
   *
   * Switching personas replaces the prompt, but copies of the old instructions
   * can survive inside messages: a compaction summary that quoted them, a custom
   * message from another implementation, an assistant reply that echoed them.
   * Those are instructions, not history, so they are removed from what the model
   * is shown. The session file is untouched, and everything else in the message
   * stays byte for byte — which is why this cannot damage the conversation.
   *
   * It does not, and cannot, remove the *style* of earlier replies: that is the
   * model's own output, and dropping those turns is `/rewind`'s job.
   */
  pi.on("context", (event: ContextEvent) => {
    try {
      if (!stripPersonalityFromMessages(event.messages)) return undefined;
      return { messages: event.messages };
    } catch {
      return undefined;
    }
  });

  // cached mode: keep the sections present after a compaction rewrote the prompt.
  pi.on("context_with_system", (event: ContextWithSystemEvent, ctx) => {
    try {
      const settings = readSettings(agentDir);
      if (settings.mode !== "cached") return undefined;
      const head = event.messages[0];
      if (!head || head.role !== "system") return undefined;
      stripPersonalityFromMessages(event.messages);
      const branch = sessionEntriesOf(ctx as unknown as CommandContext);
      head.sections = head.sections ?? {};
      patchSections({ sections: head.sections, injection: injectionFor(branch, settings), owned: ownedSections(branch) });
      return undefined;
    } catch {
      return undefined;
    }
  });
}
