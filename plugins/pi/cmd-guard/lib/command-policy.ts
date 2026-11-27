import { parseCommands, programName, type CommandToken, type Shell } from "./shell-command.ts";

export interface Invocation {
	name: string;
	args: string[];
	tokens: CommandToken[];
	environment: string[];
}

/** Only unwrap literal prefixes whose argument layout is unambiguous. */
export function invocations(command: string, shell: Shell): Invocation[] | null {
	const parsed = parseCommands(command, shell);
	if (!parsed) return null;
	const out: Invocation[] = [];
	for (const { tokens } of parsed) {
		let start = 0;
		const environment: string[] = [];
		if (shell === "bash") {
			while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]?.value ?? "")) environment.push(tokens[start++].value);
			while (["command", "exec", "sudo", "doas", "nohup", "time"].includes(tokens[start]?.value)) {
				start++;
				if (tokens[start]?.value.startsWith("-")) return null; // wrapper options are not parsed
			}
		}
		const actual = tokens.slice(start);
		if (!actual.length) return null;
		const name = programName(actual[0].value).replace(/\.(?:exe|bat|cmd)$/i, "");
		out.push({ name, args: actual.slice(1).map(token => token.value), tokens: actual, environment });
	}
	return out;
}

export function hasHelp(args: string[]): boolean {
	return args.some(arg => /^(?:--help|--version|\/\?|\/help)$/i.test(arg));
}

export function guiControlCall(call: Invocation): boolean {
	if (hasHelp(call.args)) return true;
	return /^procmon(?:64|64a)?$/.test(call.name) && call.args.some(arg => /^\/(?:terminate|waitforidle)$/i.test(arg));
}

/** Return only obvious finite/interactive distinctions; never inspect script bodies. */
export function interactiveCall(calls: Invocation[] | null): { name: string; hint: string } | null {
	if (calls?.length !== 1) return null;
	const { name, args, environment } = calls[0];
	if (hasHelp(args) || args.includes("-h")) return null;
	if (name === "watch") return { name, hint: "该命令通常持续刷新；可改用一次性查询或在终端中运行。" };
	if (["vi", "vim", "nvim", "nano"].includes(name) && !args.some(arg => ["-e", "-E", "-s", "-es", "-Es", "--headless"].includes(arg))) {
		return { name, hint: "该调用通常等待终端输入；可使用文件编辑工具或编辑器的批处理模式。" };
	}
	if (name === "top") {
		// Linux accepts -bn1 / -b -n1 / -b -n 1. macOS accepts -l 1.
		const batch = args.some(arg => /^-[A-Za-z]*b[A-Za-z]*(?:\d+)?$/.test(arg));
		const count = args.some((arg, index) => /^-l\d+$/.test(arg) || (arg === "-l" && /^\d+$/.test(args[index + 1] ?? "")) || /^-[A-Za-z]*n\d+$/.test(arg) || (/^-[A-Za-z]*n$/.test(arg) && /^\d+$/.test(args[index + 1] ?? "")));
		if (!count || (!batch && !args.some(arg => /^-l/.test(arg)))) return { name, hint: "该调用通常持续刷新；有限批处理示例：top -b -n 1。" };
	}
	if (name === "fzf" && !args.some(arg => /^(?:--filter(?:=|$)|-f)/.test(arg))) return { name, hint: "该调用通常等待选择；非交互筛选可使用 fzf --filter。" };
	if (name === "git" && args[0] === "rebase" && args.slice(1).some(arg => arg === "-i" || arg === "--interactive")) {
		// An explicit sequence editor in the environment was deliberately supplied.
		if (environment.some(value => value.startsWith("GIT_SEQUENCE_EDITOR="))) return null;
		return { name: "git rebase -i", hint: "该调用可能打开编辑器；可显式设置 GIT_SEQUENCE_EDITOR，或在终端运行。" };
	}
	return null;
}

const rootPath = (value: string): boolean => value === "/" || /^[A-Za-z]:[\\/]$/.test(value);
const flag = (args: string[], pattern: RegExp): boolean => args.some(arg => pattern.test(arg));
const shallowDepth = (args: string[], option: RegExp): boolean => args.some((arg, index) => {
	const m = arg.match(option);
	if (!m) return false;
	const value = m[1] ?? args[index + 1];
	return /^(?:0|1)$/.test(value ?? "");
});

