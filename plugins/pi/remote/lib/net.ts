/**
 * Where this machine can be reached from a phone.
 *
 * Two families matter, and they mean different things:
 *
 * - a private LAN address (`192.168.x`, `10.x`, `172.16–31.x`) is reachable by
 *   anyone on the same Wi-Fi;
 * - a Tailscale address (`100.64.0.0/10`, the CGNAT range Tailscale hands out)
 *   is reachable by devices signed into the same tailnet, from any network.
 *
 * Everything else is offered too, but marked, because the address that actually
 * works is often a virtual adapter nobody expects (WSL, Hyper-V, VirtualBox).
 */

export type AddressKind = "lan" | "tailscale" | "virtual" | "other";

export interface Address {
  /** Interface name, for the report. */
  name: string;
  address: string;
  kind: AddressKind;
}

export interface NetworkInterfaces {
  [name: string]: Array<{ address: string; family: string | number; internal?: boolean } | undefined> | undefined;
}

const VIRTUAL_NAME = /vethernet|vmware|virtualbox|vbox|hyper-v|docker|wsl|loopback|tailscale|zerotier|hamachi/i;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function inRange(ip: string, network: string, prefix: number): boolean {
  const address = ipv4ToInt(ip);
  const base = ipv4ToInt(network);
  if (address === null || base === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (base & mask);
}

/** Tailscale's CGNAT range: 100.64.0.0/10. */
export function isTailscaleAddress(ip: string): boolean {
  return inRange(ip, "100.64.0.0", 10);
}

/** Addresses a home or office router hands out. */
export function isPrivateLanAddress(ip: string): boolean {
  return inRange(ip, "192.168.0.0", 16)
    || inRange(ip, "10.0.0.0", 8)
    || inRange(ip, "172.16.0.0", 12);
}

/**
 * Ranges that virtual adapters hand out and a phone can never reach: VirtualBox
 * host-only (192.168.56.0/24) and docker-machine (192.168.99.0/24). They look like
 * private LAN addresses, so the name heuristic alone misses them.
 */
function isVirtualRange(ip: string): boolean {
  return inRange(ip, "192.168.56.0", 24) || inRange(ip, "192.168.99.0", 24);
}

/** Loopback and link-local never help a phone. */
function isUseless(ip: string): boolean {
  return inRange(ip, "127.0.0.0", 8) || inRange(ip, "169.254.0.0", 16);
}

export function classifyAddress(name: string, ip: string): AddressKind {
  if (isTailscaleAddress(ip)) return "tailscale";
  if (VIRTUAL_NAME.test(name) || isVirtualRange(ip)) return "virtual";
  return isPrivateLanAddress(ip) ? "lan" : "other";
}

/**
 * Every IPv4 address this machine could be reached on, most useful first:
 * LAN, then Tailscale, then virtual adapters, then anything else. Within a kind
 * the order is stable so a repeated call shows the same address.
 */
export function listReachableAddresses(interfaces: NetworkInterfaces): Address[] {
  const found: Address[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry || entry.internal) continue;
      const family = typeof entry.family === "string" ? entry.family : entry.family === 4 ? "IPv4" : "IPv6";
      if (family !== "IPv4") continue;
      if (isUseless(entry.address)) continue;
      found.push({ name, address: entry.address, kind: classifyAddress(name, entry.address) });
    }
  }
  const order: AddressKind[] = ["lan", "tailscale", "virtual", "other"];
  return found.sort((a, b) => {
    const rank = order.indexOf(a.kind) - order.indexOf(b.kind);
    if (rank !== 0) return rank;
    return a.name.localeCompare(b.name) || a.address.localeCompare(b.address);
  });
}
