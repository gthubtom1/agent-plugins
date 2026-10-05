/**
 * cmd-guard —— 命令执行物理守卫（pi 扩展）
 *
 * 病根：pi 的 bash 工具 `timeout` 是 optional，**不传就无限等**（bash.js:30
 * `Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }))`）。
 * 模型在工具阻塞期间不在运行、没有任何代码在跑，所以它永远不可能自己发现
 * 命令卡住 —— 「终端计时器涨 + token 计数静止」= 卡在命令，不是卡在推理。
 *
 * 本扩展挂在 `tool_call` 上，改写模型发出的参数（原地改 event.input）或直接拦下，
 * 因此模型即使写错也**物理上跑不超时**。
 *
 * 三件事：
 *   1. 补默认 timeout（按命令分类：探查 / 分析 / 构建·虚拟机）
 *   2. 拦 GUI/交互式二进制（规则从 tool-index 派生 + 内置兜底，不硬编码单一工具）
 *   3. 让卡住这件事在 CLI 里看得见：底栏实时状态 + /stall 报告
 *
 * 规则来源优先级：同目录 cmd-guard.rules.json > skills/tool-index.md（若已产出
 * 运行模式列）> 内置表。索引是 skills 包自动生成的生成物，所以索引里的标注会
 * 自动生效，本文件不需要跟着每加一个工具就改。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

/* ────────────────────────────── 类型 ────────────────────────────── */

type TextContent = { type: "text"; text: string };

type GuardConfig = {
	defaultTimeout: number;
	probeTimeout: number;
	heavyTimeout: number;
	stallSeconds: number;
	noOutputStallSeconds: number;
	enforce: boolean;
	guiBinaries: string[];
	allow: string[];
	indexPaths: string[];
};

type CallRecord = {
	toolCallId: string;
	toolName: string;
	command: string;
	shell: "bash" | "powershell";
	startedAt: number;
	lastOutputAt: number;
	injected: string[];
	notes: string[];
	ownTimeout: number | null;
};

type HistoryEntry = {
	at: string;
	toolName: string;
	head: string;
	seconds: number;
	verdict: string;
};

const HERE = __dirname;
const DEFAULTS: GuardConfig = {
	defaultTimeout: 120,
	probeTimeout: 30,
	heavyTimeout: 600,
	stallSeconds: 240,
	noOutputStallSeconds: 90,
	enforce: true,
	guiBinaries: [],
	allow: [],
	indexPaths: [
		"D:\\Project\\skills-hub\\integrated-skill-hub\\skills\\tool-index.md",
		"D:\\Project\\skills-hub\\integrated-skill-hub\\skills\\tool-index.json",
	],
};

/** 内置兜底表：索引里没标注时，至少拦住这些「会弹窗 / 会等人」的二进制。 */
const BUILTIN_GUI: { name: string; use: string }[] = [
	{ name: "die.exe", use: "D:\\HACKER\\DIE\\diec.exe（CLI 版，`diec.exe -d -j <file>`）" },
	{ name: "msiexec.exe", use: "加 /quiet /norestart，或改用 winget/choco" },
	{ name: "notepad.exe", use: "改用 edit/write 工具直接落盘" },
	{ name: "explorer.exe", use: "改用 ls/read/find 工具" },
	{ name: "taskmgr.exe", use: "改用 tasklist / taskkill 命令行" },
	{ name: "regedit.exe", use: "改用 reg add / reg query 命令行" },
	{ name: "control.exe", use: "改用 services.msc 无关的命令行工具" },
	{ name: "mmc.exe", use: "改用命令行等价工具" },
	{ name: "wireshark.exe", use: "tshark.exe（CLI 版，支持 -r/-i/-w）" },
	{ name: "procmon.exe", use: "procmon64.exe /B 批处理模式或 Sysmon CLI" },
	{ name: "ida.exe", use: "idalib-mcp（MCP）或 Ghidra analyzeHeadless（无头）" },
	{ name: "ida64.exe", use: "idalib-mcp（MCP）或 Ghidra analyzeHeadless（无头）" },
	{ name: "x64dbg.exe", use: "x32dbg/x64dbg 需 GUI 动态调试 —— 起在目标环境自己的交互式桌面会话里，不要经 bash 拉起" },
	{ name: "x32dbg.exe", use: "同上：动态调试需要交互式桌面会话，不要在 bash 里拉起" },
	{ name: "binaryninja.exe", use: "Binary Ninja 的 Python API / headless" },
];