/** Extract path operands of grep/rg without confusing the pattern or option values with paths. */
function searchPaths({ name, args }: Invocation): string[] | null {
	const operands: string[] = [];
	let patternGiven = false;
	let endOptions = false;
	const takesValue = new Set(["-e", "--regexp", "-f", "--file", "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not", "--max-depth", "-m", "--max-count", "--encoding", "-A", "-B", "-C", "--after-context", "--before-context", "--context", "--include", "--exclude", "--exclude-dir"]);
	if (name === "rg") takesValue.add("-d");
	const numeric = new Set(["--max-depth", "-d", "-m", "--max-count", "-A", "-B", "-C", "--after-context", "--before-context", "--context"]);
	const validValue = (option: string, value: string | undefined): boolean => value !== undefined && value.length > 0 && (!numeric.has(option) || /^\d+$/.test(value));
	const safeFlags = /^(?:--(?:files|hidden|no-ignore|no-ignore-vcs|follow|no-follow|recursive|dereference-recursive|line-number|files-with-matches|files-without-match|ignore-case|fixed-strings|quiet|count|only-matching)|-[rRinlLsvFwoqHhUu]+)$/;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!endOptions && arg === "--") { endOptions = true; continue; }
		if (!endOptions && arg.startsWith("-")) {
			if (takesValue.has(arg)) {
				if (!validValue(arg, args[i + 1])) return null;
				if (["-e", "--regexp", "-f", "--file"].includes(arg)) patternGiven = true;
				i++;
			} else if (/^--(?:regexp|file)=/.test(arg) || /^-[ef].+/.test(arg)) {
				if (arg.endsWith("=")) return null;
				patternGiven = true;
			} else if (arg.startsWith("--") && takesValue.has(arg.split("=")[0]) && arg.includes("=")) {
				if (!validValue(arg.split("=")[0], arg.slice(arg.indexOf("=") + 1))) return null;
			} else if (name === "rg" && /^-d\d+$/.test(arg)) { /* attached depth value */ }
			else if (!safeFlags.test(arg)) return null;
			continue;
		}
		operands.push(arg);
	}
	if (!patternGiven && !(name === "rg" && args.includes("--files"))) operands.shift();
	return operands;
}

function childItemPaths(args: string[]): string[] | null {
	const paths: string[] = [];
	const values = new Set(["-path", "-literalpath", "-filter", "-include", "-exclude", "-attributes", "-depth"]);
	const switches = new Set(["-recurse", "-r", "-force", "-file", "-directory", "-hidden", "-system", "-readonly", "-name"]);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith("-")) { paths.push(arg); continue; }
		const colon = arg.indexOf(":");
		const option = (colon < 0 ? arg : arg.slice(0, colon)).toLowerCase();
		if (values.has(option)) {
			const value = colon < 0 ? args[++i] : arg.slice(colon + 1);
			if (value === undefined || (option === "-depth" && !/^\d+$/.test(value))) return null;
			if (option === "-path" || option === "-literalpath") paths.push(value);
		} else if (!switches.has(option) || colon >= 0) return null;
	}
	return paths;
}

export function scanKind(calls: Invocation[] | null): { recursive: boolean; root: boolean; unknown: boolean } {
	let recursive = false;
	let root = false;
	let unknown = calls === null;
	for (const call of calls ?? []) {
		const { name, args } = call;
		if (hasHelp(args)) continue;
		let isRecursive = false;
		let roots = false;
		let bounded = false;
		if (name === "find") {
			if (args.some(arg => /^\/(?:v|c|n|i|off|offline)$/i.test(arg))) continue; // Windows FIND is a text search
			isRecursive = true;
			const firstExpression = args.findIndex(arg => arg.startsWith("-") && !["-H", "-L", "-P"].includes(arg));
			roots = args.slice(0, firstExpression < 0 ? args.length : firstExpression).some(rootPath);
			bounded = shallowDepth(args, /^-maxdepth(?:=(\d+))?$/);
		} else if (["get-childitem", "gci"].includes(name) || (name === "dir" && flag(args, /^-(?:recurse|r|depth)(?::\d+)?$/i))) {
			isRecursive = flag(args, /^-(?:recurse|r|depth)(?::\d+)?$/i);
			const paths = childItemPaths(args);
			if (!paths) { unknown = true; continue; }
			roots = paths.some(rootPath);
			bounded = shallowDepth(args, /^-depth(?::(\d+))?$/i);
		} else if (name === "dir") {
			isRecursive = flag(args, /^\/s$/i);
			roots = args.some(rootPath);
		} else if (name === "grep" || name === "rg") {
			const paths = searchPaths(call);
			if (!paths) { unknown = true; continue; }
			roots = paths.some(rootPath);
			// A single file path is not evidence of a directory walk. Outside an
			// explicit recursion flag, only clear directory/root operands count.
			isRecursive = name === "rg" ? (roots || !paths.length || args.includes("--files") || paths.some(value => /[\\/]$/.test(value))) : flag(args, /^(?:--(?:dereference-)?recursive|-[A-Za-z]*[rR][A-Za-z]*)$/);
			bounded = name === "rg" && (shallowDepth(args, /^--max-depth(?:=(\d+))?$/) || shallowDepth(args, /^-d(\d+)?$/));
		} else if (name === "du" || name === "tree") {
			isRecursive = true;
			roots = args.some(rootPath);
			bounded = shallowDepth(args, /^(?:--max-depth(?:=(\d+))?|-L|-d)$/);
		}
		recursive ||= isRecursive;
		root ||= isRecursive && roots && !bounded;
	}
	return { recursive, root, unknown };
}

