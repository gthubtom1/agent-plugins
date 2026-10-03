/**
 * Pi Infinite Retry Extension
 *
 * Provides a /retry command to toggle or configure network retry limits:
 *   /retry        - Toggle between default (3) and infinite (9999)
 *   /retry on     - Enable infinite retry (9999 retries)
 *   /retry off    - Restore default retry (3 retries)
 *   /retry status - View current retry settings
 *   /retry <num>  - Set custom retry count (e.g. /retry 50)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

export default function infiniteRetryExtension(pi: ExtensionAPI) {
	const homeDir = process.env.USERPROFILE || process.env.HOME || "";
	const settingsPath = path.join(homeDir, ".pi", "agent", "settings.json");

	function readSettings(): Record<string, any> {
		try {
			if (fs.existsSync(settingsPath)) {
				return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
			}
		} catch {}
		return {};
	}

	function writeSettings(settings: Record<string, any>): boolean {
		try {
			const dir = path.dirname(settingsPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
			return true;
		} catch {
			return false;
		}
	}

	pi.registerCommand("retry", {
		description: "切换或设置网络超时无限重试 (/retry, /retry on, /retry off, /retry status, /retry 100)",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "status", "infinite", "10", "50", "100"];
			const filtered = options.filter((o) => o.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((o) => ({ value: o, label: o })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();
			const settings = readSettings();
			settings.retry = settings.retry || {};

			let newRetries: number;
			let message: string;

			if (trimmed === "status" || trimmed === "info") {
				const current = settings.retry?.maxRetries ?? 3;
				const isInfinite = current >= 100;
				message = `当前重试模式: ${isInfinite ? `无限重试 (${current} 次)` : `默认模式 (${current} 次)`}`;
				if (ctx.ui?.notify) {
					ctx.ui.notify(message, "info");
				}
				return;
			}

			if (trimmed === "off" || trimmed === "0") {
				newRetries = 3;
				settings.retry.enabled = true;
				settings.retry.maxRetries = 3;
				if (settings.retry.provider) {
					settings.retry.provider.maxRetries = 3;
				}
				message = "已恢复默认重试模式 (3 次)";
			} else if (trimmed === "on" || trimmed === "infinite" || trimmed === "max") {
				newRetries = 9999;
				settings.retry.enabled = true;
				settings.retry.maxRetries = 9999;
				settings.retry.baseDelayMs = 2000;
				settings.retry.maxAgentDelayMs = 60000;
				settings.retry.provider = settings.retry.provider || {};
				settings.retry.provider.maxRetries = 9999;
				settings.retry.provider.maxRetryDelayMs = 30000;
				message = "已开启无限重试模式 (9999 次，指数避让)";
			} else if (/^\d+$/.test(trimmed)) {
				const count = parseInt(trimmed, 10);
				newRetries = count;
				settings.retry.enabled = true;
				settings.retry.maxRetries = count;
				settings.retry.provider = settings.retry.provider || {};
				settings.retry.provider.maxRetries = count;
				message = `已设置重试上限为 ${count} 次`;
			} else {
				// Toggle
				const current = settings.retry.maxRetries ?? 3;
				if (current >= 100) {
					newRetries = 3;
					settings.retry.maxRetries = 3;
					if (settings.retry.provider) {
						settings.retry.provider.maxRetries = 3;
					}
					message = "已关闭无限重试，恢复默认 (3 次)";
				} else {
					newRetries = 9999;
					settings.retry.enabled = true;
					settings.retry.maxRetries = 9999;
					settings.retry.baseDelayMs = 2000;
					settings.retry.maxAgentDelayMs = 60000;
					settings.retry.provider = settings.retry.provider || {};
					settings.retry.provider.maxRetries = 9999;
					settings.retry.provider.maxRetryDelayMs = 30000;
					message = "已开启无限重试模式 (9999 次，指数避让)";
				}
			}

			writeSettings(settings);

			if (ctx.ui?.notify) {
				ctx.ui.notify(message, "info");
			}
			if (ctx.ui?.setStatus) {
				ctx.ui.setStatus("retry", newRetries > 10 ? "无限重试: 开" : undefined);
			}

			// Reload configuration into active runtime
			await ctx.reload();
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const settings = readSettings();
		const retries = settings.retry?.maxRetries ?? 3;
		if (retries > 10 && ctx.ui?.setStatus) {
			ctx.ui.setStatus("retry", "无限重试: 开");
		}
	});
}