/* ────────────────────────── 规则加载（含缓存） ────────────────────────── */

let config: GuardConfig = { ...DEFAULTS };
/** 解释器/包管理器：它们跑的是任意脚本，索引里的短探查值不能当硬上限，故不采纳索引 timeout。 */
const INTERPRETERS = new Set(["python", "python3", "py", "pip", "pip3", "node", "npx", "npm", "java", "dotnet", "bash", "sh", "cmd", "powershell"]);

/** 从 tool-index.md 读「默认 timeout」列。返回 Map<可执行名或stem, 秒>。 */
function deriveTimeoutsFromIndexMd(file: string): Map<string, number> {
	const out = new Map<string, number>();
	let text = "";
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch {
		return out;
	}
	const lines = text.split(/\r?\n/);
	let tCol = -1;
	let nameCol = -1;
	let pathCol = -1;
	for (const line of lines) {
		if (!line.trim().startsWith("|")) continue;
		const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
		if (cells[0] !== "工具") continue;
		nameCol = cells.indexOf("工具");
		tCol = cells.indexOf("默认 timeout");
		// 路径列表头改名过（路径 → 路径(相对根)），两种都认
		pathCol = cells.indexOf("路径(相对根)");
		if (pathCol < 0) pathCol = cells.indexOf("路径");
		break;
	}
	if (tCol < 0) return out;
	for (const line of lines) {
		if (!line.trim().startsWith("|")) continue;
		const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
		if (cells.length <= tCol || cells[nameCol] === "工具") continue;
		const name = cells[nameCol] ?? "";
		const secs = parseInt(cells[tCol], 10);
		if (!name || name === "—" || !Number.isFinite(secs) || secs <= 0) continue;
		out.set(name.toLowerCase(), secs);
		const pathCell = (pathCol >= 0 ? cells[pathCol] : "") ?? "";
		for (const exe of pathCell.match(/[\w.\-]+\.(exe|bat|cmd)/gi) || []) {
			out.set(exe.toLowerCase(), secs);
			out.set(exe.replace(/\.(exe|bat|cmd)$/i, "").toLowerCase(), secs);
		}
	}
	return out;
}

let guiTable: Map<string, string> = new Map();
let indexTimeouts: Map<string, number> = new Map();
let rulesSource = "内置基线";
let loadedAt = 0;
let loadedStamp = "";
let rulesMtime = 0;

function rulesPath(): string {
	return path.join(HERE, "cmd-guard.rules.json");
}

function mtimeOf(p: string): string {
	try {
		return String(fs.statSync(p).mtimeMs);
	} catch {
		return "0";
	}
}

/**
 * 从 tool-index.md 派生 GUI 规则。两种表头都支持：
 *  A. 新格式（有独立的「运行模式」列，值 CLI / GUI / MCP / CLI+MCP）
 *  B. 旧格式（无该列，靠「CLI=是/否」「GUI 版」这类 token 识别）
 * 解析不到任何 GUI 行时返回空表，调用方回落到内置基线。
 */