/** Add only missing transport options to one literal command; preserve stdin and every original byte. */
export function hardenTransport(command: string, shell: Shell, calls: Invocation[] | null): { cmd: string; injected: string[] } {
	if (calls?.length !== 1) return { cmd: command, injected: [] };
	const call = calls[0];
	if (hasHelp(call.args)) return { cmd: command, injected: [] };
	const parsed = parseCommands(command, shell);
	if (!parsed || parsed.length !== 1 || parsed[0].tokens[0]?.start !== call.tokens[0].start) return { cmd: command, injected: [] };
	// Even a trailing operator/comment is left untouched. Check only the text outside literal tokens.
	let outside = "";
	let end = call.tokens[0].start;
	const prefix = command.slice(0, end);
	if (!(shell === "powershell" ? /^\s*(?:&\s*)?$/.test(prefix) : /^\s*$/.test(prefix))) return { cmd: command, injected: [] };
	for (const token of call.tokens) { outside += command.slice(end, token.start); end = token.end; }
	outside += command.slice(end);
	if (/[^\s]/.test(outside)) return { cmd: command, injected: [] };
	const options: string[] = [];
	if (["ssh", "scp", "sftp"].includes(call.name)) {
		// Only inspect local options before the destination; remote command strings are data.
		const explicit = new Set<string>();
		const valueFlags = new Set(call.name === "ssh"
			? ["-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-p", "-Q", "-R", "-S", "-W", "-w"]
			: call.name === "scp" ? ["-c", "-D", "-F", "-i", "-J", "-l", "-P", "-S", "-X"]
			: ["-B", "-b", "-c", "-D", "-F", "-i", "-J", "-l", "-P", "-R", "-S", "-s", "-X"]);
		const noValue = call.name === "ssh" ? /^-[1246AaCfGgKkMNnqsTtVvXxYy]+$/ : call.name === "scp" ? /^-[346ABCOpqRrsTv]+$/ : /^-[46AaCfNpqrv]+$/;
		for (let i = 0; i < call.args.length; i++) {
			const arg = call.args[i];
			if (arg === "--" || !arg.startsWith("-")) break;
			// An explicit SSH config may define these per-host. Do not override it.
			if (arg === "-F" || arg.startsWith("-F")) return { cmd: command, injected: [] };
			if (arg === "-o" || arg.startsWith("-o")) {
				const value = arg === "-o" ? call.args[++i] : arg.slice(2);
				if (!value) return { cmd: command, injected: [] };
				explicit.add(value.split(/[=\s]/)[0].toLowerCase());
			} else if (arg === "-V" || arg === "-h") return { cmd: command, injected: [] };
			else if (valueFlags.has(arg)) {
				if (i + 1 >= call.args.length) return { cmd: command, injected: [] };
				i++;
			} else if (![...valueFlags].some(option => arg.startsWith(option) && arg.length > option.length) && !noValue.test(arg)) {
				return { cmd: command, injected: [] }; // unknown option layout: preserve the caller's command
			}
		}
		for (const [name, value] of [["ConnectTimeout", 15], ["ServerAliveInterval", 15], ["ServerAliveCountMax", 3]] as const) {
			if (!explicit.has(name.toLowerCase())) options.push(`-o ${name}=${value}`);
		}
	} else if (call.name === "rsync" && !call.args.some(arg => /^--timeout(?:=|$)/.test(arg))) {
		options.push("--timeout=15");
	}
	if (!options.length) return { cmd: command, injected: [] };
	const at = call.tokens[0].end;
	return { cmd: command.slice(0, at) + " " + options.join(" ") + command.slice(at), injected: [`${call.name}: 已补 ${options.join(" ")}`] };
}
