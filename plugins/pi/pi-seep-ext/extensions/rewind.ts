import { formatCandidate, lastReplyOnlyTurn, listRewindCandidates, pickerOptions } from "../lib/rewind-targets.ts";
import type { CommandContext, ExtensionApi } from "../lib/pi-api.ts";

/**
 * Undoing a turn, as a pi extension.
 *
 * Nothing here edits a session file. Pi stores a session as a tree and the
 * branch in force is the path from the root to the current leaf, so "rewind"
 * is moving the leaf back (`navigateTree`): the turn leaves the context, the
 * entries stay in the file, and going forward again is possible. That is the
 * supported API, and it cannot corrupt a session the way truncating JSONL can.
 *
 * Two commands, because the two intents differ:
 *
 * - `/rewind` — pick any earlier user message, confirm when the turn did tool
 *   work, then put that message back in the composer as a draft.
 * - `/undo-reply` — the one-command case: drop the last reply when it is the end
 *   of the branch and did no tool work, which is how a refused turn is re-asked.
 */
export default function rewindExtension(pi: ExtensionApi): void {
  pi.registerCommand("rewind", {
    description: "回退到某条用户消息之前（原文放回输入框）",
    handler: async (args, ctx: CommandContext) => {
      const entries = ctx.sessionManager.getBranch();
      const candidates = listRewindCandidates(entries);
      if (candidates.length === 0) {
        ctx.ui.notify("本对话还没有可以回退的用户消息", "info");
        return;
      }

      if (args.trim() === "list") {
        // A long conversation would otherwise dump every turn into one notice.
        const shown = candidates.slice(-15);
        const hidden = candidates.length - shown.length;
        ctx.ui.notify(
          [...(hidden > 0 ? [`…更早的 ${hidden} 条未显示`] : []), ...shown.map(formatCandidate)].join("\n"),
          "info",
        );
        return;
      }

      const { labels, ordered } = pickerOptions(candidates);
      const choice = await ctx.ui.select(
        "回退到哪条消息之前（该消息及之后的内容移出上下文，原文放回输入框）",
        labels,
      );
      if (choice === undefined) return;

      const picked = ordered[labels.indexOf(choice)];
      if (!picked) return;

      if (picked.hasToolWork) {
        const ok = await ctx.ui.confirm(
          `第 ${picked.turn} 条消息之后有工具调用`,
          "回退会把这些工具调用和结果一起移出上下文（文件、命令产生的效果不会被撤销）。继续？",
        );
        if (!ok) return;
      }

      try {
        const result = await ctx.navigateTree(picked.entryId, { summarize: false });
        if (result?.cancelled) return;
      } catch (error) {
        // pi refuses navigation while a run or a compaction is in flight.
        ctx.ui.notify(
          `现在不能回退：${error instanceof Error ? error.message : String(error)}\n等这一轮结束再试。`,
          "warning",
        );
        return;
      }

      ctx.ui.setEditorText(picked.text);
      ctx.ui.notify(`已回退到第 ${picked.turn} 条消息之前，原文已放回输入框`, "info");
    },
  });

  pi.registerCommand("undo-reply", {
    description: "只删掉最后一条回复（无工具调用时），把问题放回输入框重问",
    handler: async (_args, ctx: CommandContext) => {
      const target = lastReplyOnlyTurn(ctx.sessionManager.getBranch());
      if (!target) {
        ctx.ui.notify(
          "最后一条不是纯文本回复（带工具调用，或后面还有别的内容）。用 /rewind 手动选并确认。",
          "warning",
        );
        return;
      }

      try {
        const result = await ctx.navigateTree(target.entryId, { summarize: false });
        if (result?.cancelled) return;
      } catch (error) {
        ctx.ui.notify(
          `现在不能回退：${error instanceof Error ? error.message : String(error)}\n等这一轮结束再试。`,
          "warning",
        );
        return;
      }

      ctx.ui.setEditorText(target.text);
      ctx.ui.notify(`已删除最后一条回复，第 ${target.turn} 条问题已放回输入框`, "info");
    },
  });
}
