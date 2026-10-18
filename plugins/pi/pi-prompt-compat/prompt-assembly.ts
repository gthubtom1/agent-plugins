import { LoadedPersonality, LoadedRule, PromptAssemblyState } from "./types.js";

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
		personalitySection = `# Personality\n${personality.content.trim()}`;
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
