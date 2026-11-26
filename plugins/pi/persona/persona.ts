import { resolveAgentDir } from "./lib/agent-dir.ts";
import { PERSONALITY_SECTION, patchSystemSections, renderSection } from "./lib/inject.ts";
import type { BaseContext, CommandContext, ExtensionApi, SessionEntryLike } from "./lib/pi-api.ts";
import {
  createPersonaFile,
  ensurePersonasDir,
  isValidPersonaId,
  listPersonas,
  personasDir,
  readPersonaText,
  readSettings,
  writeSettings,
  type PersonaInjectMode,
  type PersonaSettings,
} from "./lib/personas.ts";
import { PERSONA_STATE_TYPE, resolvePersonaSelection } from "./lib/session-state.ts";

/** Pick a Markdown persona for the current conversation, without changing other prompt sections. */
export default function personaExtension(pi: ExtensionApi): void {
  const agentDir = resolveAgentDir();
  const createLabel = "＋ 新建人设…";

  function sessionEntriesOf(ctx: BaseContext): SessionEntryLike[] {
    try {
      return typeof ctx.sessionManager.getEntries === "function"
        ? ctx.sessionManager.getEntries()
        : ctx.sessionManager.getBranch();
    } catch {
      return [];
    }
  }

  function selectionOf(ctx: BaseContext): string | null | undefined {
    return resolvePersonaSelection(agentDir, sessionEntriesOf(ctx));
  }

  function updateStatus(ctx: BaseContext, settings: PersonaSettings = readSettings(agentDir)): void {
    const personaId = selectionOf(ctx);
    ctx.ui.setStatus("command:/persona", personaId ?? "无");
    if (typeof ctx.ui.setWidget === "function") {
      ctx.ui.setWidget(
        "persona",
        settings.showBadge && personaId ? [`🧑‍🎤 当前人设：${personaId}　·　输入 /persona 切换`] : undefined,
      );
    }
  }

  function recordPersona(ctx: CommandContext, personaId: string | null): void {
    if (personaId !== null && !readPersonaText(agentDir, personaId)) {
      ctx.ui.notify(`无法启用「${personaId}」：文件不存在、不可读、为空或超过 512 KiB。当前人设未更改。`, "warning");
      return;
    }
    try {
      pi.appendEntry(PERSONA_STATE_TYPE, { personaId });
    } catch (error) {
      ctx.ui.notify(`未能保存人设选择：${String(error)}`, "error");
      return;
    }
    updateStatus(ctx);
    ctx.ui.notify(personaId ? `已选「${personaId}」，从下一次模型请求起应用（本对话）` : "已关闭人设（本对话）", "info");
  }

  function saveSettings(ctx: CommandContext, patch: Partial<PersonaSettings>): PersonaSettings | null {
    try {
      const settings = writeSettings(patch, agentDir);
      updateStatus(ctx, settings);
      return settings;
    } catch (error) {
      ctx.ui.notify(`未能保存人设设置：${String(error)}`, "error");
      return null;
    }
  }

  async function createPersona(ctx: CommandContext): Promise<void> {
    const name = (await ctx.ui.input("新建人设：名称（不加 .md）", "例如：技术导师"))?.trim();
    if (name === undefined) return;
    if (!isValidPersonaId(name)) {
      ctx.ui.notify("请输入有效的人设名称（不要带路径或 .md 后缀）", "warning");
      return;
    }
    const body = await ctx.ui.editor(`新建人设：${name}（Markdown 正文）`, "");
    if (body === undefined) return;
    try {
      createPersonaFile(agentDir, name, body);
    } catch (error) {
      const message = (error as NodeJS.ErrnoException).code === "EEXIST"
        ? `「${name}」已存在，未覆盖原文件`
        : `未能新建人设：${String(error)}`;
      ctx.ui.notify(message, "error");
      return;
    }
    ctx.ui.notify(`已保存「${name}」。在 /persona 中选择后启用`, "info");
  }

  async function pickMode(ctx: CommandContext, settings: PersonaSettings): Promise<void> {
    const labels: Record<PersonaInjectMode, string> = {
      cached: "cached（结构化增量，保留提示词缓存）",
      "every-turn": "every-turn（每次模型请求重放完整系统提示词）",
    };
    const modes = Object.keys(labels) as PersonaInjectMode[];
    const options = modes.map((mode) => `${settings.mode === mode ? "●" : "○"} ${labels[mode]}`);
    const choice = await ctx.ui.select("注入模式（全局）", options);
    if (choice === undefined) return;
    const mode = modes[options.indexOf(choice)];
    if (!mode) return;
    if (saveSettings(ctx, { mode })) ctx.ui.notify(`注入模式：${mode}`, "info");
  }

  async function pickPersona(ctx: CommandContext): Promise<void> {
    const settings = readSettings(agentDir);
    const current = selectionOf(ctx) ?? null;
    const personas = listPersonas(agentDir);
    const items = [{ id: null, name: "无人设" }, ...personas];
    const options = items.map(({ id, name }) => `${id === current ? "●" : "○"} ${name}${id !== null ? ".md" : ""}`);
    const modeLabel = `⚙ 注入模式（当前 ${settings.mode}）`;
    const choice = await ctx.ui.select("选择人设（本对话）", [...options, createLabel, modeLabel]);
    if (choice === undefined) return;
    if (choice === createLabel) return createPersona(ctx);
    if (choice === modeLabel) return pickMode(ctx, settings);
    const item = items[options.indexOf(choice)];
    if (item) recordPersona(ctx, item.id);
  }

  pi.on("session_start", (_event, ctx) => {
    try {
      ensurePersonasDir(agentDir);
    } catch (error) {
      ctx.ui.notify(`无法准备人设目录 ${personasDir(agentDir)}：${String(error)}`, "warning");
    }
    updateStatus(ctx);
  });

  pi.registerCommand("persona", {
    description: "新建、选择、查看或关闭本对话的人设",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "" || arg === "pick") return pickPersona(ctx);
      if (arg === "new" || arg === "create") return createPersona(ctx);

      const settings = readSettings(agentDir);
      if (arg === "off" || arg === "none" || arg === "无" || arg === "无人设") return recordPersona(ctx, null);
      if (arg === "mode") return pickMode(ctx, settings);
      if (arg === "badge") {
        const showBadge = !settings.showBadge;
        if (saveSettings(ctx, { showBadge })) ctx.ui.notify(showBadge ? "已显示人设徽标" : "已隐藏人设徽标", "info");
        return;
      }

      const personas = listPersonas(agentDir);
      if (arg === "list") {
        const current = selectionOf(ctx);
        const names = personas.map(({ id, name }) => (id === current ? `●${name}` : name));
        ctx.ui.notify(
          names.length ? `人设：${names.join("、")}（当前：${current ?? "无"}，模式：${settings.mode}）` : `personas 目录为空：${personasDir(agentDir)}`,
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
    if (selection === undefined) return;
    const text = readPersonaText(agentDir, selection);
    const options = event.systemPromptOptions ?? (event.systemPromptOptions = {});
    const otherSections = { ...options.sections };
    delete otherSections[PERSONALITY_SECTION];
    options.sections = text ? { [PERSONALITY_SECTION]: text, ...otherSections } : otherSections;
  });

  pi.on("context_with_system", (event, ctx) => {
    if (event.messages[0]?.role !== "system") return;
    const settings = readSettings(agentDir);
    const selection = selectionOf(ctx);
    if (selection !== undefined) {
      const text = readPersonaText(agentDir, selection);
      patchSystemSections(event.messages, {
        [PERSONALITY_SECTION]: text ? renderSection(PERSONALITY_SECTION, text) : null,
      });
    }
    if (settings.mode !== "every-turn") return;

    // Fold the current prompt and tools after other prompt-building hooks, as the old bundle did.
    return import("@earendil-works/pi-ai").then(({ getCurrentSystemMessage }) => {
      const head = getCurrentSystemMessage(event.messages as Parameters<typeof getCurrentSystemMessage>[0]);
      if (head) return { messages: [head, ...event.messages.filter((message) => message.role !== "system")] };
    });
  });
}
