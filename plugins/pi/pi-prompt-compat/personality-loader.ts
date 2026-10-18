import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { DiscoveredFiles } from "./discovery.js";
import { LoadedPersonality } from "./types.js";

function computeHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

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