function deriveFromIndexMd(file: string): Map<string, string> {
	const out = new Map<string, string>();
	let text = "";
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch {
		return out;
	}

	const lines = text.split(/\r?\n/);
	// 定位表头行，读出列顺序
	let modeCol = -1;
	let pathCol = -1;
	let nameCol = -1;
	let verifyCol = -1;
	for (const line of lines) {
		if (!line.trim().startsWith("|")) continue;
		const cells = line
			.split("|")
			.map((c) => c.trim())
			.filter((c) => c.length > 0);
		if (cells[0] !== "工具") continue;
		modeCol = cells.indexOf("运行模式");
		nameCol = cells.indexOf("工具");
		// 路径列表头改名过（路径 → 路径(相对根)），两种都认
		pathCol = cells.indexOf("路径(相对根)");
		if (pathCol < 0) pathCol = cells.indexOf("路径");
		verifyCol = cells.indexOf("验证命令");
		break;
	}
	const structured = modeCol > 0;

	if (!structured && !/CLI\s*[:：=]|GUI\s*版|禁止经\s*bash|禁止.{0,4}bash/i.test(text)) return out;

	// CLI 孪生表：basename(去 .exe/.bat/.cmd) -> 该 CLI 行的可执行名，用于给 GUI 行算「改用 X」
	const cliTwin = new Map<string, string>();

	const parse = (line: string): string[] | null => {
		if (!line.trim().startsWith("|")) return null;
		const cells = line
			.split("|")
			.map((c) => c.trim())
			.filter((c) => c.length > 0);
		if (cells.length < 3) return null;
		if (/^-+$/.test(cells[0])) return null;
		return cells;
	};

	if (structured) {
		for (const line of lines) {
			const cells = parse(line);
			if (!cells || cells[nameCol] === "工具") continue;
			if (cells.length <= modeCol) continue;
			const mode = cells[modeCol] ?? "";
			const name = cells[nameCol] ?? "";
			const pathCell = (pathCol >= 0 ? cells[pathCol] : "") ?? "";
			const verifyCell = (verifyCol >= 0 ? cells[verifyCol] : "") ?? "";
			if (!name || name === "—") continue;
			// 能力状态视图等其它表：没有运行模式列的行直接跳过
			if (!/^(CLI|GUI|MCP|CLI\+MCP)$/.test(mode)) continue;
			const isGui = mode === "GUI";
			const exes = pathCell.match(/[\w.\-]+\.(exe|bat|cmd|ps1|jar)/gi) || [];
			if (!isGui) {
				// CLI 孪生：记录 xxx(去扩展名) -> 可执行名，供同名 GUI 行反查
				for (const exe of exes) cliTwin.set(exe.replace(/\.(exe|bat|cmd)$/i, "").toLowerCase(), exe);
				continue;
			}
			let hint = "";
			if (verifyCell && verifyCell !== "—") hint = verifyCell;
			if (!exes.length) {
				// PE-bear / jeb-pro 等无 .exe 出现在路径的：仍按名字登记
				out.set(name.toLowerCase(), hint || "tool-index.md 标为 GUI，无 CLI 孪生行");
				continue;
			}
			for (const exe of exes) {
				const base = exe.toLowerCase();
				const stem = base.replace(/\.(exe|bat|cmd)$/, "");
				// CLI 孪生：先按同名 stem 查，再查经典的 x -> xc（die -> diec, jadx -> jadx）
				let twin = cliTwin.get(stem);
				if (!twin || twin.toLowerCase() === base) twin = cliTwin.get(stem + "c");
				let alt: string;
				if (twin && twin.toLowerCase() !== base) {
					alt = `${twin}（CLI 孪生）`;
				} else if (verifyCell && verifyCell !== "—" && !/GUI|无\s*CLI|禁/.test(verifyCell)) {
					alt = `${verifyCell.split(" ")[0]}（CLI 孪生；验证：${verifyCell}）`;
				} else if (verifyCell && verifyCell !== "—") {
					alt = `无 CLI 孪生；${verifyCell}`;
				} else {
					alt = "见 tool-index.md 同名 CLI 孪生行";
				}
				out.set(base, alt);
			}
		}
		return out;
	}

	// 旧格式兼容分支：保留原有 token 识别
	for (const line of lines) {
		const cells = parse(line);
		if (!cells) continue;
		const joined = cells.join(" ");
		const isGui = /GUI\s*版|禁止经\s*bash|CLI\s*[:：=]\s*(否|no|false)|禁止.{0,6}(弹窗|执行)/i.test(joined);
		const isCli = /CLI\s*[:：=]\s*(是|yes|true)|CLI\s*版/i.test(joined);
		if (!isGui && !isCli) continue;
		const exes = joined.match(/[\w.\-]+\.(exe|bat|cmd|ps1|py|jar)/gi) || [];
		const cliHint = joined.match(/改用\s*([^\s，。；|]+)/);
		const hint = cliHint ? cliHint[1] : "";
		for (const exe of exes) {
			const base = exe.toLowerCase();
			if (isGui || !exes.some((o) => o.toLowerCase().replace(/c\.(exe|bat)$/, ".$1") === base.replace(/c\.(exe|bat)$/, ".$1"))) {
				out.set(base, hint || "见 tool-index.md 同行的 CLI 条目");
			}
		}
	}
	return out;
}

