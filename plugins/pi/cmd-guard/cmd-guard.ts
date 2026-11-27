/**
 * cmd-guard — conservative checks for literal shell commands, timeout budgets,
 * and /stall observations. Complex shell syntax is left unchanged; this is not
 * a shell interpreter or a security boundary. Tool output never supplies policy.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { invocations, interactiveCall, scanKind, hardenTransport, guiControlCall, hasHelp, type Invocation } from "./lib/command-policy.ts";

/* ────────────────────────────── 配置 ────────────────────────────── */

interface GuardConfig {
	/** 普通分析命令的默认 timeout */
	defaultTimeout: number;
	/** 探查类（只读快命令） */
	probeTimeout: number;
	/** 分析类（默认档，缺省等于 defaultTimeout） */
	analysisTimeout: number;
	/** 构建类 / 解释器 */
	heavyTimeout: number;
	/** 递归大目录扫描的最低 timeout */
	scanTimeout: number;
	/** 传入 timeout 的硬上限，避免毫秒误传或无限等待 */
	maxTimeout: number;
	/** true = 拦截会等待终端交互的编辑器、监视器和选择器 */
	blockInteractive: boolean;
	/** 超过它标记为长时运行（不是卡死判定） */
	stallSeconds: number;
	/** 超过它没有输出更新，/stall 报告显示静默标记 */
	noOutputStallSeconds: number;
	/** false = 只记账不阻断（出问题时先观察，不打断） */
	enforce: boolean;
	/** false = 不拦 GUI，只注入 timeout 兜底。客户机 / VM 上 GUI 是正当手段，用这个 */
	blockGui: boolean;
	/** true = 拦截已识别的无界盘根递归扫描 */
	blockRootScan: boolean;
	/** 给单条字面量 ssh/scp/sftp/rsync 调用补缺失的传输超时选项 */
	hardenSsh: boolean;
	/** 手写 GUI 名单（覆盖同名派生项）。值可以是提示语，null / "" 表示「明确不拦」 */
	guiBinaries: Record<string, string | null>;
	/** 命令里含其中任一子串则整条跳过守卫（救急用，慎用） */
	allow: string[];
	/** 追加到内置规则的调用名和参数正则；按 severity 拦截或提示 */
	denyRules: DenyRule[];
	/** 按 id 关掉某条内置禁手（例如本机就是专用靶机，允许改网卡） */
	disableDeny: string[];
	/** 额外的 GUI 名单来源文档（Markdown）。文档里 `` `a.exe`→`b` `` 会被派生 */
	toolChainPaths: string[];
	/** ★ 技能包根（含 TOOL-CHAIN.md 的那一层）。留空 = 自动探测 */
	skillRoot: string | null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface DenyRule {
	/** 稳定标识，用于统计与 /guard 展示 */
	id: string;
	/** 正则源码（不区分大小写） */
	re: string;
	/** 给人看的一句话标签 */
	label: string;
	/** block = 直接拦；warn = 只提示不改行为 */
	severity: "block" | "warn";
	/** 为什么禁 + 该改用哪条路（会原样回给模型） */
	hint: string;
}

/** Built-ins match a normalized executable and its arguments, never arbitrary output or script text. */
const BUILTIN_DENY: DenyRule[] = [
	{ id: "net-ip-alias", re: "^(New|Remove|Set)-NetIPAddress(?: |$)", label: "修改接口 IP 地址", severity: "block", hint: "此调用会修改接口地址，可能影响当前连接。请核实目标接口和恢复方案；可用 Get-NetIPAddress 只读查看。" },
	{ id: "net-iface-write", re: "^(Set|Disable|Restart)-Net(Adapter|IPInterface|TCPSetting)(?: |$)", label: "修改或停用网络接口", severity: "block", hint: "此调用可能改变接口状态或连接参数。Enable-NetAdapter 和只读查询不属于此规则。" },
	{ id: "net-winhttp-write", re: "^netsh winhttp (set|import|add)(?: |$)", label: "修改 WinHTTP 配置", severity: "block", hint: "此调用可能影响使用系统 WinHTTP 配置的程序。请核实作用范围；netsh winhttp show proxy 可只读查看。" },
	{ id: "net-dns-write", re: "^(netsh (int|interface) (ip|ipv4|ipv6) (set|add) (dns|dnsservers|address)(?: |$)|Set-DnsClientServerAddress(?: |$))", label: "修改 DNS 或接口地址", severity: "block", hint: "此调用会修改接口的 DNS 或地址配置，可能影响解析或连通性。" },
	{ id: "net-route-write", re: "^(route (?:-p )?(add|delete|change)(?: |$)|(New|Remove|Set)-NetRoute(?: |$))", label: "修改路由表", severity: "block", hint: "此调用会修改路由。影响取决于目标网段和接口；请核实是否会影响当前连接。" },
	{ id: "net-winsock-reset", re: "^netsh (winsock reset(?: |$)|advfirewall set (allprofiles|currentprofile|domainprofile|privateprofile|publicprofile) state off(?: |$))", label: "重置 Winsock 或关闭防火墙", severity: "block", hint: "重置 Winsock 可能需要重启；关闭防火墙会改变防护状态。开启防火墙不属于此规则。" },
];

const DEFAULTS: GuardConfig = {
	defaultTimeout: 120,
	probeTimeout: 30,
	analysisTimeout: 120,
	heavyTimeout: 600,
	scanTimeout: 180,
	maxTimeout: 1800,
	stallSeconds: 240,
	noOutputStallSeconds: 90,
	blockInteractive: true,
	enforce: true,
	blockGui: false,
	blockRootScan: true,
	hardenSsh: true,
	guiBinaries: {},
	allow: ["cmd-guard-skip"],
	denyRules: [],
	disableDeny: [],
	toolChainPaths: [],
	skillRoot: null,
};

/** 内置 GUI 基线始终保留；支持的文档条目和手工配置可覆盖同名项，null 表示不拦。 */
const BUILTIN_GUI: Record<string, string | null> = {
	"die.exe": "改用 CLI 版 diec（先 --version 确认参数）",
	"wireshark.exe": "改用 tshark",
	"x64dbg.exe": "改用控制台 headless 版（stdin 喂命令、输出可读）",
	"x32dbg.exe": "改用控制台 headless 版",
	"ida.exe": "改用 idat（headless）或 Ghidra analyzeHeadless",
	"ida64.exe": "改用 idat（headless）或 Ghidra analyzeHeadless",
	"windbg.exe": "改用 cdb.exe（支持 crash dump 分析）",
	"dnspy.exe": "改用 dnSpy.Console",
	"ollydbg.exe": "改用控制台版调试器",
	"immunitydebugger.exe": "改用控制台版调试器",
	"cheatengine.exe": "内存扫描走脚本，不要同步等 GUI",
	"cheatengine-x86_64.exe": "内存扫描走脚本，不要同步等 GUI",
	"ilspy.exe": "改用 ilspycmd",
	"procmon.exe": "改用 procmon64.exe /B 批处理模式，或 Sysmon CLI",
	"binaryninja.exe": "改用 Binary Ninja 的 Python API / headless",
	"jeb.exe": "改用 jeb-cli / headless 模式",
	// 这两个本身就是 headless —— 明确标「不拦」
	"idat.exe": null,
	"idat64.exe": null,
	"analyzeheadless.bat": null,
};

/** 解释器 / 包管理器：跑的是任意脚本，不能用分类 timeout 硬套 */
const INTERPRETERS = new Set([
	"python", "python3", "py", "pip", "pip3", "uv", "pipx",
	"node", "npm", "npx", "pnpm", "yarn", "bun",
	"bash", "sh", "pwsh", "powershell", "cmd", "wsl",
	"java", "javac", "dotnet", "go", "cargo", "rustc",
	"make", "cmake", "msbuild", "gradle", "mvn",
	"r2", "radare2", "ghidra", "analyzeheadless",
]);

/* ──────────────────── 技能包根定位（换机零配置）──────────────────── */

function fileExists(p: string): boolean {
	try {
		return fs.existsSync(p);
	} catch {
		return false;
	}
}

/**
 * TOOL-CHAIN.md 在包内的位置。
 * 现行布局：skillpack/TOOL-CHAIN.md（必须随 skillpack/ 一起分发，否则按 AI-INSTALL.md
 * 只装 skillpack/ 的机器上，TOOLS.md 里的链接就是死的，verify-doc-links.py 也会报断链）。
 * 早期布局：<根>/TOOL-CHAIN.md。两种都认，换布局不用改代码。
 */
function chainPath(root: string): string | null {
	for (const rel of [path.join("skillpack", "TOOL-CHAIN.md"), "TOOL-CHAIN.md"]) {
		const p = path.join(root, rel);
		if (fileExists(p)) return p;
	}
	return null;
}

function looksLikeRoot(dir: string): boolean {
	return chainPath(dir) !== null;
}

/**
 * 按顺序找含 TOOL-CHAIN.md 的目录。第一个命中即返回。
 * 顺序刻意设计成「越确定越靠前」，这样在任何机器上都不需要先设环境变量。
 */
function findSkillRoot(configured: string | null): string | null {
	const candidates: string[] = [];
	if (configured) candidates.push(configured);

	// 1) 显式环境变量
	for (const k of ["RELAB_SKILL_ROOT", "REVERSE_SKILL_ROOT", "CMD_GUARD_SKILL_ROOT"]) {
		const v = process.env[k];
		if (v) candidates.push(v);
	}

	// 2) 本文件就躺在技能包里 → 从扩展目录往上数（kernel/extensions/pi/ → 根）
	//    这是最可靠的一条：只要整包 clone 下来就成立，不依赖任何环境变量。
	let dir = HERE;
	for (let i = 0; i < 5; i++) {
		candidates.push(dir);
		const up = path.dirname(dir);
		if (up === dir) break;
		dir = up;
	}

	// No machine-specific fallback roots. Configure skillRoot, toolChainPaths,
	// or CMD_GUARD_SKILL_ROOT (legacy environment aliases remain supported).
	const seen = new Set<string>();
	for (const c of candidates) {
		const abs = path.resolve(c);
		const key = process.platform === "win32" ? abs.toLowerCase() : abs;
		if (seen.has(key)) continue;
		seen.add(key);
		if (looksLikeRoot(abs)) return abs;
	}
	return null;
}

/** 技能包根 + 文档清单。root 为 null 表示一处都没找到 —— 启动时会明说。 */
function docSources(config: GuardConfig, root: string | null): string[] {
	const out: string[] = [];
	if (root) {
		const main = chainPath(root);
		if (main) out.push(main);
		// 技能包里其它也会写 GUI 替代方案的地方，一并认（存在才认）
		for (const rel of ["skillpack/skills/TOOLS.md", "skillpack/skills/SKILL.md"]) {
			const p = path.join(root, rel);
			if (fileExists(p)) out.push(p);
		}
	}
	for (const p of config.toolChainPaths) {
		const abs = path.resolve(p);
		if (fileExists(abs)) out.push(abs);
	}
	return out;
}

/* ──────────────────── 从文档派生 GUI 名单 ──────────────────── */

/** 从箭头替代写法和 Markdown 表格提取 GUI 建议；未识别的格式仍有内置兜底表。 */
const ARROW_RE = /`?([\w.\-]+\.(?:exe|bat|cmd))`?\s*(?:→|->|=>|改用|换成)\s*`?([\w.\-]+(?:\.exe|\.bat|\.cmd)?)`?/gi;
const TABLE_RE = /^\s*\|\s*`?([\w.\-]+\.(?:exe|bat|cmd))`?\s*\|[^|]*?`([\w.\-]+(?:\.exe|\.bat|\.cmd)?)`/gim;

function parseGuiFromDoc(text: string, source: string): Map<string, string> {
	const out = new Map<string, string>();

	ARROW_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = ARROW_RE.exec(text)) !== null) {
		const gui = m[1].toLowerCase();
		const cli = m[2].toLowerCase();
		if (gui === cli) continue; // 自己指向自己 = 本身就是 CLI
		out.set(gui, `改用 ${cli}（来源 ${source}）`);
	}

	TABLE_RE.lastIndex = 0;
	while ((m = TABLE_RE.exec(text)) !== null) {
		const gui = m[1].toLowerCase();
		const cli = m[2].toLowerCase();
		if (gui === cli) continue;
		if (!out.has(gui)) out.set(gui, `改用 ${cli}（来源 ${source}）`);
	}

	return out;
}

