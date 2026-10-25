/**
 * Reading Tailscale's state without guessing.
 *
 * `tailscale status --json` reports a `BackendState`; what matters for "can the
 * phone connect right now" is only whether it is `Running`. The other states
 * need different advice, so they are kept apart instead of collapsed into a
 * boolean:
 *
 * - `needs-login` — the account must be authorised once, on this machine. Only
 *   the person can finish that; the CLI prints a URL for it.
 * - `stopped` / `NoState` — the service is up but disconnected. `tailscale up`
 *   reconnects without a browser when the node key still exists (the common
 *   case after a reboot), which is why this is worth distinguishing.
 * - `starting` — give it a moment rather than reporting a failure.
 *
 * When the CLI is missing entirely, a 100.64/10 address on an interface still
 * proves the tunnel is up, so the report can stay useful.
 */

import { isTailscaleAddress, type Address } from "./net.ts";

export type TailscaleBackend = "running" | "starting" | "stopped" | "needs-login" | "unknown";

export interface TailscaleStatus {
  backend: TailscaleBackend;
  /** The raw `BackendState`, for the report. */
  raw: string;
  /** IPv4 addresses in Tailscale's CGNAT range. */
  ips: string[];
  /** MagicDNS name without the trailing dot, when the tailnet has MagicDNS on. */
  dnsName: string | null;
  hostName: string | null;
  /** Where to finish a login, when one is needed. */
  authUrl: string | null;
  /** Where this status came from: the CLI, or an address seen on an interface. */
  source: "cli" | "interface";
}

interface RawStatus {
  BackendState?: unknown;
  AuthURL?: unknown;
  TailscaleIPs?: unknown;
  Self?: { TailscaleIPs?: unknown; DNSName?: unknown; HostName?: unknown };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asBackend(raw: string): TailscaleBackend {
  switch (raw) {
    case "Running":
      return "running";
    case "Starting":
      return "starting";
    case "Stopped":
    case "NoState":
      return "stopped";
    case "NeedsLogin":
    case "NeedsMachineAuth":
      return "needs-login";
    default:
      return "unknown";
  }
}

/** Parse `tailscale status --json`; null when the output is not that JSON. */
export function parseTailscaleStatus(stdout: string): TailscaleStatus | null {
  let parsed: RawStatus;
  try {
    parsed = JSON.parse(stdout) as RawStatus;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  const raw = typeof parsed.BackendState === "string" ? parsed.BackendState : "";
  if (!raw) return null;

  const ips = [...stringArray(parsed.Self?.TailscaleIPs), ...stringArray(parsed.TailscaleIPs)]
    .filter((ip) => isTailscaleAddress(ip));
  const dnsName = typeof parsed.Self?.DNSName === "string" ? parsed.Self.DNSName.replace(/\.$/, "") : "";
  const authUrl = typeof parsed.AuthURL === "string" && parsed.AuthURL ? parsed.AuthURL : "";
  const hostName = typeof parsed.Self?.HostName === "string" ? parsed.Self.HostName : "";

  return {
    backend: asBackend(raw),
    raw,
    ips: [...new Set(ips)],
    dnsName: dnsName || null,
    hostName: hostName || null,
    authUrl: authUrl || null,
    source: "cli",
  };
}

/**
 * What an interface scan can say on its own. A Tailscale address means the
 * tunnel is carrying traffic, so it counts as running even without the CLI.
 */
export function statusFromAddresses(addresses: readonly Address[]): TailscaleStatus | null {
  const ips = addresses.filter((address) => address.kind === "tailscale").map((address) => address.address);
  if (ips.length === 0) return null;
  return {
    backend: "running",
    raw: "Running (from interface)",
    ips: [...new Set(ips)],
    dnsName: null,
    hostName: null,
    authUrl: null,
    source: "interface",
  };
}

export function isUsable(status: TailscaleStatus | null): status is TailscaleStatus {
  return status !== null && status.backend === "running" && status.ips.length > 0;
}

/**
 * States that are worth waiting through rather than reporting as a failure.
 *
 * On Windows the backend commits `tailscale up` only after the tray/IPN process
 * is also up, so `Starting` can last tens of seconds and `Stopped` right after
 * `up` is not the end of the story. `needs-login` is the one state no amount of
 * waiting fixes, and `running` is the goal.
 */
export function isTransient(status: TailscaleStatus | null): boolean {
  if (!status) return true;
  return status.backend === "starting" || status.backend === "stopped" || status.backend === "unknown";
}

/** One line for the report, and one sentence of advice when it is not usable. */
export function describeStatus(status: TailscaleStatus | null): { line: string; advice: string | null } {
  if (!status) {
    return {
      line: "Tailscale：未检测到（没有 CLI，也没有 100.x 地址）",
      advice: "确认这台机器装了 Tailscale 并登录，或在设置它的路径：TAILSCALE_PATH=<路径>",
    };
  }
  switch (status.backend) {
    case "running":
      return { line: `Tailscale：已连接 · ${status.ips.join(", ") || "(无地址)"}`, advice: null };
    case "starting":
      return { line: "Tailscale：正在启动", advice: "稍等 2 秒再试一次" };
    case "stopped":
      return { line: `Tailscale：未连接（${status.raw}）`, advice: "可以现在启动：tailscale up（通常无需重新登录）" };
    case "needs-login":
      return {
        line: `Tailscale：需要登录（${status.raw}）`,
        advice: status.authUrl
          ? `打开这个地址完成登录：${status.authUrl}`
          : "打开 Tailscale 客户端登录一次",
      };
    default:
      return { line: `Tailscale：未知状态（${status.raw}）`, advice: "试一次 tailscale up，或用客户端看状态" };
  }
}