function loadConfig(force = false): void {
	const now = Date.now();
	const stamp = mtimeOf(rulesPath());
	if (!force && stamp === loadedStamp && now - loadedAt < 30_000) return;

	loadedStamp = stamp;
	loadedAt = now;
	rulesMtime = Number(stamp) || 0;

	config = { ...DEFAULTS };
	try {
		const p = rulesPath();
		if (fs.existsSync(p)) {
			const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<GuardConfig>;
			config = { ...config, ...raw };
			config.indexPaths = raw.indexPaths?.length ? raw.indexPaths : DEFAULTS.indexPaths;
		}
	} catch {
		/* 规则文件坏了就用默认值，不让守卫自己变成故障源 */
	}

	// 优先级（后者覆盖前者）：内置基线 → 索引派生 → rules.json 手工条目。
	// 手工条目最后写入，因此可以覆盖索引派生的同键条目。
	guiTable = new Map();
	for (const g of BUILTIN_GUI) guiTable.set(g.name.toLowerCase(), g.use);
	rulesSource = "内置基线";
	let derivedCount = 0;
	for (const idx of config.indexPaths) {
		if (idx.endsWith(".json")) continue;
		for (const [k, v] of deriveFromIndexMd(idx)) {
			guiTable.set(k, v);
			derivedCount++;
		}
	}
	if (derivedCount > 0) rulesSource = `索引派生(${derivedCount}条)`;
	indexTimeouts = new Map();
	for (const idx of config.indexPaths) {
		if (idx.endsWith(".json")) continue;
		for (const [k, v] of deriveTimeoutsFromIndexMd(idx)) indexTimeouts.set(k, v);
	}

	// 手工条目最后覆盖
	for (const extra of config.guiBinaries || []) guiTable.set(extra.toLowerCase(), "cmd-guard.rules.json 手工覆盖");
	if ((config.guiBinaries || []).length > 0) rulesSource += `+手工(${config.guiBinaries.length})`;
}

/* ────────────────────────── 命令分类与改写 ────────────────────────── */

