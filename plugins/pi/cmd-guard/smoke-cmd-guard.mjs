// Run: node --test smoke-cmd-guard.mjs (or node smoke-cmd-guard.mjs).
// Requires Node with native TypeScript stripping; no loader or dependencies.
// CG_TS optionally selects another cmd-guard.ts, with its sibling lib/ and rules.
// Every command below is DATA: only mocked Pi handlers run, never a shell/process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = process.env.CG_TS
  ? resolve(process.env.CG_TS)
  : fileURLToPath(new URL("./cmd-guard.ts", import.meta.url));
const skillEnv = ["CMD_GUARD_SKILL_ROOT", "RELAB_SKILL_ROOT", "REVERSE_SKILL_ROOT"];
const networkWrite = "netsh winhttp set proxy localhost:8080";

async function fixture(t, overrides = {}, { document = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cmd-guard-test-"));
  const savedEnv = new Map([...skillEnv, "CMD_GUARD"].map(key => [key, process.env[key]]));
  const handlers = new Map();
  const commands = new Map();
  const log = [];
  const startup = [];
  let sequence = 0;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      notify: (text, type) => log.push({ kind: "notify", text: String(text), type }),
      setStatus: (key, value) => log.push({ kind: "status", key, value }),
    },
  };
  const pi = {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand: (name, options) => commands.set(name, options),
  };
  async function fire(name, event = {}) {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  }
  t.after(async () => {
    try {
      await fire("agent_end");
      await fire("session_shutdown");
    } finally {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  copyFileSync(source, join(root, "cmd-guard.ts"));
  cpSync(join(dirname(source), "lib"), join(root, "lib"), { recursive: true });
  // Keep the shipped rules as the baseline, but isolate document discovery from
  // the checkout and the user's environment. Each fixture imports exactly once;
  // a unique filesystem path also isolates module-level counters and timers.
  const sourceRules = join(dirname(source), "cmd-guard.rules.json");
  const rulesPath = join(root, "cmd-guard.rules.json");
  if (existsSync(sourceRules)) copyFileSync(sourceRules, rulesPath);
  const rules = {
    ...(existsSync(rulesPath) ? JSON.parse(readFileSync(rulesPath, "utf8")) : {}),
    skillRoot: root,
    toolChainPaths: [],
    ...overrides,
  };
  delete rules.indexPaths;
  const writeRules = changes => {
    Object.assign(rules, changes);
    writeFileSync(rulesPath, JSON.stringify(rules, null, 2));
  };
  writeRules({});
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  if (document) writeFileSync(join(root, "TOOL-CHAIN.md"), "`fixture-gui.exe` -> `fixture-cli`\n");
  for (const key of skillEnv) process.env[key] = root;
  delete process.env.CMD_GUARD;

  const { default: install } = await import(pathToFileURL(join(root, "cmd-guard.ts")).href);
  const originalError = console.error;
  try {
    console.error = (...args) => startup.push(args.map(String).join(" "));
    install(pi);
  } finally {
    console.error = originalError;
  }
  await fire("session_start", { type: "session_start", reason: "startup" });

  async function call(command, { shell = "bash", timeout } = {}) {
    const input = { command };
    if (timeout !== undefined) input.timeout = timeout;
    const event = { toolCallId: `fixture-call-${++sequence}`, toolName: shell, input };
    const results = await fire("tool_call", event);
    return { event, block: results.find(result => result?.block === true) };
  }
  async function finish(call, result = {}) {
    const event = {
      toolCallId: call.event.toolCallId,
      toolName: call.event.toolName,
      isError: false,
      content: [{ type: "text", text: "ok" }],
      ...result,
    };
    const outputs = (await fire("tool_result", event)).filter(value => value !== undefined);
    assert.ok(outputs.length <= 1, "unexpected competing result handlers");
    return { event, override: outputs[0], effective: { ...event, ...outputs[0] } };
  }
  async function allowed(command, options = {}) {
    const invocation = await call(command, options);
    assert.equal(invocation.block, undefined, `${command}: ${invocation.block?.reason}`);
    await finish(invocation);
    return invocation.event.input;
  }
  async function blocked(command, options = {}) {
    const invocation = await call(command, options);
    assert.equal(invocation.block?.block, true, `${command}: expected a block`);
    assert.ok(invocation.block.reason?.trim(), "blocked calls must explain the reason");
    // A blocked tool never runs and therefore receives no fabricated tool_result.
    return invocation.block;
  }
  async function command(name, arg = "") {
    assert.ok(commands.has(name), `/${name} was not registered`);
    const before = log.length;
    await commands.get(name).handler(arg, ctx);
    return log.slice(before).findLast(entry => entry.kind === "notify")?.text ?? "";
  }
  return { root, rules, writeRules, handlers, log, startup, fire, call, finish, allowed, blocked, command };
}

async function cases(t, rows, run) {
  for (const row of rows) await t.test(typeof row === "string" ? row : row.name ?? row.command, () => run(row));
}

function unchanged(input, command) {
  assert.equal(input.command, command, "command bytes must be preserved");
  assert.ok(Number.isFinite(input.timeout) && input.timeout > 0, "timeout fallback must remain active");
}

await test("default GUI policy permits normal GUI work and literal examples", async t => {
  const f = await fixture(t);
  await cases(t, [
    "ida.exe sample.exe", "ida64.exe sample.exe", "D:\\Tools\\DIE\\die.exe sample.exe",
    "Wireshark.exe -r capture.pcap", "echo ready && die.exe sample.exe",
    "idat.exe -A -Sscript.py sample.exe", "Test-Path D:\\Tools\\DIE\\die.exe",
    'echo "run die.exe first; Wireshark.exe capture.pcap"',
  ], async command => unchanged(await f.allowed(command), command));
  await t.test("documentation-derived rules are visible", async () => {
    const report = await f.command("guard", "rules");
    assert.match(report, /fixture-gui\.exe.*fixture-cli.*来源 TOOL-CHAIN\.md/);
  });
  await t.test("skip escape preserves even an actual network write", async () => {
    const command = `${networkWrite} # cmd-guard-skip`;
    assert.deepEqual(await f.allowed(command), { command });
  });
});

await test("strict GUI policy checks literal invocations, including later commands", async t => {
  const f = await fixture(t, { blockGui: true });
  await cases(t, [
    { command: "ida.exe sample.exe" }, { command: "die.exe sample.exe" },
    { command: "Wireshark.exe -r capture.pcap" },
    { command: "echo ready && die.exe sample.exe" },
    { command: "Write-Output ready; ida64.exe sample.exe", shell: "powershell" },
    { command: '"C:/Program Files/DIE/die.exe" sample.exe' },
    { command: '& "C:\\Program Files\\DIE\\die.exe" sample.exe', shell: "powershell" },
    { command: "fixture-gui.exe sample.exe" },
    { command: String.raw`d\ie.exe sample.exe` },
    { command: "di'e'.exe sample.exe" },
    { command: "d`ie.exe sample.exe", shell: "powershell" },
  ], ({ command, shell }) => f.blocked(command, { shell }));
  await cases(t, [
    { command: 'echo "die.exe sample.exe | ida.exe example"' },
    { command: "Write-Output 'Wireshark.exe -r sample.pcap'", shell: "powershell" },
    { command: 'rg "die.exe|Wireshark.exe" notes.md' },
    { command: "die.exe sample.exe --help" }, { command: "ida.exe sample.exe --version" },
    { command: "Wireshark.exe capture.pcap --help" },
    { command: "die.exe --version sample.exe" },
    { command: "ida.exe sample.exe /?", shell: "powershell" },
    { command: "procmon.exe /Terminate", shell: "powershell" },
    { command: "procmon64.exe /Quiet /Terminate", shell: "powershell" },
    { command: "procmon.exe /WaitForIdle", shell: "powershell" },
    { command: "idat64.exe -A sample.exe" },
  ], async ({ command, shell }) => unchanged(await f.allowed(command, { shell }), command));
});

await test("built-in network rules block real writes directly and later in simple chains", async t => {
  const f = await fixture(t);
  const writes = [
    "New-NetIPAddress -InterfaceIndex 7 -IPAddress 192.0.2.8 -PrefixLength 32",
    "Remove-NetIPAddress -IPAddress 192.0.2.8",
    "Set-NetIPAddress -IPAddress 192.0.2.8 -PrefixLength 24",
    "Set-NetIPInterface -InterfaceIndex 7 -Dhcp Disabled",
    "Disable-NetAdapter -Name Ethernet -Confirm:0",
    "Restart-NetAdapter -Name Ethernet",
    "Set-NetTCPSetting -SettingName Internet -AutoTuningLevelLocal Disabled",
    networkWrite, "netsh winhttp import proxy source=ie",
    "netsh interface ipv4 set dnsservers name=Ethernet static 192.0.2.53",
    "netsh int ip add address Ethernet 192.0.2.8 255.255.255.0",
    "Set-DnsClientServerAddress -InterfaceIndex 7 -ServerAddresses 192.0.2.53",
    "route add 192.0.2.0 mask 255.255.255.0 192.0.2.1",
    "route -p delete 192.0.2.0", "New-NetRoute -DestinationPrefix 192.0.2.0/24 -InterfaceIndex 7",
    "netsh winsock reset", "netsh advfirewall set allprofiles state off",
    "netsh advfirewall set privateprofile state off",
  ];
  await cases(t, writes, async command => {
    await f.blocked(command, { shell: "powershell" });
    await f.blocked(`Write-Output ready; ${command}`, { shell: "powershell" });
  });
  await t.test("Bash literal chain separators also expose later writes", async () => {
    for (const separator of [" && ", " || ", " | ", "\n"]) {
      await f.blocked(`echo ready${separator}${networkWrite}`);
    }
  });
});

await test("network names in data and legitimate enabling or read-only operations pass", async t => {
  const f = await fixture(t);
  await cases(t, [
    { command: `python -c 'print("netsh winhttp set proxy localhost:8080; Disable-NetAdapter")'` },
    { command: `Write-Output 'Disable-NetAdapter; netsh winhttp set proxy localhost:8080'`, shell: "powershell" },
    { command: `echo 'netsh winhttp set proxy localhost:8080 | Disable-NetAdapter'` },
    { command: `rg 'Set-NetIPInterface|netsh winhttp set proxy|Disable-NetAdapter' notes.md` },
    { command: `grep 'New-NetIPAddress' notes.md` },
    { command: "Enable-NetAdapter -Name Ethernet", shell: "powershell" },
    { command: "netsh advfirewall set allprofiles state on", shell: "powershell" },
    { command: "netsh advfirewall set privateprofile state on" },
    { command: "netsh winhttp show proxy" },
    { command: "Get-NetIPAddress", shell: "powershell" },
    { command: "ipconfig /all" },
    { command: "Disable-NetAdapter -Name Ethernet --help", shell: "powershell" },
  ], async ({ command, shell }) => unchanged(await f.allowed(command, { shell }), command));
});

await test("custom deny rules append, warnings preserve results, and built-ins remain active", async t => {
  const f = await fixture(t, { denyRules: [
    { id: "fixture-warning", re: "^fixture-audit(?: |$)", label: "fixture warning", severity: "warn", hint: "Review the fixture audit." },
    { id: "fixture-block", re: "^fixture-write(?: |$)", label: "fixture write", severity: "block", hint: "Use the fixture reader." },
  ] });
  await t.test("warning adds a note without blocking or losing structured fields", async () => {
    const call = await f.call("fixture-audit report.bin");
    assert.equal(call.block, undefined);
    const details = { exitCode: 0, nested: { keep: true } };
    const structuredContent = { records: [1, 2], need_from_user: false };
    const content = [{ type: "text", text: "audit complete" }, { type: "image", data: "AA==", mimeType: "image/png" }];
    const result = await f.finish(call, { details, structuredContent, content });
    assert.deepEqual(result.effective.content.slice(0, content.length), content);
    assert.match(result.effective.content.at(-1).text, /fixture warning/);
    assert.equal(result.effective.details, details);
    assert.equal(result.effective.structuredContent, structuredContent);
    assert.equal(content.length, 2, "original result content was mutated");
    assert.match(await f.command("stall"), /拦下 0 次/);
  });
  await t.test("custom block rule is enforced", () => f.blocked("fixture-write report.bin"));
  await t.test("a custom rules array does not replace built-in writes", () => f.blocked(networkWrite));
});

await test("enforce=false never counts permitted calls as blocked", async t => {
  const f = await fixture(t, { enforce: false, blockGui: true });
  await cases(t, [
    networkWrite, "Disable-NetAdapter -Name Ethernet", "die.exe sample.exe", "find / -type f", "vim report.txt",
  ], async command => {
    await f.allowed(command);
    const report = await f.command("stall");
    assert.match(report, /拦下 0 次/, command);
    assert.doesNotMatch(report, /── 被拦下 ──/, command);
  });
});

await test("disableDeny removes only the chosen rule and guard off/on controls real writes", async t => {
  const f = await fixture(t, { disableDeny: ["net-winhttp-write"] });
  await t.test("disabled built-in write is permitted", () => f.allowed(networkWrite));
  await t.test("other built-ins still block", () => f.blocked("Disable-NetAdapter -Name Ethernet"));
  await t.test("off skips mutation and blocking; on restores enforcement", async () => {
    await f.command("guard", "off");
    const command = "Disable-NetAdapter -Name Ethernet";
    assert.deepEqual(await f.allowed(command), { command });
    await f.command("guard", "on");
    await f.blocked(command);
  });
});

await test("root scans distinguish shallow enumeration from actual recursion", async t => {
  const f = await fixture(t);
  await cases(t, [
    { command: "dir C:\\", shell: "powershell" },
    { command: "Get-ChildItem C:\\", shell: "powershell" },
    { command: "gci C:\\", shell: "powershell" }, { command: "ls /" },
    { command: "find / -maxdepth 0 -type f" }, { command: "find / -maxdepth 1 -type f" },
    { command: "Get-ChildItem C:\\ -Recurse -Depth 0", shell: "powershell" },
    { command: "Get-ChildItem C:\\ -Depth 0", shell: "powershell" },
    { command: "Get-ChildItem -Depth 1 C:\\", shell: "powershell" },
    { command: "gci C:\\ -Depth:0", shell: "powershell" },
    { command: "gci -Depth:1 C:\\", shell: "powershell" },
    { command: 'Get-ChildItem C:\\Tools -Recurse -Filter "/"', shell: "powershell" },
    { command: "rg needle / -d 1" }, { command: "rg needle / -d1" },
    { command: `echo 'find / -maxdepth 8; dir /s C:\\'` },
    { command: `Write-Output 'Get-ChildItem -Recurse C:\\'`, shell: "powershell" },
    { command: `rg 'find /|dir /s C:\\' notes.md` },
  ], async ({ command, shell }) => unchanged(await f.allowed(command, { shell }), command));
  await cases(t, [
    { command: "find / -type f" }, { command: "find / -maxdepth 8 -type d" },
    { command: "dir /s C:\\", shell: "powershell" },
    { command: "Get-ChildItem -Recurse C:\\", shell: "powershell" },
    { command: "gci C:\\ -Depth 2", shell: "powershell" },
    { command: "rg needle /" }, { command: "grep -r needle /" },
    { command: "rg --regexp=needle /" }, { command: "rg --file=patterns.txt /" },
    { command: "rg needle / -d2" }, { command: "rg needle / -d 2" },
    { command: "echo ready && find / -type f" },
  ], async ({ command, shell }) => {
    const block = await f.blocked(command, { shell });
    assert.match(block.reason, /盘根递归/);
  });
});

await test("unsupported shell syntax deliberately gets timeout fallback without command rewriting", async t => {
  const f = await fixture(t, { blockGui: true });
  // Deliberate scope: this guard is not a shell interpreter or a security boundary.
  // Unknown syntax causes the ENTIRE input to bypass content checks/SSH rewriting,
  // even when its script text contains a known write or GUI executable.
  await cases(t, [
    { command: `echo $(${networkWrite})` },
    { command: "echo `netsh winhttp set proxy localhost:8080`" },
    { command: "find / -maxdepth 8 -type f 2>/dev/null" },
    { command: `if true; then ${networkWrite}; fi` },
    { command: 'for file in a; do die.exe "$file"; done' },
    { command: `cat <<'END'\n${networkWrite}\ndie.exe sample.exe\nEND` },
    { command: `${networkWrite} > network.log` },
    { command: `echo ready > output.log; ${networkWrite}` },
    { command: "ssh lab uptime 2>errors.log" },
    { command: "Write-Output $(Disable-NetAdapter -Name Ethernet)", shell: "powershell" },
    { command: "& { Disable-NetAdapter -Name Ethernet }", shell: "powershell" },
    { command: '@"\nDisable-NetAdapter -Name Ethernet\n"@', shell: "powershell" },
  ], async ({ command, shell }) => {
    const input = await f.allowed(command, { shell });
    unchanged(input, command);
  });
  await cases(t, [
    `bash -c '${networkWrite}'`,
    `python -c 'print("die.exe; ${networkWrite}")'`,
  ], async command => {
    const input = await f.allowed(command);
    unchanged(input, command);
    assert.equal(input.timeout, 600, "literal interpreter invocation still gets its normal budget");
  });
});

await test("timeout budgets respect explicit seconds and choose the heaviest simple invocation", async t => {
  const f = await fixture(t);
  await cases(t, [
    { command: "Get-ChildItem C:\\work", shell: "powershell", expected: 30 },
    { command: "echo ready", expected: 30 },
    { command: "some-tool --analyze file.bin", expected: 120 },
    { command: "python scripts/analyze.py", expected: 600 },
    { command: "npm install fixture-package", expected: 600 },
    { command: "Get-ChildItem -Recurse C:\\Users", shell: "powershell", expected: 180 },
    { command: "rg needle ./fixtures/", expected: 180 },
    { command: "rg needle single-file.txt", expected: 30 },
    { command: "rg / single-file.txt", expected: 30 },
    { command: "rg --files", expected: 180 },
    { command: "rg needle", expected: 180 },
    { command: "find ./fixtures -type f", expected: 180 },
    { command: "echo ready && python scripts/analyze.py", expected: 600 },
    { command: "Get-ChildItem C:\\work; python scripts/analyze.py", shell: "powershell", expected: 600 },
    { command: "sudo -n python scripts/analyze.py; echo ready", expected: 600 },
    { command: "rg --unknown-option needle /", expected: 600 },
    { command: "rg --max-depth=wat needle /", expected: 600 },
  ], async ({ command, shell, expected }) => {
    assert.equal((await f.allowed(command, { shell })).timeout, expected);
  });
  await t.test("explicit 5 seconds survives even recursive scans and interpreters", async () => {
    for (const shell of ["bash", "powershell"]) {
      for (const command of ["echo ready", "python scripts/analyze.py", "Get-ChildItem -Recurse C:\\Users", "rg needle ./fixtures/"]) {
        assert.equal((await f.allowed(command, { shell, timeout: 5 })).timeout, 5, command);
      }
    }
  });
  await t.test("both shells cap seconds at 1800 without guessing milliseconds", async () => {
    for (const shell of ["bash", "powershell"]) {
      for (const timeout of [1800, 1801, 60_000]) {
        for (const command of ["python scripts/analyze.py", "Get-ChildItem -Recurse C:\\Users"]) {
          assert.equal((await f.allowed(command, { shell, timeout })).timeout, 1800);
        }
      }
    }
  });
  await t.test("NaN, negative and other invalid budgets fall back by command kind", async () => {
    for (const timeout of [NaN, -5, 0, Infinity, -Infinity, "5", null]) {
      for (const [command, expected] of [["echo ready", 30], ["some-tool file.bin", 120], ["python scan.py", 600], ["rg needle ./fixtures/", 180]]) {
        assert.equal((await f.allowed(command, { timeout })).timeout, expected, `${command}, timeout=${timeout}`);
      }
    }
  });
});

await test("SSH hardening adds each missing local option independently and preserves all caller bytes", async t => {
  const f = await fixture(t);
  const all = "-o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3";
  await cases(t, [
    { command: "ssh analyst@lab uptime", expected: `ssh ${all} analyst@lab uptime` },
    { command: "ssh.exe analyst@lab uptime", expected: `ssh.exe ${all} analyst@lab uptime` },
    { command: String.raw`s\sh analyst@lab uptime`, expected: String.raw`s\sh ${all} analyst@lab uptime` },
    { command: "s's'h analyst@lab uptime", expected: `s's'h ${all} analyst@lab uptime` },
    { command: "s`sh analyst@lab uptime", shell: "powershell", expected: "s`sh " + all + " analyst@lab uptime" },
    { command: "  ssh\tanalyst@lab uptime  ", expected: `  ssh ${all}\tanalyst@lab uptime  ` },
    { command: '"C:/Program Files/OpenSSH/ssh.exe" analyst@lab uptime', expected: `"C:/Program Files/OpenSSH/ssh.exe" ${all} analyst@lab uptime` },
    { command: '& "C:\\Program Files\\OpenSSH\\ssh.exe" analyst@lab uptime', shell: "powershell", expected: `& "C:\\Program Files\\OpenSSH\\ssh.exe" ${all} analyst@lab uptime` },
    { command: '"C:/Program Files/OpenSSH/ssh.exe" -o ConnectTimeout=7 analyst@lab uptime', expected: '"C:/Program Files/OpenSSH/ssh.exe" -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=7 analyst@lab uptime' },
    { command: '& "C:\\Program Files\\OpenSSH\\ssh.exe" -o ServerAliveInterval=9 analyst@lab uptime', shell: "powershell", expected: '& "C:\\Program Files\\OpenSSH\\ssh.exe" -o ConnectTimeout=15 -o ServerAliveCountMax=3 -o ServerAliveInterval=9 analyst@lab uptime' },
    { command: "ssh analyst@lab uptime", shell: "powershell", expected: `ssh ${all} analyst@lab uptime` },
    { command: "ssh -o ConnectTimeout=7 analyst@lab uptime", expected: "ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=7 analyst@lab uptime" },
    { command: "ssh -o ServerAliveInterval=9 analyst@lab uptime", expected: "ssh -o ConnectTimeout=15 -o ServerAliveCountMax=3 -o ServerAliveInterval=9 analyst@lab uptime" },
    { command: "ssh -o ServerAliveCountMax=8 analyst@lab uptime", expected: "ssh -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=8 analyst@lab uptime" },
    { command: "ssh.exe -oConnectTimeout=7 -o ServerAliveInterval=9 analyst@lab uptime", expected: "ssh.exe -o ServerAliveCountMax=3 -oConnectTimeout=7 -o ServerAliveInterval=9 analyst@lab uptime" },
    { command: 'ssh -o "ConnectTimeout 7" analyst@lab uptime', expected: 'ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o "ConnectTimeout 7" analyst@lab uptime' },
    { command: "scp file.bin analyst@lab:/tmp/file.bin", expected: `scp ${all} file.bin analyst@lab:/tmp/file.bin` },
    { command: "scp.exe -o ConnectTimeout=7 file.bin analyst@lab:/tmp/file.bin", expected: "scp.exe -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=7 file.bin analyst@lab:/tmp/file.bin" },
    { command: '"C:/Program Files/OpenSSH/sftp.exe" analyst@lab', expected: `"C:/Program Files/OpenSSH/sftp.exe" ${all} analyst@lab` },
    { command: "sftp analyst@lab", expected: `sftp ${all} analyst@lab` },
    { command: `ssh analyst@lab 'echo -o ConnectTimeout=91 -o ServerAliveInterval=92'`, expected: `ssh ${all} analyst@lab 'echo -o ConnectTimeout=91 -o ServerAliveInterval=92'` },
    { command: "ssh analyst@lab printf -o ConnectTimeout=91", expected: `ssh ${all} analyst@lab printf -o ConnectTimeout=91` },
  ], async ({ command, shell, expected }) => {
    const input = await f.allowed(command, { shell });
    assert.equal(input.command, expected);
    assert.doesNotMatch(input.command, /\/dev\/null/);
  });
  await t.test("fully configured caller options are untouched", async () => {
    const command = "ssh -o ConnectTimeout=7 -o ServerAliveInterval=9 -o ServerAliveCountMax=8 analyst@lab uptime";
    unchanged(await f.allowed(command), command);
  });
});

await test("transport rewriting requires ONE literal direct standalone call", async t => {
  const f = await fixture(t);
  await cases(t, [
    { command: "ssh lab uptime | cat" }, { command: "echo ready && ssh lab uptime" },
    { command: "ssh lab uptime; ssh other uptime" },
    { command: "ssh -o ConnectTimeout=5 lab uptime; ssh other uptime" },
    { command: "ssh lab uptime\nssh other uptime" },
    { command: "ssh lab uptime | Write-Output ready", shell: "powershell" },
    { command: "Write-Output ready; ssh lab uptime", shell: "powershell" },
    { command: "ssh lab uptime > output.log", shell: "powershell" },
    { command: "ssh lab uptime > output.log" }, { command: "ssh lab uptime < input.txt" },
    { command: "ssh lab uptime;" }, { command: "ssh lab uptime &" },
    { command: "ssh lab uptime # retain comment" },
    { command: "ssh lab <<'END'\necho ready\nEND" },
    { command: `echo 'ssh lab uptime'` },
    { command: 'echo "example; ssh lab uptime"' },
    { command: "printf payload | ssh lab cat" },
    { command: "ssh lab cat; cat local.txt" },
    { command: "ssh -F ./ssh.conf lab uptime" },
    { command: "ssh -F./ssh.conf lab uptime" },
    { command: "scp -F ./ssh.conf file lab:/tmp/file" },
    { command: "ssh --help" },
    { command: `Write-Output 'ssh lab uptime'`, shell: "powershell" },
    { command: '"C:\\Program Files\\OpenSSH\\ssh.exe"', shell: "powershell" },
    { command: 'ssh "$HOST" uptime' },
    { command: "bash -c 'ssh lab uptime'" }, { command: "sudo ssh lab uptime" },
  ], async ({ command, shell }) => unchanged(await f.allowed(command, { shell }), command));
  await t.test("rsync has its own timeout and receives no SSH options", async () => {
    const input = await f.allowed("rsync src/ analyst@lab:dest/");
    assert.equal(input.command, "rsync --timeout=15 src/ analyst@lab:dest/");
    assert.doesNotMatch(input.command, /ConnectTimeout|ServerAlive|-o /);
    const command = "rsync --timeout=42 src/ analyst@lab:dest/";
    unchanged(await f.allowed(command), command);
  });
});

await test("malformed shell syntax and incomplete transport headers keep timeout fallback", async t => {
  const f = await fixture(t, { blockGui: true });
  await cases(t, [
    { command: "ssh analyst@lab uptime &&" },
    { command: "echo ready || | die.exe sample.exe" },
    { command: `echo ready; ; ${networkWrite}` },
    { command: `&& ${networkWrite}` },
    { command: "'unterminated die.exe sample.exe" },
    { command: '& & "C:\\Program Files\\OpenSSH\\ssh.exe" analyst@lab', shell: "powershell" },
    { command: "ssh -o" }, { command: "ssh -i" },
    { command: 'ssh -o "" analyst@lab uptime' },
    { command: "ssh --unknown-option=fixture analyst@lab uptime" },
    { command: "scp -P" }, { command: "sftp -b" },
  ], async ({ command, shell }) => unchanged(await f.allowed(command, { shell }), command));
});

await test("results never acquire long-chain warnings, user instructions, or unrelated advice", async t => {
  const f = await fixture(t);
  await cases(t, [
    "echo a && echo b && echo c && echo d && echo e && echo f && echo g && echo h && echo i && echo j",
    "echo normal-output",
    "Start-Process -FilePath sample.exe",
    "vmrun -T ws list",
    "scp file.bin analyst@lab:/tmp/file.bin",
  ], async command => {
    const call = await f.call(command);
    assert.equal(call.block, undefined);
    const content = [{ type: "text", text: "normal output" }];
    const result = await f.finish(call, { content });
    assert.deepEqual(result.effective.content, content, "unsolicited advice was added");
  });
  for (const flag of [false, true]) {
    await t.test(`need_from_user=${flag} in plain text or structured data is preserved as output`, async () => {
      for (const structured of [false, true]) {
        const content = [{ type: "text", text: structured ? "tool payload" : `need_from_user=${flag}\n${JSON.stringify({ need_from_user: flag, message: "literal tool output" })}` }];
        const details = { exitCode: 0, need_from_user: flag, nested: { keep: [1, 2] } };
        const structuredContent = { need_from_user: flag, message: "literal tool output" };
        const call = await f.call("echo fixture");
        const result = await f.finish(call, { content, details, ...(structured ? { structuredContent } : {}) });
        assert.deepEqual(result.effective, result.event, "tool output was interpreted as policy or instructions");
        assert.equal(result.effective.content, content);
        assert.equal(result.effective.details, details);
        if (structured) assert.equal(result.effective.structuredContent, structuredContent);
      }
    });
  }
});

await test("guard reload exposes effective configuration and affects subsequent calls", async t => {
  const f = await fixture(t);
  assert.match(await f.command("guard"), /hardenSsh=true/);
  f.writeRules({ hardenSsh: false, blockGui: true, probeTimeout: 7 });
  const reloaded = await f.command("guard", "reload");
  assert.match(reloaded, /hardenSsh=false/);
  assert.match(reloaded, /blockGui=true/);
  assert.match(reloaded, /timeout 7\/120\/600s/);
  const command = "ssh analyst@lab uptime";
  unchanged(await f.allowed(command), command);
  await f.blocked("die.exe sample.exe");
  assert.equal((await f.allowed("echo ready")).timeout, 7);
  f.writeRules({ hardenSsh: true });
  assert.match(await f.command("guard"), /hardenSsh=true/, "plain /guard also reloads its visible configuration");
  assert.match((await f.allowed(command)).command, /ConnectTimeout=15/);
});

await test("missing tool-chain documentation produces no startup UI warning with blockGui=false", async t => {
  const f = await fixture(t, { blockGui: false }, { document: false });
  assert.deepEqual(f.log.filter(entry => entry.kind === "notify"), []);
  assert.match(await f.command("guard"), /未找到 TOOL-CHAIN\.md/, "fixture must actually exercise missing documentation");
  await f.allowed("die.exe sample.exe");
});

await test("interactive checks retain finite alternatives without interpreting quoted data", async t => {
  const f = await fixture(t);
  await cases(t, ["watch npm test", "vim report.txt", "top", "top -b", "fzf", "git rebase -i HEAD~2"], command => f.blocked(command));
  await cases(t, [
    "watch --version", "vim -es report.txt", "top -b -n 1", "top -bn1", "top -l 1",
    "fzf --filter fixture", "less app.log", "node --version", "git add -p",
    "GIT_SEQUENCE_EDITOR=true git rebase -i HEAD~2", "git -c sequence.editor=true rebase -i HEAD~2",
    'echo "text; watch npm test | vim report.txt"', "echo ready # watch npm test",
    "ls | fzf", "echo ready && vim report.txt",
  ], command => f.allowed(command));
});

await test("stall observes nonempty output, verdicts, cleanup, and an always-cleared footer", async t => {
  const f = await fixture(t);
  const realNow = Date.now;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const base = realNow();
  let elapsed = 0;
  const timers = new Set();
  Date.now = () => base + elapsed;
  globalThis.setInterval = callback => {
    const timer = { callback, unref() {} };
    timers.add(timer);
    return timer;
  };
  globalThis.clearInterval = timer => timers.delete(timer);
  try {
    const call = await f.call("npm run build", { timeout: 120 });
    assert.equal(call.block, undefined);
    assert.equal(timers.size, 1, "running calls should share a ticker");
    elapsed = 91_000;
    for (const partialResult of [undefined, { content: [] }, { content: [{ type: "text", text: "" }] }, { content: [{ type: "image", data: "AA==", mimeType: "image/png" }] }]) {
      await f.fire("tool_execution_update", { toolCallId: call.event.toolCallId, partialResult });
      assert.match(await f.command("stall"), /静默 1m31s.*长时间无输出/);
    }
    assert.match(await f.command("stall"), /命令：npm run build/);
    await f.fire("tool_execution_update", {
      toolCallId: call.event.toolCallId,
      partialResult: { content: [{ type: "text", text: "building" }] },
    });
    assert.match(await f.command("stall"), /静默 0s，超时预算 120s/);
    elapsed = 121_000;
    assert.match(await f.command("stall"), /已运行 2m01s，静默 30s.*已过超时预算/);
    for (const timer of timers) timer.callback();
    await f.finish(call, { isError: true, content: [{ type: "text", text: "building\nCommand timed out after 120 seconds" }] });
    assert.equal(timers.size, 0, "tool_result must stop the idle ticker");
    let report = await f.command("stall");
    assert.match(report, /当前无命令在执行/);
    assert.match(report, /超时\s+bash\s+npm run build/);

    const aborted = await f.call("python abort-fixture.py");
    await f.finish(aborted, { isError: true, content: [{ type: "text", text: "Command aborted" }] });
    assert.match(await f.command("stall"), /已中断\s+bash\s+python abort-fixture\.py/);
    const misleading = await f.call("echo quoted-status");
    await f.finish(misleading, { isError: true, content: [{ type: "text", text: 'example says "Command aborted"' }] });
    assert.match(await f.command("stall"), /失败\s+bash\s+echo quoted-status/);

    const first = await f.call("python first.py");
    const second = await f.call("python second.py");
    assert.equal(timers.size, 1);
    await f.fire("tool_execution_end", { toolCallId: first.event.toolCallId, toolName: "bash", isError: true });
    assert.equal(timers.size, 1, "another active call still needs the ticker");
    await f.fire("tool_execution_end", { toolCallId: second.event.toolCallId, toolName: "bash", isError: true });
    assert.equal(timers.size, 0);
    assert.match(await f.command("stall"), /当前无命令在执行/);

    await f.call("python agent-end.py");
    await f.fire("agent_end");
    assert.equal(timers.size, 0);
    assert.match(await f.command("stall"), /当前无命令在执行/);
    await f.call("python shutdown.py");
    await f.fire("session_shutdown");
    assert.equal(timers.size, 0, "shutdown must cancel the ticker even with an active call");
    const statuses = f.log.filter(entry => entry.kind === "status");
    assert.ok(statuses.length > 0, "footer cleanup was never requested");
    for (const status of statuses) {
      assert.equal(status.key, "command:/stall");
      assert.equal(status.value, undefined, "footer may only be cleared, never populated");
    }
  } finally {
    // Also clear running records before restoring real timer functions, even on
    // assertion failure. No fake clock or interval hook may escape this test.
    try {
      await f.fire("agent_end");
      await f.fire("session_shutdown");
    } finally {
      Date.now = realNow;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  }
});
