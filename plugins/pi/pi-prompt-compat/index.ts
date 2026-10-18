import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DebugTracker } from "./debug.js";
import { discoverCompatibilityFiles } from "./discovery.js";
import { PersonalityLoader } from "./personality-loader.js";
import { assembleCompatibilitySections } from "./prompt-assembly.js";
import { RulesLoader } from "./rules-loader.js";

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

	// Helper to reload and assemble
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
			// Toggle
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
	pi.registerCommand("rules-debug", {
		description: "Toggle Personality & Rules debug mode or display status",
		handler: handleDebugCommand,
	});
	pi.registerCommand("omp-debug", {
		description: "Alias for /rules-debug",
		handler: handleDebugCommand,
	});

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

	// 3. Lifecycle hook: before_agent_start
	pi.on("before_agent_start", (event, ctx: ExtensionContext) => {
		// Check flags
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

		// Ensure sections dictionary exists
		event.systemPromptOptions.sections = event.systemPromptOptions.sections ?? {};

		// Inject Personality as an independent prompt block
		if (assembled.personalitySection) {
			event.systemPromptOptions.sections["personality"] = assembled.personalitySection;
		} else {
			delete event.systemPromptOptions.sections["personality"];
		}

		// Inject RULES as an independent always-apply generic-rules block
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
	// Runs before EVERY LLM request (first request, tool calls, and post-compaction)
	pi.on("context_with_system", (event, _ctx: ExtensionContext) => {
		const head = event.messages[0];
		let rulesPresent = false;
		let personalityPresent = false;

		const cachedPersonality = personalityLoader.getCached();
		const cachedRules = rulesLoader.getCached();

		if (head && head.role === "system") {
			const sections = (head as { sections?: Record<string, string | null> }).sections;
			if (sections) {
				if (sections["generic-rules"]) {
					rulesPresent = true;
				}
				if (sections["personality"]) {
					personalityPresent = true;
				}
			}

			// Check raw content as fallback
			const contentStr = typeof head.content === "string" ? head.content : "";
			if (!rulesPresent && contentStr.includes("<generic-rules>")) {
				rulesPresent = true;
			}
			if (!personalityPresent && contentStr.includes("<personality>")) {
				personalityPresent = true;
			}

			// Guarantee: if cached items exist but are missing in head.sections, re-anchor them
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
	// Directly inspects the provider payload immediately before HTTP send
	pi.on("before_provider_request", (event, _ctx: ExtensionContext) => {
		if (!debugTracker.isDebugEnabled()) return;

		try {
			const payloadStr = JSON.stringify(event.payload ?? "");
			const hasRules = payloadStr.includes("generic-rules") || payloadStr.includes("security_master_gateway");
			const hasPersonality = payloadStr.includes("personality") || payloadStr.includes("Little Code Sauce");

			debugTracker.log(`Provider Payload Check: rulesInPayload=${hasRules}, personalityInPayload=${hasPersonality}`);
		} catch {
			// Ignore serialization errors in debug check
		}
	});

	// 6. Lifecycle hook: session_compact
	pi.on("session_compact", (event, _ctx: ExtensionContext) => {
		debugTracker.log(
			`session_compact: reason=${event.reason}, compaction saved, checking sticky rules continuity`,
		);
	});
}