/* ──────────────────────── 规则加载（含热重载）──────────────────── */

let config: GuardConfig = { ...DEFAULTS };
/** exe 名（小写）→ 替代提示；值 null = 明确不拦 */
let guiTable = new Map<string, string | null>();
let rulesSource = "内置兜底表";
let loadedAt = 0;
let loadedStamp = "";

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

function loadConfig(force = false): void {
	const now = Date.now();
	const rp = rulesPath();
	const stamp = `${mtimeOf(rp)}:${["CMD_GUARD_SKILL_ROOT", "RELAB_SKILL_ROOT", "REVERSE_SKILL_ROOT"].map(k => process.env[k] || "").join(":")}`;
	// 30 秒节流：文件没变就别反复读盘；但 /guard reload 走 force
	if (!force && stamp === loadedStamp && now - loadedAt < 30_000) return;
	loadedStamp = stamp;
	loadedAt = now;

	config = { ...DEFAULTS, guiBinaries: {}, allow: [...DEFAULTS.allow], toolChainPaths: [] };
	let parseError = "";
	try {
		if (fileExists(rp)) {
			const raw = JSON.parse(fs.readFileSync(rp, "utf-8")) as Record<string, unknown>;
			for (const k of Object.keys(DEFAULTS) as (keyof GuardConfig)[]) {
				if (raw[k] !== undefined) (config as Record<string, unknown>)[k] = raw[k];
			}
			// 兼容老 rules.json：indexPaths 也当成文档来源
			const legacy = raw.indexPaths;
			if (Array.isArray(legacy)) {
				config.toolChainPaths = [...config.toolChainPaths, ...(legacy as string[])];
			}
		}
	} catch (e) {
		// 规则坏了要用默认值，但不能因此让守卫变成故障源 —— 也不能静默
		parseError = (e as Error).message;
		console.error(`[cmd-guard] rules.json 解析失败，改用默认配置：${parseError}`);
	}
	if (!Array.isArray(config.allow)) config.allow = [];
	if (!Array.isArray(config.toolChainPaths)) config.toolChainPaths = [];
	for (const key of ["defaultTimeout", "probeTimeout", "analysisTimeout", "heavyTimeout", "scanTimeout", "maxTimeout", "stallSeconds", "noOutputStallSeconds"] as const) {
		const value = config[key];
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) config[key] = DEFAULTS[key];
	}
	config.maxTimeout = Math.min(config.maxTimeout, 2_147_483.647);
	// denyRules：rules.json 里给了就「在内置表基础上追加」，而不是整体替换 ——
	// 否则用户写一条自己的规则就把网络禁手全关了。（DEFAULTS.denyRules 必须是空数组，
	// 否则这里会把内置表当「追加项」再拼一遍。）
	{
		const disabled = new Set((Array.isArray(config.disableDeny) ? config.disableDeny : []).map((x) => String(x)));
		const extra = Array.isArray(config.denyRules) ? config.denyRules : [];
		const clean: DenyRule[] = [];
		for (const r of extra as unknown as DenyRule[]) {
			if (!r || typeof r !== "object") continue;
			const id = String((r as DenyRule).id || "");
			if (id && disabled.has(id)) continue;
			const re = String((r as DenyRule).re || "");
			if (!re) continue;
			try {
				new RegExp(re, "i");
			} catch {
				console.error(`[cmd-guard] denyRules 正则写错，已忽略：${re}`);
				continue;
			}
			clean.push({
				id: String((r as DenyRule).id || `custom-${clean.length}`),
				re,
				label: String((r as DenyRule).label || re),
				severity: (r as DenyRule).severity === "warn" ? "warn" : "block",
				hint: String((r as DenyRule).hint || ""),
			});
		}
		config.denyRules = [...BUILTIN_DENY.filter((r) => !disabled.has(r.id)), ...clean];
	}
	// 手工项必须是「exe 名 → 提示语/null」的对象。旧版这里收的是数组，两种形状都见过，
	// 先按形状判断：写错时退成空表并在 stderr 说明，而不是让 Object.entries 拿数组当表用。
	if (!config.guiBinaries || typeof config.guiBinaries !== "object" || Array.isArray(config.guiBinaries)) {
		if (config.guiBinaries !== undefined && config.guiBinaries !== null) {
			console.error("[cmd-guard] guiBinaries 形状不对（要 \"exe名\": \"提示语\" 对象），本项已忽略");
		}
		config.guiBinaries = {};
	}

	const root = findSkillRoot(config.skillRoot);
	const docs = docSources(config, root);

	// 优先级（后者覆盖前者）：内置基线 → 文档派生 → rules.json 手工项
	guiTable = new Map(Object.entries(BUILTIN_GUI));
	rulesSource = docs.length ? `文档派生（${docs.length} 份）` : "内置兜底表";
	if (!docs.length) rulesSource += " ★未找到 TOOL-CHAIN.md";
	if (parseError) rulesSource += " ★rules.json 有错";

	for (const d of docs) {
		try {
			for (const [k, v] of parseGuiFromDoc(fs.readFileSync(d, "utf-8"), path.basename(d))) {
				guiTable.set(k, v);
			}
		} catch (e) {
			console.error(`[cmd-guard] 读文档失败 ${d}：${(e as Error).message}`);
		}
	}

	for (const [k, v] of Object.entries(config.guiBinaries || {})) {
		guiTable.set(k.toLowerCase(), v === null || v === "" ? null : String(v));
	}
}

