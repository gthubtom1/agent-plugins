import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { promptSourceContainsRule } from "./dedupe.js";
import { DiscoveredFiles } from "./discovery.js";
import { LoadedRule } from "./types.js";

function computeHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 12);
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