const HEAVY = [
	/\bvmrun\b/i,
	/\bvboxmanage\b/i,
	/\bnpm\s+(i|install|ci)\b/i,
	/\bnpx\b/i,
	/\bpip\s+install\b/i,
	/\bgit\s+clone\b/i,
	/\b(msbuild|dotnet\s+build|gradle|maven|mvn|cmake|ninja|cargo\s+build|turbo\s+build)\b/i,
	/\banalyzeHeadless\b/i,
	/\bdir\s+\/[sS]\b/,
	/\bmake\b/i,
];
const PROBE = [
	/^\s*(ls|dir|Get-ChildItem|gci)\b/i,
	/^\s*(cat|type|head|tail|less|more)\b/i,
	/^\s*(which|where|Get-Command|Test-Path)\b/i,
	/^\s*(echo|cd|pwd|whoami|date|ver|uname)\b/i,
	/^\s*(git\s+(status|log|diff|show))\b/i,
];
const RECURSIVE_SCAN = /\b(find|rg|grep|Get-ChildItem|gci)\b[^\n]*(\s-r\b|-Recurse|[A-Za-z]:[\\/]?(HACKER|Project|Users|Windows|node_modules|EXE|\.git)\b|[A-Za-z]:[\\/]\s|\/(usr|var|opt|home)\b)/i;
const DRIVE_ROOT_SCAN = /\b(find|rg|grep|dir|Get-ChildItem)\b[^\n]*\s([A-Za-z]:[\\/]\s*["']?$|["']?[A-Z]:[\\/](?![^\s]*[\\/]\w))|"[A-Za-z]:[\\/]"/i;

/** 命令调用的若是索引里的工具，返回该工具的索引 timeout；解释器类返回 0。 */
function indexTimeoutFor(cmd: string): { secs: number; tool: string } {
	for (const exe of invokedBinaries(cmd)) {
		if (INTERPRETERS.has(exe.replace(/\.(exe|bat|cmd)$/i, ""))) continue;
		const secs = indexTimeouts.get(exe) ?? indexTimeouts.get(exe.replace(/\.(exe|bat|cmd)$/i, ""));
		if (secs) return { secs, tool: exe };
	}
	return { secs: 0, tool: "" };
}

function classify(cmd: string): "probe" | "heavy" | "normal" {
	if (HEAVY.some((r) => r.test(cmd))) return "heavy";
	if (PROBE.some((r) => r.test(cmd))) return "probe";
	return "normal";
}

function countSegments(cmd: string): number {
	return cmd
		.split(/&&|\|\||[;\n|]/)
		.map((s) => s.trim())
		.filter(Boolean).length;
}

function head(cmd: string, n = 72): string {
	const one = cmd.replace(/\s+/g, " ").trim();
	return one.length > n ? one.slice(0, n) + "…" : one;
}

function isAllowed(cmd: string, allow: string[]): boolean {
	const low = cmd.toLowerCase();
	return allow.some((a) => a && low.includes(a.toLowerCase()));
}

/** 找出命令里真正被调用的可执行文件名（忽略 cd/管道右侧的路径参数）。 */
function invokedBinaries(cmd: string): string[] {
	const out: string[] = [];
	const re = /(?:^|[;&|(\n]|\bstart\s+(?:\/[bB]\s+)?)(?:"([^"]+\.(?:exe|bat|cmd))"|'([^']+\.(?:exe|bat|cmd))'|([^\s;&|()"']+\.(?:exe|bat|cmd)))/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(cmd))) {
		const raw = (m[1] || m[2] || m[3] || "").split(/[\\/]/).pop() || "";
		if (raw) out.push(raw.toLowerCase());
	}
	return out;
}

function hardenSsh(cmd: string, shell: "bash" | "powershell"): { cmd: string; injected: string[] } {
	const injected: string[] = [];

	// 只在「真命令位置」注入，不能全文搜索 ssh ——
	// 否则 echo "ssh is old" > f.txt 会被改成
	// echo "ssh -o ConnectTimeout=15 ... is old" > f.txt（已实测踩过）。
	// 命令位置 = 字符串开头，或 && || ; | ( 换行 之后的第一个词元。
	const SEG = /(^|[\n;|&(]\s*)((?:[\w.]+=\S+\s+)*)((?:ssh|scp|sftp|rsync))\b/gi;
	const already = /ConnectTimeout/i.test(cmd);

	let touched = false;
	const out = cmd.replace(SEG, (m, lead: string, envPrefix: string, word: string) => {
		touched = true;
		if (already) return m;
		return lead + envPrefix + word + " -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3";
	});
	if (touched && !already) {
		injected.push("ssh/scp: ConnectTimeout=15 + ServerAlive 心跳");
	}

	// ssh 的交互式提示（Are you sure / password）会把管道挂住。bash 侧补 </dev/null。
	// 同样只在真命令位置成立、且命令自己没有 stdin 重定向时才补。
	const hasRealSsh = /(^|[\n;|&(]\s*)((?:[\w.]+=\S+\s+)*)(?:ssh)\b/i.test(cmd);
	let finalCmd = out;
	if (shell === "bash" && hasRealSsh && !/<\s*\/dev\/null/.test(out) && !/<\s*\S/.test(out) && !/<\s*</.test(out)) {
		finalCmd = out + " < /dev/null";
		injected.push("ssh: </dev/null 断交互");
	}
	return { cmd: finalCmd, injected };
}

/* ────────────────────────────── 扩展主体 ────────────────────────────── */

export default function cmdGuard(pi: ExtensionAPI) {
	const running = new Map<string, CallRecord>();
	const history: HistoryEntry[] = [];
	const blocked: { at: string; cmd: string; reason: string }[] = [];
	let stats = { guarded: 0, injected: 0, blocked: 0 };
	let ticker: ReturnType<typeof setInterval> | null = null;
	let enabled = true;

	function fmtSec(ms: number): string {
		const s = Math.floor(ms / 1000);
		return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
	}

	function stopTicker() {
		if (ticker) {
			clearInterval(ticker);
			ticker = null;
		}
	}

	function renderStatus(ctx: any) {
		if (!ctx?.ui?.setStatus) return;
		if (!running.size) {
			ctx.ui.setStatus("cmd-guard", undefined);
			return;
		}
		const parts: string[] = [];
		for (const r of running.values()) {
			const total = Date.now() - r.startedAt;
			const silent = Date.now() - r.lastOutputAt;
			const mark = total >= config.stallSeconds ? "✖" : silent >= config.noOutputStallSeconds ? "◐" : "●";
			const inject = r.injected.length ? ` ·已注入 ${r.injected.length} 条` : "";
			parts.push(`${mark} ${r.toolName} ${fmtSec(total)} · 静默 ${fmtSec(silent)}${inject} · ${head(r.command, 40)}`);
		}
		const srcNote = rulesSource === "内置基线" ? " ·规则源=内置基线，索引未加载" : ` ·规则源=${rulesSource}`;
		ctx.ui.setStatus("cmd-guard", "⛨ " + parts.join("  |  ") + srcNote);
	}

	function ensureTicker(ctx: any) {
		if (ticker) return;
		ticker = setInterval(() => {
			if (!running.size) {
				stopTicker();
				renderStatus(ctx);
				return;
			}
			renderStatus(ctx);
		}, 1000);
		if (typeof ticker.unref === "function") ticker.unref();
	}

	/* ── 拦截/改写 ── */
	pi.on("tool_call", (event: any, ctx: any) => {
		if (!enabled) return;
		const name = event.toolName;
		if (name !== "bash" && name !== "powershell") return;
		const shell: "bash" | "powershell" = name === "bash" ? "bash" : "powershell";
		let cmd = String(event.input?.command ?? "");
		if (!cmd.trim()) return;

		loadConfig();
		if (isAllowed(cmd, config.allow)) return;

		const injected: string[] = [];
		const notes: string[] = [];

		/* 1. GUI / 交互式二进制 —— 物理拦下，这是 die.exe 那次挂死的根因 */
		const guiHit = invokedBinaries(cmd).find((b) => guiTable.has(b));
		if (guiHit) {
			const use = guiTable.get(guiHit) || "";
			const reason =
				`[cmd-guard] 已拦下：\`${guiHit}\` 是 GUI/交互式二进制。\n` +
				`它会弹窗等输入、零 stdout、进程永不退出 —— 一旦同步等它，模型全程不运行且无法自愈（终端计时器会一直涨而 token 停止）。\n` +
				(use ? `改用：${use}\n` : "") +
				`原则：能用 CLI 用 CLI，能用 MCP 用 MCP，都不行才开 GUI，GUI 禁入 bash。`;
			blocked.push({ at: new Date().toISOString().slice(11, 19), cmd: head(cmd, 100), reason: head(reason, 100) });
			stats.blocked++;
			if (ctx?.ui?.notify) ctx.ui.notify(`cmd-guard 拦下 ${guiHit}：改用 CLI 版`, "warning");
			return { block: true, reason };
		}

		/* 2. timeout —— 不传就是无限等，这里替模型补上 */
		const kind = classify(cmd);
		const idx = indexTimeoutFor(cmd);
		let want = kind === "probe" ? config.probeTimeout : kind === "heavy" ? config.heavyTimeout : config.defaultTimeout;
		if (kind !== "heavy" && idx.secs > 0) {
			// 索引「默认 timeout」列为事实源；只有索引值更高时才抬升（探查类不抬）
			if (kind === "probe" && idx.secs > want) want = idx.secs;
			else if (kind === "normal") want = idx.secs;
		}
		if (RECURSIVE_SCAN.test(cmd) || DRIVE_ROOT_SCAN.test(cmd)) {
			if (event.input.timeout === undefined || event.input.timeout < 180) {
				event.input.timeout = Math.max(event.input?.timeout ?? 0, 180);
				injected.push(`timeout=180（递归大目录扫描）`);
			}
		} else if (event.input.timeout === undefined) {
			event.input.timeout = want;
			injected.push(`timeout=${want}（${kind}）`);
		} else {
			injected.push(`timeout=${event.input.timeout}（模型自带）`);
		}

		/* 3. ssh / scp 有界化 */
		const hardened = hardenSsh(cmd, shell);
		if (hardened.cmd !== cmd) {
			cmd = hardened.cmd;
			event.input.command = cmd;
			injected.push(...hardened.injected);
		}

		/* 4. 链长 —— 只提示不拦，避免误伤正当的多步操作 */
		const segs = countSegments(cmd);
		if (segs > 8) {
			notes.push(
				`单条命令串了 ${segs} 段（>8）。任一段等交互或打错路径，整条就死，且出错时前面产物落在哪说不清。拆成多条单独调用。`
			);
		}
		if (/\/(tmp|var\/tmp)\b|\bC:\\tmp\b/i.test(cmd) && /\bssh\b|\bscp\b/i.test(cmd)) {
			notes.push("同一条命令里混用了 POSIX 路径（Git-Bash 下 `/tmp` 实为 `C:\\tmp`）与 Windows 路径，远程端路径几乎必错。两端路径分两次调用，别混写。");
		}
		if (/\bstart\s+(?!\/[bB])/i.test(cmd) && shell === "powershell") {
			notes.push("`start` 不带 /b 会新开一个独立窗口并立刻返回，后台进程不受管。改用 `start /b ... > log 2>&1` + 轮询产物。");
		}
		if (/\bvmrun\b.*\b(snapshot|suspend)\b/i.test(cmd)) {
			notes.push("`vmrun snapshot/suspend` 是 VIX 同步调用，客户机运行中/实时扫描/快照锁争用时可无限期挂起。改成后台执行 + 轮询 `*.vmsn` 是否落地。");
		}

		stats.guarded++;
		stats.injected += injected.length;

		running.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			toolName: name,
			command: cmd,
			shell,
			startedAt: Date.now(),
			lastOutputAt: Date.now(),
			injected,
			notes,
			ownTimeout: typeof event.input.timeout === "number" ? event.input.timeout : null,
		});
		ensureTicker(ctx);
		renderStatus(ctx);
		return;
	});

	/* ── 有输出就刷新静默计时 ── */
	pi.on("tool_execution_update", (event: any) => {
		const r = running.get(event.toolCallId);
		if (r) r.lastOutputAt = Date.now();
	});

	/* ── 结束：记账 + 把提示回灌给模型，让它自己改 ── */
	pi.on("tool_result", (event: any, ctx: any) => {
		const r = running.get(event.toolCallId);
		if (!r) return;
		running.delete(event.toolCallId);
		renderStatus(ctx);
		if (!running.size) stopTicker();

		const secs = Math.round((Date.now() - r.startedAt) / 1000);
		const verdict = event.isError ? "失败" : "完成";
		history.unshift({ at: new Date().toISOString().slice(11, 19), toolName: r.toolName, head: head(r.command, 60), seconds: secs, verdict });
		if (history.length > 20) history.length = 20;

		if (r.notes.length) {
			const line: TextContent = {
				type: "text",
				text:
					`\n[cmd-guard 提示 · 改写后执行 ${secs}s · ${verdict}]\n` +
					r.notes.map((n) => `- ${n}`).join("\n") +
					(r.injected.length ? `\n（已自动注入：${r.injected.join("；")}）` : ""),
			};
			if (Array.isArray(event.content)) event.content = [...event.content, line];
		}
	});

	pi.on("agent_end", (_e: any, ctx: any) => {
		running.clear();
		stopTicker();
		renderStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		stopTicker();
	});

	/* ── /stall ── */
	pi.registerCommand("stall", {
		description: "命令执行健康报告：当前在跑什么、卡多久、守卫注入了什么、被拦过什么",
		handler: async (_arg: string, ctx: any) => {
			loadConfig(true);
			const lines: string[] = [];
			lines.push("⛨ cmd-guard 状态");
			lines.push(running.size ? "── 正在执行 ──" : "── 当前无命令在执行 ──");
			for (const r of running.values()) {
				const total = Date.now() - r.startedAt;
				const silent = Date.now() - r.lastOutputAt;
				lines.push(
					`  ${r.toolName}  已 ${fmtSec(total)}  静默 ${fmtSec(silent)}  timeout=${r.ownTimeout ?? "无"}` +
						`${total >= config.stallSeconds ? "  ✖ 已过卡死阈值" : silent >= config.noOutputStallSeconds ? "  ◐ 长时间无输出" : ""}`
				);
				lines.push(`    ${head(r.command, 90)}`);
				if (r.injected.length) lines.push(`    已注入：${r.injected.join("；")}`);
			}
			lines.push(`── 本会话 ──  守卫 ${stats.guarded} 次，注入 ${stats.injected} 条，拦下 ${stats.blocked} 次`);
			lines.push(`  卡死阈值 ${config.stallSeconds}s / 静默阈值 ${config.noOutputStallSeconds}s / 默认 timeout ${config.defaultTimeout}s`);
			lines.push(`  GUI 规则 ${guiTable.size} 条，规则源=${rulesSource}`);
			if (blocked.length) {
				lines.push("── 被拦下 ──");
				for (const b of blocked.slice(0, 5)) lines.push(`  ${b.at}  ${b.cmd}\n    ${b.reason}`);
			}
			if (history.length) {
				lines.push("── 最近执行 ──");
				for (const h of history.slice(0, 8)) lines.push(`  ${h.at}  ${String(h.seconds).padStart(5)}s  ${h.verdict}  ${h.toolName}  ${h.head}`);
			}
			lines.push("── 处置处方 ──");
			lines.push("  卡在 ssh/scp   → 客户机是否在等输入？IP 是否写错？先 `ssh -n -o ConnectTimeout=5 <ip> echo ok` 单验连通。");
			lines.push("  卡在 vmrun     → 快照写盘慢或锁争用。改后台 `start /b vmrun ... >log 2>&1 &` 后轮询 `*.vmsn`。");
			lines.push("  卡在 GUI 二进制 → 已物理拦下，改用索引里的 CLI/MCP 版。");
			lines.push("  卡在 find/grep  → 递归范围太大，收窄到子目录或加 `-maxdepth`。");
			lines.push("  卡在 npx/npm    → 首次拉包或版本解析，加 timeout 并看 npm 缓存锁。");
			lines.push("  计时器在涨 + token 不动 = 卡在命令（不在推理）→ Ctrl-C 中断，然后发「继续」；这种中断不会自愈。");
			const text = lines.join("\n");
			if (ctx?.ui?.notify) ctx.ui.notify(text, running.size ? "warning" : "info");
		},
	});

	/* ── /guard on|off ── */
	pi.registerCommand("guard", {
		description: "命令守卫开关：/guard off 关掉注入与拦截，/guard on 恢复",
		handler: async (arg: string, ctx: any) => {
			const a = (arg || "").trim().toLowerCase();
			if (a === "off") enabled = false;
			else if (a === "on") enabled = true;
			else if (a === "reload") {
				loadConfig(true);
				loadedStamp = "0";
				rulesMtime = 0;
			}
			const msg =
				`cmd-guard ${enabled ? "启用" : "停用"}｜GUI 规则 ${guiTable.size} 条（规则源=${rulesSource}）｜` +
				`默认 timeout ${config.defaultTimeout}s（探查 ${config.probeTimeout}s / 重活 ${config.heavyTimeout}s）｜` +
				`卡死阈值 ${config.stallSeconds}s｜规则文件 ${fs.existsSync(rulesPath()) ? rulesPath() : "（未建，用内置表）"}`;
			if (ctx?.ui?.notify) ctx.ui.notify(msg, enabled ? "info" : "warning");
		},
	});
}