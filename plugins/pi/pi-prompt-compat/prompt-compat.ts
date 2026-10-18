import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface LoadedPersonality {
	source: "user" | "project" | "preset" | "none";
	path: string | null;
	content: string;
	hash: string;
	length: number;
	mtime: number;
}

export interface LoadedRule {
	source: "user" | "project";
	path: string;
	content: string;
	alwaysApply: boolean;
	hash: string;
	length: number;
	mtime: number;
}

export interface PromptAssemblyState {
	personalityIncluded: boolean;
	rulesIncluded: boolean;
	personalitySectionLength: number;
	rulesSectionLength: number;
}

export interface DebugSnapshot {
	personality: LoadedPersonality | null;
	rules: LoadedRule[];
	assembly: PromptAssemblyState;
	requestCount: number;
	lastRequestRulesPresent: boolean;
	lastRequestPersonalityPresent: boolean;
}

export interface DiscoveredFiles {
	userPersonalityPath: string | null;
	projectPersonalityPath: string | null;
	userRulesPath: string | null;
	projectRulesPath: string | null;
}

// ============================================================================
// Discovery Engine
// ============================================================================

function findExistingNonEmptyFile(candidatePaths: string[]): string | null {
	for (const candidate of candidatePaths) {
		try {
			if (existsSync(candidate)) {
				const stats = statSync(candidate);
				if (stats.isFile() && stats.size > 0) {
					return resolve(candidate);
				}
			}
		} catch {
			// Ignore access or stat errors
		}
	}
	return null;
}

function findProjectFile(cwd: string, fileName: string): string | null {
	let current = resolve(cwd);
	const { root } = parse(current);

	while (true) {
		const inPiDir = join(current, ".pi", fileName);
		const inRootDir = join(current, fileName);

		const found = findExistingNonEmptyFile([inPiDir, inRootDir]);
		if (found) {
			return found;
		}

		if (current === root) {
			break;
		}
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}

	return null;
}

export function discoverCompatibilityFiles(cwd: string): DiscoveredFiles {
	const home = homedir();
	const userDirs: string[] = [];

	if (process.env.PI_CODING_AGENT_DIR) {
		userDirs.push(resolve(process.env.PI_CODING_AGENT_DIR));
	}
	userDirs.push(join(home, ".pi", "agent"));

	const userPersonalityCandidates = userDirs.map((d) => join(d, "PERSONALITY.md"));
	const userRulesCandidates = userDirs.map((d) => join(d, "RULES.md"));

	const userPersonalityPath = findExistingNonEmptyFile(userPersonalityCandidates);
	const userRulesPath = findExistingNonEmptyFile(userRulesCandidates);

	const projectPersonalityPath = findProjectFile(cwd, "PERSONALITY.md");
	const projectRulesPath = findProjectFile(cwd, "RULES.md");

	return {
		userPersonalityPath,
		projectPersonalityPath,
		userRulesPath,
		projectRulesPath,
	};
}

// ============================================================================
// Content Deduplication
// ============================================================================

export function splitComparablePromptBlocks(content: string | null | undefined): string[] {
	if (!content) return [];
	const trimmed = content.trim();
	if (!trimmed) return [];

	const blocks: string[] = [];
	let current: string[] = [];
	let inFence = false;

	for (const line of trimmed.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			current.push(line);
			continue;
		}
		if (!inFence && line.trim() === "" && current.length > 0 && current[current.length - 1].trim() !== "") {
			const block = current.join("\n").trim();
			if (block.length > 0) blocks.push(block);
			current = [];
			continue;
		}
		current.push(line);
	}

	const tail = current.join("\n").trim();
	if (tail.length > 0) blocks.push(tail);
	return blocks;
}