/* ─────────────────────── 命令识别与分类 ─────────────────────── */

/** 词元在 GUI 表里命中吗？返回 [表内键, 提示] 或 null（提示为 null 表示明确不拦） */
function guiHit(token: string): [string, string | null] | null {
	const keys = token.includes(".") ? [token] : [token, `${token}.exe`, `${token}.bat`, `${token}.cmd`];
	for (const k of keys) {
		if (guiTable.has(k)) return [k, guiTable.get(k) ?? null];
	}
	return null;
}

function findGui(calls: Invocation[] | null): [string, string] | null {
	for (const call of calls ?? []) {
		if (guiControlCall(call)) continue;
		const hit = guiHit(call.name);
		if (hit && hit[1] !== null) return [hit[0], hit[1]];
	}
	return null;
}

function pickTimeout(calls: Invocation[] | null): { secs: number; why: string } {
	if (!calls?.length) return { secs: config.heavyTimeout, why: "复杂脚本/未确定调用" };
	const heavy = new Set(["vmrun", "vboxmanage", "msbuild", "make", "cmake", "ninja", "maven", "turbo"]);
	const probes = new Set([
		"ls", "dir", "get-childitem", "gci", "cat", "type", "head", "tail", "get-content", "gc",
		"which", "where", "get-command", "test-path", "resolve-path", "get-item",
		"echo", "pwd", "get-location", "whoami", "date", "ver", "uname",
		"rg", "grep", "egrep", "fgrep", "findstr", "select-string", "file", "stat",
		"wc", "diff", "comm", "xxd", "od", "hexdump", "strings", "readlink", "realpath",
	]);
	const gitReads = new Set(["status", "log", "diff", "show", "grep", "rev-parse", "rev-list", "ls-files", "ls-tree", "cat-file", "describe", "show-ref", "blame", "shortlog"]);
	if (calls.some(call => INTERPRETERS.has(call.name) || heavy.has(call.name) || (call.name === "git" && call.args[0] === "clone"))) {
		return { secs: config.heavyTimeout, why: "解释器/包管理器/构建" };
	}
	if (calls.every(call => probes.has(call.name) || (call.name === "git" && gitReads.has(call.args[0])))) {
		return { secs: config.probeTimeout, why: "探查" };
	}
	return { secs: config.analysisTimeout || config.defaultTimeout, why: "分析" };
}

