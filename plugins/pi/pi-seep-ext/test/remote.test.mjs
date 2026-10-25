import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { classifyAddress, isPrivateLanAddress, isTailscaleAddress, listReachableAddresses } from "../lib/net.ts";
import { detectPort, canConnect } from "../lib/probe.ts";
import { qrAvailable, qrMatrix, renderHalfBlock, renderQrBlock } from "../lib/qr.ts";
import { allowedHostsEnv, generatePassword, mergeAllowedHosts, normalizeRemoteSettings, readRemoteSettings, writeRemoteSettings } from "../lib/remote-settings.ts";
import { tailscaleCandidates } from "../lib/tailscale-binary.ts";
import { describeStatus, isTransient, isUsable, parseTailscaleStatus, statusFromAddresses } from "../lib/tailscale.ts";

// ---------- addresses ----------

test("Tailscale's CGNAT range is 100.64/10 and nothing outside it", () => {
  for (const ip of ["100.64.0.1", "100.127.255.254", "100.100.100.100"]) {
    assert.equal(isTailscaleAddress(ip), true, ip);
  }
  for (const ip of ["100.63.255.255", "100.128.0.1", "10.0.0.1", "192.168.1.1"]) {
    assert.equal(isTailscaleAddress(ip), false, ip);
  }
});

test("private LAN ranges are recognised", () => {
  for (const ip of ["192.168.1.5", "10.2.3.4", "172.16.0.1", "172.31.255.254"]) {
    assert.equal(isPrivateLanAddress(ip), true, ip);
  }
  for (const ip of ["172.32.0.1", "8.8.8.8", "100.64.0.1"]) {
    assert.equal(isPrivateLanAddress(ip), false, ip);
  }
});

test("a virtual adapter is marked, because that address usually does not work from a phone", () => {
  assert.equal(classifyAddress("vEthernet (WSL)", "172.20.0.1"), "virtual");
  assert.equal(classifyAddress("Wi-Fi", "192.168.1.5"), "lan");
  assert.equal(classifyAddress("Tailscale", "100.64.0.7"), "tailscale");
  // VirtualBox and docker-machine hand out private-looking ranges.
  assert.equal(classifyAddress("Ethernet 2", "192.168.56.1"), "virtual");
  assert.equal(classifyAddress("Ethernet 3", "192.168.99.100"), "virtual");
});