export function promptBlocksContain(sourceBlocks: string[], ruleBlocks: string[]): boolean {
	if (sourceBlocks.length === 0 || ruleBlocks.length === 0 || ruleBlocks.length > sourceBlocks.length) {
		return false;
	}
	for (let start = 0; start <= sourceBlocks.length - ruleBlocks.length; start += 1) {
		if (ruleBlocks.every((block, offset) => sourceBlocks[start + offset] === block)) {
			return true;
		}
	}
	return false;
}

export function promptSourceContainsRule(source: string | null | undefined, ruleContent: string): boolean {
	return promptBlocksContain(splitComparablePromptBlocks(source), splitComparablePromptBlocks(ruleContent));
}

function computeHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

// ============================================================================
// Loaders
// ============================================================================

export class PersonalityLoader {
	private cached: LoadedPersonality | null = null;

	public load(discovered: DiscoveredFiles, forceReload = false): LoadedPersonality | null {
		const targetPath = discovered.projectPersonalityPath ?? discovered.userPersonalityPath;
		const source = discovered.projectPersonalityPath ? "project" : "user";

		if (!targetPath) {
			this.cached = null;
			return null;
		}

		try {
			const stats = statSync(targetPath);
			if (!stats.isFile()) {
				this.cached = null;
				return null;
			}

			if (!forceReload && this.cached && this.cached.path === targetPath && this.cached.mtime === stats.mtimeMs) {
				return this.cached;
			}

			const raw = readFileSync(targetPath, "utf-8");
			const content = raw.trim();

			if (!content) {
				this.cached = null;
				return null;
			}

			this.cached = {
				source,
				path: targetPath,
				content,
				hash: computeHash(content),
				length: content.length,
				mtime: stats.mtimeMs,
			};

			return this.cached;
		} catch {
			this.cached = null;
			return null;
		}
	}

	public getCached(): LoadedPersonality | null {
		return this.cached;
	}

	public clear(): void {
		this.cached = null;
	}
}

export class RulesLoader {
	private cachedRules: LoadedRule[] = [];

	public load(discovered: DiscoveredFiles, forceReload = false): LoadedRule[] {
		const candidates: Array<{ path: string | null; source: "user" | "project" }> = [
			{ path: discovered.userRulesPath, source: "user" },
			{ path: discovered.projectRulesPath, source: "project" },
		];

		const rules: LoadedRule[] = [];

		for (const { path: filePath, source } of candidates) {
			if (!filePath) continue;

			try {
				const stats = statSync(filePath);
				if (!stats.isFile()) continue;

				const existing = !forceReload ? this.cachedRules.find((r) => r.path === filePath) : undefined;
				if (existing && existing.mtime === stats.mtimeMs) {
					rules.push(existing);
					continue;
				}

				const raw = readFileSync(filePath, "utf-8");
				const content = raw.trim();
				if (!content) continue;

				rules.push({
					source,
					path: filePath,
					content,
					alwaysApply: true,
					hash: computeHash(content),
					length: content.length,
					mtime: stats.mtimeMs,
				});
			} catch {
				// Ignore unreadable or inaccessible files
			}
		}

		this.cachedRules = rules;
		return rules;
	}

	public getEffectiveRules(rules: LoadedRule[], existingSources: Array<string | null | undefined>): LoadedRule[] {
		if (rules.length === 0) return [];
		return rules.filter((rule) => !existingSources.some((src) => promptSourceContainsRule(src, rule.content)));
	}

	public getCached(): LoadedRule[] {
		return this.cachedRules;
	}

	public clear(): void {
		this.cachedRules = [];
	}
}

// ============================================================================
// Prompt Assembly
// ============================================================================

export interface AssembledSections {
	personalitySection: string | null;
	rulesSection: string | null;
	state: PromptAssemblyState;
}

