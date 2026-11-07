import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { evaluate } from "./src/policy.mjs";
import { buildArgs, parseOutput } from "./src/everything.mjs";

const run = promisify(execFile);

// Injected once per turn so the model knows the rules before it writes a command,
// instead of discovering them by being rejected.
const GUIDANCE = [
  "Shell guard is active in this profile:",
  "- Every command gets a timeout by class (fast 60s, default 120s, heavy 900s) unless you pass one explicitly.",
  "- Whole-disk searches are refused. Git Bash `/` is the whole machine. Use search_files for filename lookups, and rg inside the case/project for content.",
  "- Deletes are tiered: generated dirs inside the project are allowed; a folder the user named in their own message is allowed; globs and anything else recursive outside the project need the user; drive roots, home root and system dirs are always refused.",
  "- Servers, log followers and device waits must run detached: cmd > .pi/logs/x.log 2>&1 </dev/null &",
  "- If a search finds nothing, narrow the root and state what was searched. Do not repeat the same command.",
].join("\n");

const string = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

function result(value: unknown, max = 20000) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text: text.length > max ? `${text.slice(0, max)}\n…truncated` : text }] };
}

function resolveReal(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    try {
      return realpathSync(target);
    } catch {
      return target;
    }
  }
}

type Settings = Record<string, unknown> & { everything?: { esPath?: string; maxResults?: number } };

/**
 * Pi wiring. All decisions come from src/policy.mjs; this file only adapts
 * events, and fails open on any internal error so a plugin bug can never wedge
 * the user's shell.
 */
export default function shellGuard(pi: ExtensionAPI) {
  // The user's own words for the current turn. The model cannot write these, so
  // they are the only source of a deletion grant.
  let lastUserPrompt = "";

  const readSettings = (): Settings => {
    try {
      const settings = (pi as unknown as { settings?: { shellGuard?: Settings } }).settings?.shellGuard;
      if (settings && typeof settings === "object") return settings;
    } catch {
      // ignore
    }
    const esPath = process.env.PI_SHELL_GUARD_ES;
    return esPath ? { everything: { esPath } } : {};
  };

  pi.on("before_agent_start", (event) => {
    try {
      if (event.messageType !== "custom" && typeof event.prompt === "string") {
        lastUserPrompt = event.prompt;
      }
      const options = event.systemPromptOptions as { sections?: Record<string, string> } | undefined;
      if (options?.sections) options.sections.shell_guard = GUIDANCE;
    } catch {
      // prompt capture and guidance are conveniences; the guards still work
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (!isToolCallEventType("bash", event)) return;
      const input = event.input as { command?: unknown; timeout?: unknown };
      if (typeof input.command !== "string") return; // API drift: stay out of the way

      const cwd = (ctx as unknown as { cwd?: string }).cwd ?? process.cwd();
      const decision = evaluate(input.command, {
        cwd,
        projectRoot: cwd,
        explicitTimeout: typeof input.timeout === "number" ? input.timeout : undefined,
        settings: readSettings(),
        userText: lastUserPrompt,
        realpath: resolveReal,
      });

      if (decision.action === "block") {
        return { block: true, reason: decision.reason ?? "shell-guard: blocked" };
      }

      if (decision.action === "confirm") {
        const host = ctx as unknown as {
          hasUI?: boolean;
          ui?: { select?: (title: string, options: string[]) => Promise<string | undefined> };
        };
        // Headless sessions must never auto-approve: without a human in front of
        // the dialog there is no confirmation, only an implicit yes.
        if (host.hasUI !== true || typeof host.ui?.select !== "function") {
          return {
            block: true,
            reason: `需要用户确认：${decision.reason ?? "该操作影响范围不确定"} 请先在对话里明确同意，或把目标路径写清楚。`,
          };
        }
        const choice = await ui.select(`确认删除？\n${decision.reason ?? ""}`, ["允许删除", "取消"]);
        if (choice !== "允许删除") return { block: true, reason: "用户取消了该删除。" };
      }

      if (decision.timeout && typeof input.timeout !== "number") {
        input.timeout = decision.timeout;
      }
    } catch {
      // fail open
    }
  });

  pi.registerTool({
    name: "search_files",
    label: "Search files by name",
    description:
      "Find files by name or path anywhere on this machine through the Everything index. Millisecond lookups, bounded result count. This searches file names only; for file contents use rg inside the case directory.",
    promptSnippet: "Find files by name anywhere on this machine (fast, Everything)",
    parameters: object(
      {
        query: string("File name, path fragment or Everything wildcard"),
        limit: { type: "integer", minimum: 1, maximum: 200 },
        path: string("Restrict the search to this directory"),
        regex: { type: "boolean" },
        foldersOnly: { type: "boolean" },
      },
      ["query"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    async execute(_id, params) {
      const settings = readSettings();
      const esPath = settings.everything?.esPath;
      if (!esPath) {
        throw new Error(
          "search_files 不可用：未配置 es.exe 路径（settings: shellGuard.everything.esPath 或 PI_SHELL_GUARD_ES）。请改用 rg 限定在 case/项目目录内搜索。",
        );
      }
      const args = buildArgs(params.query, {
        limit: params.limit ?? settings.everything?.maxResults ?? 50,
        path: params.path,
        regex: params.regex,
        foldersOnly: params.foldersOnly,
      });
      try {
        const { stdout } = await run(esPath, args, { timeout: 15000, windowsHide: true });
        const paths = parseOutput(stdout);
        return result({ backend: "everything", count: paths.length, paths });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `search_files 失败：${message}。Everything 必须正在运行且 es.exe 路径正确；这不是"没有找到文件"。`,
        );
      }
    },
  });
}