test("enumeration skips loopback, link-local and IPv6, and orders LAN before Tailscale", () => {
  const list = listReachableAddresses({
    "Loopback Pseudo-Interface 1": [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    "Wi-Fi": [{ address: "192.168.1.5", family: "IPv4" }, { address: "fe80::1", family: "IPv6" }],
    Tailscale: [{ address: "100.64.0.7", family: 4 }],
    "vEthernet (WSL)": [{ address: "172.20.0.1", family: "IPv4" }],
    Ethernet: [{ address: "169.254.10.10", family: "IPv4" }],
  });
  assert.deepEqual(list.map((entry) => entry.address), ["192.168.1.5", "100.64.0.7", "172.20.0.1"]);
  assert.deepEqual(list.map((entry) => entry.kind), ["lan", "tailscale", "virtual"]);
});

// ---------- tailscale status ----------

const running = JSON.stringify({
  BackendState: "Running",
  AuthURL: "",
  Self: {
    TailscaleIPs: ["100.64.0.7", "fd7a:115c:a1e0::1"],
    DNSName: "desktop-abc.tail1234.ts.net.",
    HostName: "DESKTOP-ABC",
  },
});

test("a running status keeps the IPv4 tailnet address and trims the MagicDNS dot", () => {
  const status = parseTailscaleStatus(running);
  assert.ok(status);
  assert.equal(status.backend, "running");
  assert.deepEqual(status.ips, ["100.64.0.7"]);
  assert.equal(status.dnsName, "desktop-abc.tail1234.ts.net");
  assert.equal(status.hostName, "DESKTOP-ABC");
  assert.equal(isUsable(status), true);
});

test("each backend state maps to the advice it needs", () => {
  assert.equal(parseTailscaleStatus(JSON.stringify({ BackendState: "Stopped" })).backend, "stopped");
  assert.equal(parseTailscaleStatus(JSON.stringify({ BackendState: "NoState" })).backend, "stopped");
  assert.equal(parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.example" })).backend, "needs-login");
  assert.equal(parseTailscaleStatus(JSON.stringify({ BackendState: "Starting" })).backend, "starting");
  assert.equal(parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsMachineAuth" })).backend, "needs-login");
  assert.equal(parseTailscaleStatus(JSON.stringify({ BackendState: "Something New" })).backend, "unknown");
});

test("garbage and non-status output are rejected instead of half-parsed", () => {
  assert.equal(parseTailscaleStatus(""), null);
  assert.equal(parseTailscaleStatus("not json"), null);
  assert.equal(parseTailscaleStatus("{}"), null);
  assert.equal(parseTailscaleStatus("[]"), null);
});

test("without a CLI, an interface address still proves the tunnel is up", () => {
  const status = statusFromAddresses([
    { name: "Wi-Fi", address: "192.168.1.5", kind: "lan" },
    { name: "Tailscale", address: "100.64.0.7", kind: "tailscale" },
  ]);
  assert.ok(status);
  assert.equal(status.backend, "running");
  assert.equal(status.source, "interface");
  assert.deepEqual(status.ips, ["100.64.0.7"]);
  assert.equal(statusFromAddresses([{ name: "Wi-Fi", address: "192.168.1.5", kind: "lan" }]), null);
});

test("the report says what to do next, not just what is wrong", () => {
  assert.equal(describeStatus(null).advice?.includes("TAILSCALE_PATH"), true);
  assert.match(describeStatus(parseTailscaleStatus(JSON.stringify({ BackendState: "Stopped" }))).advice ?? "", /tailscale up/);
  assert.match(
    describeStatus(parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.example" }))).advice ?? "",
    /https:\/\/login\.example/,
  );
  assert.equal(describeStatus(parseTailscaleStatus(running)).advice, null);
});

// ---------- tailscale binary discovery ----------

test("an explicit path wins, then PATH, then platform locations", () => {
  const candidates = tailscaleCandidates({
    env: { PI_TAILSCALE_PATH: "D:\\custom\\ts.exe", ProgramFiles: "C:\\Program Files" },
    platform: "win32",
    exists: (path) => path === "C:\\Program Files\\Tailscale\\tailscale.exe",
  });
  assert.equal(candidates[0].path, "D:\\custom\\ts.exe");
  assert.equal(candidates[0].source, "$PI_TAILSCALE_PATH");
  assert.equal(candidates[1].source, "PATH");
  assert.ok(candidates.some((candidate) => candidate.path === "C:\\Program Files\\Tailscale\\tailscale.exe"));
});

test("a machine with no Tailscale returns only the PATH attempt, never a hardcoded guess", () => {
  const candidates = tailscaleCandidates({ env: {}, platform: "win32", exists: () => false });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, "PATH");
});

test("macOS and Linux locations are probed only when they exist", () => {
  const mac = tailscaleCandidates({
    env: {},
    platform: "darwin",
    home: "/Users/me",
    exists: (path) => path === "/opt/homebrew/bin/tailscale",
  });
  assert.ok(mac.some((candidate) => candidate.path === "/opt/homebrew/bin/tailscale"));

  const linux = tailscaleCandidates({ env: {}, platform: "linux", exists: (path) => path === "/snap/bin/tailscale" });
  assert.ok(linux.some((candidate) => candidate.path === "/snap/bin/tailscale"));
  assert.equal(linux[0].path, "tailscale", "PATH stays first");
});

test("duplicate locations are collapsed, keeping the highest-priority source", () => {
  const candidates = tailscaleCandidates({
    env: { PI_TAILSCALE_PATH: "C:\\Program Files\\Tailscale\\tailscale.exe", ProgramFiles: "C:\\Program Files" },
    platform: "win32",
    exists: () => true,
  });
  assert.equal(candidates.filter((candidate) => candidate.path === "C:\\Program Files\\Tailscale\\tailscale.exe").length, 1);
});

// ---------- port / qr / settings ----------

test("the port comes from argv first, because that is how pi-web passes it", () => {
  assert.equal(detectPort(["node", "next", "start", "-p", "8123"], {}), 8123);
  assert.equal(detectPort(["node", "next", "--port=9000"], {}), 9000);
  assert.equal(detectPort(["node"], { PI_WEB_PORT: "7000" }), 7000);
  assert.equal(detectPort(["node"], { PORT: "6000" }), 6000);
  assert.equal(detectPort(["node"], {}), 30141);
  assert.equal(detectPort(["node", "-p", "abc"], {}), 30141, "a broken flag falls through");
});

test("a QR matrix renders as half blocks, one character per module", () => {
  // A synthetic checkerboard is enough to pin the geometry: real codes are tested
  // through renderQrBlock below.
  const size = 21;
  const matrix = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => (row + column) % 2 === 0),
  );
  const lines = renderHalfBlock(matrix, 2);
  assert.equal(lines.length, Math.ceil(size / 2) + 4, "two modules per row plus the quiet zone");
  assert.equal(lines[0].length, size + 4, "one character per module");
  for (const line of lines) assert.match(line, /^[ █▀▄]+$/);
});

test("the encoder is optional: its absence costs the code, not the extension", async () => {
  // The package is installed for development, so the code path that matters here
  // is the one that succeeds; the fallback is exercised by the caller's null check.
  assert.equal(await qrAvailable(), true);
  const block = await renderQrBlock("http://100.64.0.7:30141");
  assert.ok(block);
  assert.ok(block.startsWith("```text\n"));
  assert.ok(block.endsWith("\n```"));
  assert.equal(block.split("\n").length > 12, true);

  const matrix = qrMatrix(
    (typeNumber, level) => {
      assert.equal(typeNumber, 0, "size is chosen automatically");
      assert.equal(level, "M");
      return {
        addData() {},
        make() {},
        getModuleCount: () => 21,
        isDark: () => false,
      };
    },
    "anything",
  );
  assert.equal(matrix.length, 21);
});

test("a generated password avoids look-alike characters and is retypeable", () => {
  const password = generatePassword();
  assert.equal(password.length, 12);
  assert.match(password, /^[abcdefghjkmnpqrstuvwxyz23456789]+$/);
  assert.notEqual(generatePassword(), generatePassword());
});

test("remote settings round-trip, and an absent file means no password", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-seep-remote-"));
  assert.deepEqual(readRemoteSettings(dir), { password: null, lastMode: null, allowedHosts: [] });

  writeRemoteSettings({ password: "abc123" }, dir);
  assert.equal(readRemoteSettings(dir).password, "abc123");
  writeRemoteSettings({ lastMode: "tailscale" }, dir);
  const after = readRemoteSettings(dir);
  assert.equal(after.password, "abc123", "one setting must not clear another");
  assert.equal(after.lastMode, "tailscale");

  writeRemoteSettings({ password: null }, dir);
  assert.equal(readRemoteSettings(dir).password, null);
  assert.deepEqual(normalizeRemoteSettings({ password: "" }), { password: null, lastMode: null, allowedHosts: [] });
});

