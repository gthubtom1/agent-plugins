export type Shell = "bash" | "powershell";

export interface CommandToken {
	/** Literal value after removing shell quotes and supported escapes. */
	value: string;
	/** UTF-16 source offsets, including quotes/escapes; end is exclusive. */
	start: number;
	end: number;
}

export interface SimpleCommand {
	tokens: CommandToken[];
}

const BASH_CONTROL = new Set([
	"if", "then", "elif", "else", "fi", "for", "select", "while", "until",
	"do", "done", "case", "esac", "in", "function", "time", "coproc",
	"return", "break", "continue", "exit", ".",
]);
const POWERSHELL_CONTROL = new Set([
	"if", "elseif", "else", "switch", "foreach", "for", "while", "do", "until",
	"function", "filter", "workflow", "class", "enum", "try", "catch", "finally",
	"trap", "data", "dynamicparam", "begin", "process", "end", "clean", "param",
	"return", "break", "continue", "throw", "exit", "using", "configuration", ".",
]);
const PS_ESCAPES: Record<string, string> = {
	"0": "\0", a: "\x07", b: "\b", e: "\x1b", f: "\f",
	n: "\n", r: "\r", t: "\t", v: "\x0b",
};

/** Lowercase basename for either path style. Extensions deliberately remain. */
export function programName(token: string): string {
	return token.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
}

/**
 * Recognize literal simple commands, not shell programs. null means the ENTIRE
 * input is unsupported; empty input/comments return []. No expansion, execution,
 * alias resolution, wrapper unwrapping, or interpretation of script arguments.
 *
 * Separators and line comments are recognized only outside quotes. Bash quotes
 * may concatenate; PowerShell quotes must occupy a whole token, and a quoted
 * command requires the leading & invocation operator (not included in tokens).
 * Bash NAME=value prefixes remain ordinary tokens for callers to unwrap.
 *
 * Reject expansions, globs, redirections, grouping, control flow, here documents,
 * here strings, block comments, line continuations, and malformed command chains.
 * Literal quoted metacharacters are data. Drive/UNC/dot-relative Windows paths
 * retain unquoted backslashes in either dialect, a deliberate Bash concession;
 * ambiguous escapes in those Bash paths are rejected. Other Bash escapes follow
 * Bash rules. This deliberately small subset may reject valid shell input.
 */
export function parseCommands(command: string, shell: Shell): SimpleCommand[] | null {
	const ps = shell === "powershell";
	if (command.includes("\0") || (ps && /[\u2018\u2019\u201c\u201d]/.test(command))) return null;
	const commands: SimpleCommand[] = [];
	let tokens: CommandToken[] = [];
	let firstQuoted = false;
	let invoked = false;
	let required = false;
	let i = 0;

	const finish = (): boolean => {
		if (!tokens.length) return false;
		let program = 0;
		if (!ps) {
			while (program < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[program].value)) {
				// Quoting/escaping the name or '=' makes this a command word in Bash.
				if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(command.slice(tokens[program].start))) return false;
				program++;
			}
		}
		if (program === tokens.length) return false;
		const name = tokens[program].value;
		const controls = ps ? POWERSHELL_CONTROL : BASH_CONTROL;
		// Reject even quoted control words: false negatives are preferable here.
		if (!name || controls.has(ps ? name.toLowerCase() : name)) return false;
		if (ps && firstQuoted && !invoked) return false;
		commands.push({ tokens });
		tokens = [];
		firstQuoted = false;
		invoked = false;
		return true;
	};

	while (i < command.length) {
		const c = command[i];
		if (c === " " || c === "\t") { i++; continue; }
		if (c === "#") {
			while (i < command.length && command[i] !== "\n" && command[i] !== "\r") i++;
			continue;
		}
		if (c === "\n" || c === "\r" || c === ";" || c === "&" || c === "|") {
			const pair = (c === "&" || c === "|") && command[i + 1] === c;
			// PowerShell's call operator starts a command; it is not an argument.
			if (ps && c === "&" && !pair && !tokens.length) {
				if (invoked) return null;
				invoked = true;
				required = true;
				i++;
				continue;
			}
			const newline = c === "\n" || c === "\r";
			if (!tokens.length) {
				if (!newline || invoked) return null;
			} else {
				if (!finish()) return null;
				required = c === "|" || pair;
			}
			i += pair || (c === "\r" && command[i + 1] === "\n") ? 2 : 1;
			continue;
		}

		const start = i;
		const windowsPath = /^(?:[A-Za-z]:\\|\\\\|\.{1,2}\\)/.test(command.slice(i));
		let value = "";
		let quote = "";
		let quoted = false;
		while (i < command.length) {
			const ch = command[i];
			if (!quote && /[ \t\r\n;&|]/.test(ch)) break;
			if (quote === "'") {
				if (ch === "'" && ps && command[i + 1] === "'") {
					value += "'";
					i += 2;
				} else if (ch === "'") {
					quote = "";
					i++;
					if (ps) break;
				} else {
					value += ch;
					i++;
				}
				continue;
			}
			if ((ch === "'" && !quote) || ch === '"') {
				if (ps && !quote && i !== start) return null;
				if (quote === '"' && ch === '"') {
					quote = "";
					i++;
					if (ps) break;
				} else if (!quote) {
					quote = ch;
					quoted = true;
					i++;
				} else {
					value += ch;
					i++;
				}
				continue;
			}
			if ((ps && ch === "`") || (!ps && ch === "\\")) {
				const next = command[i + 1];
				if (next === undefined || next === "\n" || next === "\r") return null;
				if (!ps && quote === '"' && !/[\\"$`]/.test(next)) {
					value += ch;
					i++;
					continue;
				}
				if (!ps && !quote && windowsPath) {
					if (/[\s'"`$;&|<>(){}!*?\[\]~#]/.test(next)) return null;
					value += ch;
					i++;
					continue;
				}
				// PowerShell Unicode escapes have variable length; leave them unsupported.
				if (ps && next === "u") return null;
				value += ps ? (PS_ESCAPES[next] ?? next) : next;
				i += 2;
				continue;
			}
			if (ch === "$" || (!ps && ch === "`")) return null;
			if (!quote) {
				if (/[<>(){}\[\]*?!]/.test(ch) || (ch === "~" && i === start) || (ps && (ch === "," || (ch === "@" && i === start)))) return null;
				// A Bash # inside a word is literal; PS comment placement is restricted.
				if (ps && ch === "#") return null;
			}
			if (ch === "\0" || /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(ch)) return null;
			value += ch;
			i++;
		}
		if (quote) return null;
		if (ps && i < command.length && !/[ \t\r\n;&|]/.test(command[i])) return null;
		if (ps && value === "--%") return null;
		if (!tokens.length) firstQuoted = quoted;
		tokens.push({ value, start, end: i });
		required = false;
	}
	if (tokens.length && !finish()) return null;
	return required || invoked ? null : commands;
}
