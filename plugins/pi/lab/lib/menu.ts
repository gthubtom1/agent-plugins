import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addPhrase, phraseLabel, readPhrases, replacePhrase, type Phrase } from "./store.ts";

const ADD = "＋ 新增常用语";
const EDIT = "✎ 修改常用语";
const DELETE = "× 删除常用语";

export function registerLab(pi: ExtensionAPI, file: string): void {
  const paintStatus = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setStatus("command:/lab", "常用");
  };

  async function pickPhrase(ctx: ExtensionCommandContext, title: string): Promise<Phrase | undefined> {
    const { phrases } = readPhrases(file);
    if (!phrases.length) {
      ctx.ui.notify("还没有常用语，请先选择「新增常用语」。", "info");
      return;
    }
    const labels = phrases.map(phraseLabel);
    const choice = await ctx.ui.select(title, labels);
    return choice === undefined ? undefined : phrases[labels.indexOf(choice)];
  }

  async function editText(ctx: ExtensionCommandContext, original?: Phrase): Promise<void> {
    let text = original?.text ?? "";
    for (;;) {
      const result = await ctx.ui.editor(
        original ? "LAB · 修改常用语（提交后保存，不发送对话）" : "LAB · 新增常用语（支持多行，提交后保存）",
        text,
      );
      if (result === undefined) return;
      text = result;
      if (!text.trim()) {
        ctx.ui.notify("请输入常用语；取消可返回列表。", "warning");
        continue;
      }
      if (original) replacePhrase(file, original, text);
      else addPhrase(file, text);
      ctx.ui.notify("常用语已保存。", "info");
      return;
    }
  }

  async function menu(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) return;
    paintStatus(ctx);
    for (;;) {
      const { phrases } = readPhrases(file);
      const labels = phrases.map(phraseLabel);
      const choice = await ctx.ui.select(
        "LAB · 常用语（点击条目填入输入框）",
        [...labels, ADD, EDIT, DELETE],
      );
      if (choice === undefined) return;
      if (choice === ADD) {
        await editText(ctx);
      } else if (choice === EDIT) {
        const phrase = await pickPhrase(ctx, "LAB · 选择要修改的常用语");
        if (phrase) await editText(ctx, phrase);
      } else if (choice === DELETE) {
        const phrase = await pickPhrase(ctx, "LAB · 选择要删除的常用语");
        if (phrase && await ctx.ui.confirm("删除这条常用语？", phrase.text)) {
          replacePhrase(file, phrase);
          ctx.ui.notify("常用语已删除。", "info");
        }
      } else {
        const picked = phrases[labels.indexOf(choice)];
        if (!picked) continue;
        // Re-read in case a second session changed this item while the picker was open.
        const current = readPhrases(file).phrases.find((p) => p.id === picked.id);
        if (!current) {
          ctx.ui.notify("这条常用语已被删除，请重新选择。", "warning");
          continue;
        }
        ctx.ui.setEditorText(`lab:${current.text}`);
        return;
      }
    }
  }

  const handler = async (_args: string, ctx: ExtensionCommandContext) => {
    try {
      await menu(ctx);
    } catch (error) {
      ctx.ui.notify(`LAB：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  pi.on("session_start", (_event, ctx) => paintStatus(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("command:/lab", undefined);
  });
  pi.registerCommand("lab", { description: "常用语：新增、修改、删除，添加 lab: 前缀填入输入框", handler });
  pi.registerCommand("LAB", { description: "打开 LAB 常用语菜单（/lab 的大写别名）", handler });
}