test("a refused connection is reported as unreachable instead of throwing", async () => {
  // Port 1 on loopback: nothing listens there.
  assert.equal(await canConnect("127.0.0.1", 1, 300), false);
});

test("starting and stopped are waited through, not reported as failure", () => {
  const state = (BackendState) => parseTailscaleStatus(JSON.stringify({ BackendState }));
  assert.equal(isTransient(state("Starting")), true, "a first connection takes time");
  assert.equal(isTransient(state("Stopped")), true, "right after `up` this is not the end");
  assert.equal(isTransient(state("NoState")), true);
  assert.equal(isTransient(state("Something New")), true, "unknown: keep looking");
  assert.equal(isTransient(null), true, "nothing read yet");
  assert.equal(isTransient(state("Running")), false);
  assert.equal(isTransient(state("NeedsLogin")), false, "waiting cannot fix a login");
});

test("tailnet hostnames are merged into the allow-list without duplicates", () => {
  assert.deepEqual(mergeAllowedHosts([], "desktop-ab.tail.ts.net"), ["desktop-ab.tail.ts.net"]);
  assert.deepEqual(mergeAllowedHosts(["a.ts.net"], "desktop-ab.tail.ts.net"), ["a.ts.net", "desktop-ab.tail.ts.net"]);
  assert.deepEqual(mergeAllowedHosts(["a.ts.net"], "a.ts.net"), ["a.ts.net"]);
  assert.equal(allowedHostsEnv([" a ", "b", "a", ""]), "a,b");
});

test("added hostnames survive a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-seep-hosts-"));
  writeRemoteSettings({ allowedHosts: ["desktop-ab.tail.ts.net"] }, dir);
  assert.deepEqual(readRemoteSettings(dir).allowedHosts, ["desktop-ab.tail.ts.net"]);
  writeRemoteSettings({ password: "x" }, dir);
  assert.deepEqual(readRemoteSettings(dir).allowedHosts, ["desktop-ab.tail.ts.net"], "one setting must not clear another");
  assert.deepEqual(normalizeRemoteSettings({ allowedHosts: ["a", "a", 42] }).allowedHosts, ["a"]);
});