export function assembleCompatibilitySections(
	personality: LoadedPersonality | null,
	rules: LoadedRule[],
): AssembledSections {
	let personalitySection: string | null = null;
	if (personality && personality.content.trim().length > 0) {
		personalitySection = personality.content.trim();
	}

	let rulesSection: string | null = null;
	if (rules.length > 0) {
		const ruleBodies = rules.map((r) => r.content.trim()).filter((c) => c.length > 0);
		if (ruleBodies.length > 0) {
			rulesSection = ruleBodies.join("\n\n---\n\n");
		}
	}

	const state: PromptAssemblyState = {
		personalityIncluded: personalitySection !== null,
		rulesIncluded: rulesSection !== null,
		personalitySectionLength: personalitySection?.length ?? 0,
		rulesSectionLength: rulesSection?.length ?? 0,
	};

	return {
		personalitySection,
		rulesSection,
		state,
	};
}

// ============================================================================
// Debug Tracker
// ============================================================================

export class DebugTracker {
	private debugEnabled = false;
	private personality: LoadedPersonality | null = null;
	private rules: LoadedRule[] = [];
	private assembly: PromptAssemblyState = {
		personalityIncluded: false,
		rulesIncluded: false,
		personalitySectionLength: 0,
		rulesSectionLength: 0,
	};
	private requestCount = 0;
	private lastRequestRulesPresent = false;
	private lastRequestPersonalityPresent = false;

	public setDebugEnabled(enabled: boolean): void {
		this.debugEnabled = enabled;
	}

	public isDebugEnabled(): boolean {
		return this.debugEnabled;
	}

	public updateState(
		personality: LoadedPersonality | null,
		rules: LoadedRule[],
		assembly: PromptAssemblyState,
	): void {
		this.personality = personality;
		this.rules = rules;
		this.assembly = assembly;
	}

	public recordRequest(rulesPresent: boolean, personalityPresent: boolean): number {
		this.requestCount += 1;
		this.lastRequestRulesPresent = rulesPresent;
		this.lastRequestPersonalityPresent = personalityPresent;
		return this.requestCount;
	}

	public log(message: string, ...args: unknown[]): void {
		if (this.debugEnabled) {
			console.error(`[Rules-Compat Debug] ${message}`, ...args);
		}
	}

	public getSnapshot(): DebugSnapshot {
		return {
			personality: this.personality,
			rules: this.rules,
			assembly: this.assembly,
			requestCount: this.requestCount,
			lastRequestRulesPresent: this.lastRequestRulesPresent,
			lastRequestPersonalityPresent: this.lastRequestPersonalityPresent,
		};
	}

