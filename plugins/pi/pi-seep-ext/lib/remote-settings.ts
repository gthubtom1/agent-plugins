import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Remote-access settings this extension owns.
 *
 * Worth keeping on disk: pi-web reads `PI_WEB_PASSWORD` from its own process
 * environment on every request, so a password generated at runtime works
 * immediately — but the environment of the next launch will not have it. Storing
 * it here and writing it back on load keeps phones logged in across restarts.
 *
 * Nothing is enabled by default: an absent file means "no password", which is
 * what someone who only uses their own Wi-Fi wants.
 */
export const REMOTE_SETTINGS_NAME = "pi-web-remote.json";

export interface RemoteSettings {
  password: string | null;
  /** Last mode the person picked, so the menu can show it first. */
  lastMode: "lan" | "tailscale" | null;
  /**
   * Extra hostnames this extension added to pi-web's allow-list (the tailnet's
   * MagicDNS name, a fixed tunnel domain). pi-web reads
   * `PI_WEB_ALLOWED_HOSTS` per request, so these apply immediately; keeping them
   * on disk makes them survive a restart.
   */
  allowedHosts: string[];
}

const DEFAULTS: RemoteSettings = { password: null, lastMode: null, allowedHosts: [] };

export function remoteSettingsPath(agentDir: string): string {
  return join(agentDir, REMOTE_SETTINGS_NAME);
}

export function normalizeRemoteSettings(input: unknown): RemoteSettings {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ...DEFAULTS };
  const raw = input as Record<string, unknown>;
  const password = typeof raw.password === "string" && raw.password.length > 0 ? raw.password : null;
  const lastMode = raw.lastMode === "lan" || raw.lastMode === "tailscale" ? raw.lastMode : null;
  const allowedHosts = Array.isArray(raw.allowedHosts)
    ? raw.allowedHosts.filter((host): host is string => typeof host === "string" && host.trim().length > 0).map((host) => host.trim())
    : [];
  return { password, lastMode, allowedHosts: [...new Set(allowedHosts)] };
}

/** `hosts` plus `host`, trimmed and de-duplicated, order preserved. */
export function mergeAllowedHosts(hosts: readonly string[], host: string): string[] {
  const next = hosts.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (!next.includes(host.trim())) next.push(host.trim());
  return [...new Set(next)];
}

/** The value pi-web expects in PI_WEB_ALLOWED_HOSTS. */
export function allowedHostsEnv(hosts: readonly string[]): string {
  return [...new Set(hosts.map((host) => host.trim()).filter(Boolean))].join(",");
}

export function readRemoteSettings(agentDir: string): RemoteSettings {
  try {
    return normalizeRemoteSettings(JSON.parse(readFileSync(remoteSettingsPath(agentDir), "utf8")));
  } catch {
    return { ...DEFAULTS };
  }
}

export interface WriteResult extends RemoteSettings {
  /** False when the file could not be written (read-only dir): the runtime value still applies. */
  saved: boolean;
}

export function writeRemoteSettings(patch: Partial<RemoteSettings>, agentDir: string): WriteResult {
  const current = readRemoteSettings(agentDir);
  let stored: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(remoteSettingsPath(agentDir), "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
  } catch { /* no file yet */ }

  const next: RemoteSettings = {
    password: patch.password === undefined ? current.password : patch.password,
    lastMode: patch.lastMode === undefined ? current.lastMode : patch.lastMode,
    allowedHosts: patch.allowedHosts === undefined ? current.allowedHosts : [...new Set(patch.allowedHosts)],
  };
  let saved = false;
  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      remoteSettingsPath(agentDir),
      `${JSON.stringify({ ...stored, ...next }, null, 2)}\n`,
      "utf8",
    );
    saved = true;
  } catch { /* a read-only agent dir must not break the report */ }
  return { ...next, saved };
}

/** A password a person can retype from a screen: no look-alike pairs. */
export function generatePassword(length = 12): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let index = 0; index < length; index++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
