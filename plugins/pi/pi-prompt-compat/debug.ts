import { DebugSnapshot, LoadedPersonality, LoadedRule, PromptAssemblyState } from "./types.js";

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
