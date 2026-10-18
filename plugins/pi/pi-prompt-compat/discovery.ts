import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export interface DiscoveredFiles {
	userPersonalityPath: string | null;
	projectPersonalityPath: string | null;
	userRulesPath: string | null;
	projectRulesPath: string | null;
}

function getCandidateUserDirs(): string[] {
	const home = homedir();
	const dirs: string[] = [];

	// PI_CODING_AGENT_DIR if set
	if (process.env.PI_CODING_AGENT_DIR) {
		dirs.push(resolve(process.env.PI_CODING_AGENT_DIR));
	}

	// Standard Pi agent directory: ~/.pi/agent
	dirs.push(join(home, ".pi", "agent"));

	return dirs;
}

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
		// Check .pi/<fileName> and <cwd>/<fileName>
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
	const userDirs = getCandidateUserDirs();

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