function head(cmd: string, n = 72): string {
	const one = cmd.replace(/\s+/g, " ").trim();
	return one.length > n ? one.slice(0, n) + "…" : one;
}

/* ─────────────────────────── 记账 ─────────────────────────── */

interface CallRecord {
	command: string;
	program: string;
	shell: "bash" | "powershell";
	startedAt: number;
	lastOutputAt: number;
	injected: string[];
	notes: string[];
	ownTimeout: number | null;
}

interface HistoryEntry {
	at: string;
	toolName: string;
	head: string;
	seconds: number;
	verdict: string;
}

type TextContent = { type: "text"; text: string };

const running = new Map<string, CallRecord>();
const history: HistoryEntry[] = [];
const blocked: { at: string; cmd: string; reason: string }[] = [];
let stats = { guarded: 0, injected: 0, blocked: 0 };

function recordBlock(command: string, reason: string): void {
	blocked.unshift({ at: new Date().toISOString().slice(11, 19), cmd: head(command, 100), reason: head(reason, 100) });
	if (blocked.length > 20) blocked.length = 20;
	stats.blocked++;
}
let ticker: ReturnType<typeof setInterval> | null = null;
let enabled = true;

/** 最近一次事件回调带来的 ctx —— 用来访问 ui（ExtensionAPI 本身没有 ui） */
let hostCtx: any = null;

