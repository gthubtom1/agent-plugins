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