	public formatStatus(): string {
		const lines: string[] = [];
		lines.push("=== Pi Personality & Always-Apply Rules Status ===");

		lines.push("PERSONALITY");
		if (this.personality) {
			lines.push(`  source:   ${this.personality.source}`);
			lines.push(`  path:     ${this.personality.path}`);
			lines.push("  loaded:   yes");
			lines.push(`  hash:     ${this.personality.hash}`);
			lines.push(`  length:   ${this.personality.length} chars`);
		} else {
			lines.push("  source:   none");
			lines.push("  path:     none");
			lines.push("  loaded:   no");
			lines.push("  hash:     n/a");
			lines.push("  length:   0 chars");
		}

		lines.push("");
		lines.push("RULES");
		if (this.rules.length > 0) {
			for (let i = 0; i < this.rules.length; i++) {
				const r = this.rules[i];
				lines.push(`  [${i + 1}] source:      ${r.source}`);
				lines.push(`      path:        ${r.path}`);
				lines.push("      loaded:      yes");
				lines.push(`      alwaysApply: ${r.alwaysApply ? "yes" : "no"}`);
				lines.push(`      hash:        ${r.hash}`);
				lines.push(`      length:      ${r.length} chars`);
			}
		} else {
			lines.push("  source:      none");
			lines.push("  path:        none");
			lines.push("  loaded:      no");
			lines.push("  alwaysApply: no");
			lines.push("  hash:        n/a");
			lines.push("  length:      0 chars");
		}

		lines.push("");
		lines.push("Prompt Assembly");
		lines.push(`  personality included: ${this.assembly.personalityIncluded ? "yes" : "no"}`);
		lines.push(`  rules included:       ${this.assembly.rulesIncluded ? "yes" : "no"}`);

		lines.push("");
		lines.push(`Request #${this.requestCount}`);
		lines.push(`  rules present:       ${this.lastRequestRulesPresent ? "yes" : "no"}`);
		lines.push(`  personality present: ${this.lastRequestPersonalityPresent ? "yes" : "no"}`);
		lines.push("=================================================");

		return lines.join("\n");
	}
}

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
	const debugTracker = new DebugTracker();
	const personalityLoader = new PersonalityLoader();
	const rulesLoader = new RulesLoader();

	// 1. Register CLI flags
	pi.registerFlag("rules-debug", {
		description: "Enable Personality & Always-Apply Rules debug output",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("omp-debug", {
		description: "Alias for --rules-debug",
		type: "boolean",
		default: false,
	});

	function syncPromptState(cwd: string, existingSources: Array<string | null | undefined> = [], forceReload = false) {
		const discovered = discoverCompatibilityFiles(cwd);

		const personality = personalityLoader.load(discovered, forceReload);
		const allRules = rulesLoader.load(discovered, forceReload);
		const effectiveRules = rulesLoader.getEffectiveRules(allRules, existingSources);

		const assembled = assembleCompatibilitySections(personality, effectiveRules);

		debugTracker.updateState(personality, effectiveRules, assembled.state);

		return assembled;
	}

	const handleDebugCommand = async (args: string, ctx: ExtensionCommandContext) => {
		const trimmed = args.trim().toLowerCase();
		if (trimmed === "on" || trimmed === "true" || trimmed === "1") {
			debugTracker.setDebugEnabled(true);
			ctx.ui.notify("Rules Debug: ENABLED", "info");
		} else if (trimmed === "off" || trimmed === "false" || trimmed === "0") {
			debugTracker.setDebugEnabled(false);
			ctx.ui.notify("Rules Debug: DISABLED", "info");
		} else {
			const nextState = !debugTracker.isDebugEnabled();
			debugTracker.setDebugEnabled(nextState);
			ctx.ui.notify(`Rules Debug: ${nextState ? "ENABLED" : "DISABLED"}`, "info");
		}

		const status = debugTracker.formatStatus();
		debugTracker.log("\n" + status);
	};

	const handleStatusCommand = async (_args: string, ctx: ExtensionCommandContext) => {
		syncPromptState(ctx.cwd);
		const status = debugTracker.formatStatus();
		console.log("\n" + status);
		ctx.ui.notify("Rules & Personality status displayed in console", "info");
	};

	const handleReloadCommand = async (_args: string, ctx: ExtensionCommandContext) => {
		syncPromptState(ctx.cwd, [], true);
		ctx.ui.notify("PERSONALITY.md and RULES.md reloaded from disk", "info");
		const status = debugTracker.formatStatus();
		debugTracker.log("\n" + status);
	};

	// 2. Register commands
	pi.registerCommand("rules-status", {
		description: "Show current Personality & Always-Apply Rules status",
		handler: handleStatusCommand,
	});
	pi.registerCommand("omp-status", {
		description: "Alias for /rules-status",
		handler: handleStatusCommand,
	});

	pi.registerCommand("rules-reload", {
		description: "Force reload PERSONALITY.md and RULES.md from disk",
		handler: handleReloadCommand,
	});
	pi.registerCommand("omp-reload", {
		description: "Alias for /rules-reload",
		handler: handleReloadCommand,
	});

	pi.registerCommand("rules-debug", {
		description: "Toggle Personality & Rules debug mode or display status",
		handler: handleDebugCommand,
	});
	pi.registerCommand("omp-debug", {
		description: "Alias for /rules-debug",
		handler: handleDebugCommand,
	});

	// 3. Lifecycle hook: before_agent_start
	pi.on("before_agent_start", (event, ctx: ExtensionContext) => {
		const isDebug = (val: unknown) => val === true || val === "true" || val === "1";
		if (isDebug(pi.getFlag("rules-debug")) || isDebug(pi.getFlag("omp-debug"))) {
			debugTracker.setDebugEnabled(true);
		}

		const promptSources: Array<string | null | undefined> = [
			event.systemPromptOptions.customPrompt,
			event.systemPromptOptions.appendSystemPrompt,
			...(event.systemPromptOptions.contextFiles?.map((f) => f.content) ?? []),
		];

		const assembled = syncPromptState(ctx.cwd, promptSources);

		event.systemPromptOptions.sections = event.systemPromptOptions.sections ?? {};

		if (assembled.personalitySection) {
			event.systemPromptOptions.sections["personality"] = assembled.personalitySection;
		} else {
			delete event.systemPromptOptions.sections["personality"];
		}

		if (assembled.rulesSection) {
			event.systemPromptOptions.sections["generic-rules"] = assembled.rulesSection;
		} else {
			delete event.systemPromptOptions.sections["generic-rules"];
		}

		debugTracker.log(
			`before_agent_start: personality=${assembled.state.personalityIncluded ? "YES" : "NO"} (${assembled.state.personalitySectionLength} chars), rules=${assembled.state.rulesIncluded ? "YES" : "NO"} (${assembled.state.rulesSectionLength} chars)`,
		);
	});

	// 4. Lifecycle hook: context_with_system
	pi.on("context_with_system", (event, _ctx: ExtensionContext) => {
		const head = event.messages[0];
		let rulesPresent = false;
		let personalityPresent = false;

		const cachedPersonality = personalityLoader.getCached();
		const cachedRules = rulesLoader.getCached();

		if (head && head.role === "system") {
			const sections = (head as { sections?: Record<string, string | null> }).sections;
			if (sections) {
				if (sections["generic-rules"]) rulesPresent = true;
				if (sections["personality"]) personalityPresent = true;
			}

			const contentStr = typeof head.content === "string" ? head.content : "";
			if (!rulesPresent && contentStr.includes("<generic-rules>")) rulesPresent = true;
			if (!personalityPresent && contentStr.includes("<personality>")) personalityPresent = true;

			if (!personalityPresent && cachedPersonality) {
				const assembled = assembleCompatibilitySections(cachedPersonality, []);
				if (assembled.personalitySection) {
					head.sections = head.sections ?? {};
					head.sections["personality"] = assembled.personalitySection;
					personalityPresent = true;
				}
			}

			if (!rulesPresent && cachedRules.length > 0) {
				const assembled = assembleCompatibilitySections(null, cachedRules);
				if (assembled.rulesSection) {
					head.sections = head.sections ?? {};
					head.sections["generic-rules"] = assembled.rulesSection;
					rulesPresent = true;
				}
			}
		}

		const reqNum = debugTracker.recordRequest(rulesPresent, personalityPresent);
		debugTracker.log(`LLM Request #${reqNum}: rulesPresent=${rulesPresent}, personalityPresent=${personalityPresent}`);
	});

	// 5. Lifecycle hook: before_provider_request
	pi.on("before_provider_request", (event, _ctx: ExtensionContext) => {
		if (!debugTracker.isDebugEnabled()) return;

		try {
			const payloadStr = JSON.stringify(event.payload ?? "");
			const hasRules = payloadStr.includes("generic-rules") || payloadStr.includes("security_master_gateway");
			const hasPersonality = payloadStr.includes("personality") || payloadStr.includes("Little Code Sauce");

			debugTracker.log(`Provider Payload Check: rulesInPayload=${hasRules}, personalityInPayload=${hasPersonality}`);
		} catch {
			// Ignore
		}
	});

	// 6. Lifecycle hook: session_compact
	pi.on("session_compact", (event, _ctx: ExtensionContext) => {
		debugTracker.log(`session_compact: reason=${event.reason}, sticky rules preserved`);
	});
}