function fmtSec(ms: number): string {
	const s = Math.floor(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function stopTicker(): void {
	if (ticker) {
		clearInterval(ticker);
		ticker = null;
	}
}

function renderStatus(): void {
	// 仅清理旧版本留下的底栏状态；运行详情仍通过 /stall 查看。
	hostCtx?.ui?.setStatus?.("command:/stall", undefined);
}

function ensureTicker(): void {
	if (ticker) return;
	ticker = setInterval(() => {
		if (!running.size) {
			stopTicker();
			renderStatus();
			return;
		}
		renderStatus();
	}, 1000);
	if (typeof ticker.unref === "function") ticker.unref();
}

/* ───────────────────────── 扩展主体 ───────────────────────── */

export default function cmdGuard(pi: any): void {
	if (process.env.CMD_GUARD === "0") {
		enabled = false;
		return;
	}

	loadConfig(true);

	// Report configuration and rule sources without inferring execution outcomes.
	const active = [...guiTable.entries()].filter(([, v]) => v !== null).length;
	console.error(
		`[cmd-guard] 已加载 · timeout ${config.probeTimeout}/${config.analysisTimeout || config.defaultTimeout}/${config.heavyTimeout}s` +
			` · GUI 规则 ${active} 条 · 规则来源 ${rulesSource}` +
			` · 前台上限 ${config.maxTimeout}s · 静默阈值 ${config.noOutputStallSeconds}s` +
			`${config.enforce ? "" : " · ★enforce=false，只记账不阻断"}` +
			`${config.blockGui ? "" : " · ★blockGui=false，不拦 GUI"}` +
			`${config.blockRootScan ? " · 盘根扫描=拦截" : " · ★blockRootScan=false，盘根扫描只抬 timeout"}`,
	);

	// ── 上下文捕获：ExtensionAPI 没有 ui，ui 在 handler 的第二个参数上 ──
	const remember = (ctx: any): void => {
		if (ctx) hostCtx = ctx;
	};

	pi.on("session_start", (_e: unknown, ctx: any) => {
		remember(ctx);
		renderStatus();
		if (config.blockGui && (!guiTable.size || rulesSource.includes("★"))) {
			ctx?.ui?.notify?.(
				`cmd-guard 降级中：${rulesSource}\n` +
					`GUI 拦截只剩内置兜底表。设 RELAB_SKILL_ROOT 指向技能包根，或在 cmd-guard.rules.json 写 toolChainPaths。`,
				"warning",
			);
		}
	});

	pi.on("tool_call", (event: any, ctx: any) => {
		remember(ctx);
		if (!enabled) return;
		const name = event.toolName;
		if (name !== "bash" && name !== "powershell") return;
		const shell: "bash" | "powershell" = name === "bash" ? "bash" : "powershell";
		let cmd = String(event.input?.command ?? "");
		if (!cmd.trim()) return;

		loadConfig();
		if (config.allow.some((a) => a && cmd.toLowerCase().includes(a.toLowerCase()))) return;

		const calls = invocations(cmd, shell);
		const injected: string[] = [];
		const notes: string[] = [];

		/* Match built-in operations and user-configured rules against parsed invocations. */
		if (Array.isArray(config.denyRules) && config.denyRules.length) {
			for (const rule of config.denyRules) {
				let re: RegExp;
				try {
					re = new RegExp(rule.re, "i");
				} catch {
					continue;
				}
				// Parse only literal invocations. Quoted documentation and interpreter
				// arguments never become built-in command names.
				const hit = calls?.filter(call => !hasHelp(call.args)).map(call => `${call.name} ${call.args.join(" ")}`.trim()).find(text => re.test(text));
				if (!hit) continue;
				const body =
					`[cmd-guard] ${rule.severity === "block" ? "已拦下" : "注意"}：${rule.label}\n` +
					`命中调用：\`${head(hit, 80)}\`\n` +
					rule.hint;
				if (rule.severity === "block") {
					if (config.enforce) {
						recordBlock(cmd, `${rule.label}：${rule.id}`);
						ctx?.ui?.notify?.(`cmd-guard 拦下：${rule.label}`, "warning");
						return { block: true, reason: body };
					}
					notes.push(`规则命中：${rule.label}（enforce=false，未阻断）。`);
				} else {
					notes.push(body);
				}
			}
		}

		/* Optional strict GUI rules apply only to recognized literal calls. */
		if (config.blockGui) {
			const hit = findGui(calls);
			if (hit) {
				const reason =
					`[cmd-guard] 已拦下：\`${hit[0]}\` 命中已启用的 GUI 严格规则。\n` +
					`该调用可能等待窗口操作；仅凭程序名不能确定是否会阻塞。\n` +
					`规则建议：${hit[1]}\n` +
					`如任务需要 GUI，可在规则文件中关闭 blockGui，或用 guiBinaries 为该程序设置 null。`;
				if (config.enforce) {
					recordBlock(cmd, reason);
					ctx?.ui?.notify?.(`cmd-guard 拦下 ${hit[0]}：${hit[1].slice(0, 60)}`, "warning");
					return { block: true, reason };
				}
				notes.push(`\`${hit[0]}\` 在 GUI 名单里但 enforce=false，本次未拦。`);
			}
		}

		/* 在 Bash 的非交互环境，只拦已知容易等待的命令。 */
		const interactive = shell === "bash" && config.blockInteractive ? interactiveCall(calls) : null;
		if (interactive) {
			const label = `${interactive.name} 通常需要交互或持续运行`;
			if (config.enforce) {
				recordBlock(cmd, label);
				renderStatus();
				ctx?.ui?.notify?.(`cmd-guard 拦下：${label}`, "warning");
				return { block: true, reason: `[cmd-guard] ${label}。${interactive.hint}` };
			}
			notes.push(`${label}（enforce=false，未拦截）。`);
		}

		/* Root-scan rules require a recognized recursive invocation. */
		const scan = scanKind(calls);
		if (config.blockRootScan) {
			if (scan.root) {
				const reason =
					`[cmd-guard] 已拦下盘根递归扫描：\`${head(cmd, 80)}\`。\n` +
					`此调用从文件系统根开始递归，范围可能较大。可限定目录或使用浅层深度限制。`;
				if (config.enforce) {
					recordBlock(cmd, reason);
					ctx?.ui?.notify?.("cmd-guard 拦下盘根递归扫描：可限定目录或浅层深度", "warning");
					return { block: true, reason };
				}
				notes.push("盘根递归扫描：blockRootScan=true 但 enforce=false，本次未拦。");
			}
		}

		/* 2. 始终使用 Pi 的秒数契约；限制前台预算，不猜模型的实际单位。 */
		const raw = event.input.timeout;
		const explicit = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
		const basePreset = pickTimeout(scan.unknown ? null : calls);
		const preset = scan.recursive && config.scanTimeout > basePreset.secs ? { secs: config.scanTimeout, why: "递归扫描缺省预算" } : basePreset;
		const budget = explicit || preset.secs;
		const timeout = Math.min(config.maxTimeout, budget);
		if (timeout !== raw) {
			event.input.timeout = timeout;
			injected.push(`timeout=${timeout}s（${budget > config.maxTimeout ? "前台上限" : preset.why}）`);
		}
		if (explicit > config.maxTimeout) {
			notes.push(`调用方传入 timeout=${explicit}s，已按配置 maxTimeout=${config.maxTimeout}s 限制为 ${timeout}s。`);
		}

		/* 3. ssh / scp 有界化 */
		if (config.hardenSsh) {
			const hardened = hardenTransport(cmd, shell, calls);
			if (hardened.cmd !== cmd) {
				cmd = hardened.cmd;
				event.input.command = cmd;
				injected.push(...hardened.injected);
			}
		}


		stats.guarded++;
		stats.injected += injected.length;

		running.set(event.toolCallId, {
			command: cmd,
			program: calls?.[0]?.name.slice(0, 16) ?? "",
			shell,
			startedAt: Date.now(),
			lastOutputAt: Date.now(),
			injected,
			notes,
			ownTimeout: typeof event.input.timeout === "number" ? event.input.timeout : null,
		});
		ensureTicker();
		renderStatus();
		return;
	});

	/* 有输出就刷新静默计时 */
	pi.on("tool_execution_update", (event: any, ctx: any) => {
		remember(ctx);
		const r = running.get(event.toolCallId);
		if (r && event.partialResult?.content?.some((item: TextContent) => item.type === "text" && item.text)) {
			r.lastOutputAt = Date.now();
		}
	});

	/* End: track the result and report only actual guard decisions. */
	pi.on("tool_result", (event: any, ctx: any) => {
		remember(ctx);
		const r = running.get(event.toolCallId);
		if (!r) return;
		running.delete(event.toolCallId);
		if (!running.size) stopTicker();
		renderStatus();

		const secs = Math.round((Date.now() - r.startedAt) / 1000);
		const text = Array.isArray(event.content)
			? event.content.filter((part: TextContent) => part.type === "text").at(-1)?.text ?? ""
			: "";
		const verdict = !event.isError ? "完成"
			: /(?:^|\n)Command timed out after [\d.]+ seconds[.\s]*[^\n]*$/.test(text) ? "超时"
			: /(?:^|\n)Command aborted\s*$/.test(text) ? "已中断" : "失败";

		history.unshift({
			at: new Date().toISOString().slice(11, 19),
			toolName: r.shell,
			head: head(r.command, 60),
			seconds: secs,
			verdict,
		});
		if (history.length > 20) history.length = 20;

		if (secs >= config.stallSeconds) {
			history[0].verdict += "（长时运行）";
		}

		if (r.notes.length) {
			// 返回 content 才是官方改法；顺带把 structuredContent 带回去，否则会被丢
			const line: TextContent = {
				type: "text",
				text:
					`\n[cmd-guard 提示 · ${secs}s · ${verdict}]\n` +
					r.notes.map((n) => `- ${n}`).join("\n") +
					(r.injected.length ? `\n（已自动注入：${r.injected.join("；")}）` : ""),
			};
			if (Array.isArray(event.content)) {
				return {
					content: [...event.content, line],
					details: event.details,
					structuredContent: event.structuredContent,
				};
			}
		}
		return;
	});

	// Blocked/skipped calls may bypass tool_result (for example another extension blocks later).
	pi.on("tool_execution_end", (event: any, ctx: any) => {
		if (!running.delete(event.toolCallId)) return;
		remember(ctx);
		if (!running.size) stopTicker();
		renderStatus();
	});

	pi.on("agent_end", (_e: unknown, ctx: any) => {
		remember(ctx);
		running.clear();
		stopTicker();
		renderStatus();
	});

	pi.on("session_shutdown", () => {
		running.clear();
		stopTicker();
		hostCtx = null;
	});

	/* ── /stall ── */
	pi.registerCommand("stall", {
		description: "命令执行健康报告：当前在跑什么、卡多久、注入了什么、被拦过什么",
		handler: async (_arg: string, ctx: any) => {
			remember(ctx);
			loadConfig(true);
			const L: string[] = [];
			L.push("⛨ cmd-guard 状态");
			L.push(running.size ? "── 正在执行 ──" : "── 当前无命令在执行 ──");
			for (const r of running.values()) {
				const total = Date.now() - r.startedAt;
				const silent = Date.now() - r.lastOutputAt;
				L.push(
					`  ${r.shell}：已运行 ${fmtSec(total)}，静默 ${fmtSec(silent)}，超时预算 ${r.ownTimeout ?? "无"}s` +
						(silent >= config.noOutputStallSeconds ? "  ◐ 长时间无输出，不一定卡死" : "") +
						(r.ownTimeout !== null && total >= r.ownTimeout * 1000 ? "  ⚠ 已过超时预算，仍在等工具返回" : ""),
				);
				L.push(`    命令：${head(r.command, 120)}`);
				if (r.injected.length) L.push(`    已注入：${r.injected.join("；")}`);
			}
			L.push(
				`── 本会话 ──  守卫 ${stats.guarded} 次，注入 ${stats.injected} 条，拦下 ${stats.blocked} 次`,
			);
			L.push(
				`  长时阈值 ${config.stallSeconds}s / 静默阈值 ${config.noOutputStallSeconds}s / timeout 上限 ${config.maxTimeout}s / 默认 timeout ${config.defaultTimeout}s`,
			);
			L.push(`  GUI 规则 ${[...guiTable.values()].filter((v) => v !== null).length} 条，规则源=${rulesSource}`);
			if (blocked.length) {
				L.push("── 被拦下 ──");
				for (const b of blocked.slice(0, 5)) L.push(`  ${b.at}  ${b.cmd}\n    ${b.reason}`);
			}
			if (history.length) {
				L.push("── 最近执行 ──");
				for (const h of history.slice(0, 8)) L.push(`  ${h.at}  ${String(h.seconds).padStart(5)}s  ${h.verdict}  ${h.toolName}  ${h.head}`);
			}
			L.push("  这里只观测 Bash / PowerShell，不代表模型或 MCP 的状态。静默不等于卡死，不会触发自动中断。");
			L.push("  Windows 后台子进程可能仍持有输出管道，超过超时还不返回时，检查进程和日志，避免盲目重跑。");
			ctx?.ui?.notify?.(L.join("\n"), running.size ? "warning" : "info");
		},
	});

	/* ── /guard on|off|reload|rules ── */
	pi.registerCommand("guard", {
		description: "命令守卫开关：/guard off 关掉注入与拦截，/guard on 恢复，/guard reload 重读文档，/guard rules 看派生出的 GUI 名单",
		handler: async (arg: string, ctx: any) => {
			remember(ctx);
			loadConfig(true);
			const a = (arg || "").trim().toLowerCase();
			if (a === "off") enabled = false;
			else if (a === "on") enabled = true;
			else if (a === "reload") {
				loadConfig(true);
				loadedStamp = "0";
			} else if (a === "rules") {
				const rows = [...guiTable.entries()].sort();
				const L = rows.map(([k, v]) => (v === null ? `  ${k}  —— 明确不拦` : `  ${k}  →  ${v}`));
				L.unshift(`GUI 名单 ${rows.length} 条（${rulesSource}）`);
				ctx?.ui?.notify?.(L.join("\n"), "info");
				return;
			}
			const msg =
				`cmd-guard ${enabled ? "启用" : "停用"}｜GUI 规则 ${[...guiTable.values()].filter((v) => v !== null).length} 条` +
				`（规则源=${rulesSource}）｜timeout ${config.probeTimeout}/${config.analysisTimeout || config.defaultTimeout}/${config.heavyTimeout}s` +
				`｜前台上限 ${config.maxTimeout}s｜enforce=${config.enforce} blockGui=${config.blockGui} blockRootScan=${config.blockRootScan} blockInteractive=${config.blockInteractive} hardenSsh=${config.hardenSsh}` +
				`｜规则文件 ${fileExists(rulesPath()) ? rulesPath() : "（未建，用内置默认）"}`;
			ctx?.ui?.notify?.(msg, enabled ? "info" : "warning");
		},
	});
}
