import { resolveAgentDir } from "./lib/agent-dir.ts";
import { PERSONALITY_SECTION, patchSystemSections, renderSection } from "./lib/inject.ts";
import type { BaseContext, CommandContext, ExtensionApi, SessionEntryLike } from "./lib/pi-api.ts";
import { listPersonas, personasDir, readPersonaText } from "./lib/personas.ts";
import { PERSONA_STATE_TYPE, resolvePersonaSelection } from "./lib/session-state.ts";

/** Pick a Markdown persona for the current conversation, without changing other prompt sections. */
export default function personaExtension(pi: ExtensionApi): void {
  const agentDir = resolveAgentDir();

  function selectionOf(ctx: BaseContext): string | null | undefined {
    const { sessionManager } = ctx;
    // Read beyond the active branch so rewinding never revives an old persona choice.
    let entries: SessionEntryLike[];
    try {
      entries = typeof sessionManager.getEntries === "function"
        ? sessionManager.getEntries()
        : sessionManager.getBranch();
    } catch {
      entries = [];
    }
    return resolvePersonaSelection(agentDir, entries);
  }

  function updateStatus(ctx: BaseContext): void {
    ctx.ui.setStatus("command:/persona", `🧑‍🎤 人设：${selectionOf(ctx) ?? "无"}`);
  }

  function recordPersona(ctx: CommandContext, personaId: string | null): void {
    try {
      pi.appendEntry(PERSONA_STATE_TYPE, { personaId });
    } catch (error) {
      ctx.ui.notify(`未能保存人设选择：${String(error)}`, "error");
      return;
    }
    updateStatus(ctx);
    ctx.ui.notify(`人设：${personaId ?? "无"}（本对话）`, "info");
  }

  async function pickPersona(ctx: CommandContext): Promise<void> {
    const current = selectionOf(ctx) ?? null;
    const personas = listPersonas(agentDir);
    const items = [{ id: null, name: "无人设" }, ...personas];
    const options = items.map(({ id, name }) => (id === current ? `● ${name}` : name));
    if (personas.length === 0) {
      ctx.ui.notify(`还没放人设文件：把 <名字>.md 放进 ${personasDir(agentDir)} 就会出现`, "info");
    }
    const choice = await ctx.ui.select("选择人设（本对话）", options);
    if (choice === undefined) return; // Esc does not change the selection.
    const item = items[options.indexOf(choice)];
    if (!item) return;
    if (item.id !== null && !listPersonas(agentDir).some(({ id }) => id === item.id)) {
      ctx.ui.notify(`没有「${item.name}」这个人设文件了`, "warning");
      return;
    }
    recordPersona(ctx, item.id);
  }

  pi.on("session_start", (_event, ctx) => updateStatus(ctx));

  pi.registerCommand("persona", {
    description: "选择、查看或关闭本对话的人设",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "" || arg === "pick") return pickPersona(ctx);
      if (arg === "off" || arg === "none" || arg === "无" || arg === "无人设") return recordPersona(ctx, null);

      const personas = listPersonas(agentDir);
      if (arg === "list") {
        const current = selectionOf(ctx);
        const names = personas.map(({ id, name }) => (id === current ? `●${name}` : name));
        ctx.ui.notify(
          names.length ? `人设：${names.join("、")}（当前：${current ?? "无"}）` : `personas 目录为空：${personasDir(agentDir)}`,
          "info",
        );
        return;
      }

      const found = personas.find(({ id }) => id === arg);
      if (found) return recordPersona(ctx, found.id);
      const names = personas.map(({ name }) => name);
      ctx.ui.notify(
        `没有「${arg}」这个人设。${names.length ? `可用：${names.join("、")}` : `请先在 ${personasDir(agentDir)} 放一个 <名字>.md`}`,
        "warning",
      );
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    const selection = selectionOf(ctx);
    if (selection === undefined) return; // Leave the host's default personality untouched.
    const text = readPersonaText(agentDir, selection);
    const options = event.systemPromptOptions ?? (event.systemPromptOptions = {});
    const otherSections = { ...options.sections };
    delete otherSections[PERSONALITY_SECTION];
    options.sections = text ? { [PERSONALITY_SECTION]: text, ...otherSections } : otherSections;
  });

  pi.on("context_with_system", (event, ctx) => {
    if (event.messages[0]?.role !== "system") return;
    const selection = selectionOf(ctx);
    if (selection === undefined) return;
    const text = readPersonaText(agentDir, selection);
    // Repair the persona delta after compaction without rewriting the system prompt or messages.
    patchSystemSections(event.messages, {
      [PERSONALITY_SECTION]: text ? renderSection(PERSONALITY_SECTION, text) : null,
    });
  });
}
