// cmd-guard 冒烟测试：用假 pi API 驱动插件，走一遍所有判定分支。
// 跑法：node smoke-cmd-guard.mjs            （测同目录的 cmd-guard.ts）
//      PI_HOME=<pi 家目录> node smoke-cmd-guard.mjs   （换机时指定）
import assert from "node:assert";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
const handlers = new Map();
const commands = new Map();
const pi = {
  on: (ev, fn) => {
    if (!handlers.has(ev)) handlers.set(ev, []);
    handlers.get(ev).push(fn);
  },
  registerCommand: (name, opts) => commands.set(name, opts),
};

// 跑完所有 handler，把返回值收进数组（handler 可以是同步也可以返回 Promise）
const fire = (ev, e, ctx) => {
  const out = [];
  for (const fn of handlers.get(ev) ?? []) out.push(fn(e, ctx));
  return out;
};

// ── 用 pi 自己的加载器（jiti）跑插件，和 pi 真正加载扩展的路径一致 ──
// 直接 esbuild 转 ESM 会报 __dirname 未定义；jiti 走 CJS，__dirname 才有。
// jiti 从 pi 的 node_modules 里解析 —— 版本号会变，所以现找不写死。
const PI_HOME = process.env.PI_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent");
const RELEASES = join(PI_HOME, "install", "releases");

function findJiti() {
  if (!existsSync(RELEASES)) return null;
  for (const rel of readdirSync(RELEASES).sort().reverse()) {
    const anchor = join(
      RELEASES, rel, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js",
    );
    if (!existsSync(anchor)) continue;
    try {
      return createRequire(anchor)("jiti");
    } catch { /* 这个 release 里没有就试下一个 */ }
  }
  return null;
}

const jitiPkg = findJiti();
if (!jitiPkg) {
  console.error(`找不到 pi 的 jiti（找过 ${RELEASES}）。用 PI_HOME=<pi 家目录> 指到正确的位置。`);
  process.exit(2);
}
const jiti = jitiPkg.createJiti(import.meta.url, { interopDefault: true });
const TS_PATH = process.env.CG_TS || new URL("./cmd-guard.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const cmdGuard = (await jiti.import(TS_PATH)).default;

const log = [];
const open = []; // 已发起但还没结算的调用，drain() 用

function makeCtx() {
  return {
    ui: {
      notify: (m, t) => log.push({ kind: "notify", type: t, text: String(m) }),
      setStatus: (k, v) => log.push({ kind: "status", key: k, text: v }),
    },
    hasUI: true,
    mode: "tui",
  };
}

cmdGuard(pi);
const ctx = makeCtx();
fire("session_start", { type: "session_start", reason: "startup" }, ctx);

const call = (command, toolName = "bash", timeout) => {
  const event = { toolCallId: "t" + Math.random().toString(36).slice(2), toolName, input: { command } };
  if (timeout !== undefined) event.input.timeout = timeout;
  const out = fire("tool_call", event, ctx).find((r) => r && r.block);
  if (!out) open.push(event); // 被拦的不进 running；没被拦的用例里不结算，会污染后续断言
  return { event, out };
};

// 把还挂在 running 里的调用全部结算掉，让后续用例从干净状态开始
const drain = () => {
  while (open.length) {
    fire("tool_result", { toolCallId: open.pop().toolCallId, isError: false, content: [] }, ctx);
  }
};

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log("  OK  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + " → " + e.message); fail++; }
}

console.log("\n── GUI 拦截 ──");

check("die.exe 被拦（内置表）", () => {
  const { out } = call("D:\\Tools\\DIE\\die.exe sample.exe");
  assert.ok(out && out.block === true, "没返回 block");
  assert.match(out.reason, /diec/);
});

// 注意：Wireshark 也在内置表里，所以「被拦」证明不了派生。
// 真正的证据是提示语末尾的「（来源 xxx）」标记 —— 内置表的项没有这个标记。
check("提示语带「来源」标记 = 确实从 TOOL-CHAIN.md 派生来的", () => {
  commands.get("guard").handler("rules", ctx);
  const t = log.find((l) => l.kind === "notify")?.text || "";
  const derived = t.split("\n").filter((l) => /来源\s+\S+\.md/.test(l));
  assert.ok(derived.length > 0, "一条派生项都没有，文档驱动没生效；rules=\n" + t);
});

check("Wireshark.exe 被拦且给出 tshark 替代", () => {
  const { out } = call("Wireshark.exe -r x.pcap");
  assert.ok(out && out.block === true, "没被拦");
  assert.match(out.reason, /tshark/);
});

check("idat.exe 明确不拦（headless）", () => {
  const { out } = call("idat.exe -A -Sscript.py sample.exe");
  assert.ok(!out, "idat 被拦了");
});

check("Test-Path 探测 die.exe 不误拦", () => {
  const { out } = call("Test-Path D:\\Tools\\DIE\\die.exe");
  assert.ok(!out, "探测命令被误拦了 —— 这是最不能错的一条");
});

check("echo 里的工具名不误拦", () => {
  const { out } = call("echo \"run die.exe first\"");
  assert.ok(!out, "字符串里的名字被当成命令了");
});

check("链式命令的后半段仍会被拦", () => {
  const { out } = call("echo hi && die.exe sample.exe");
  assert.ok(out && out.block === true, "链后半段漏拦");
});

check("cmd-guard-skip 整条放行", () => {
  const { out } = call("cmd-guard-skip die.exe sample.exe");
  assert.ok(!out, "豁免没生效");
});

console.log("\n── timeout 注入 ──");

check("探查类补 30s", () => {
  const { event } = call("Get-ChildItem C:\\relab2");
  assert.strictEqual(event.input.timeout, 30);
});

check("普通命令补 120s", () => {
  const { event } = call("some-tool --analyze foo.bin");
  assert.strictEqual(event.input.timeout, 120);
});

check("构建类补 600s", () => {
  const { event } = call("npm install left-pad");
  assert.strictEqual(event.input.timeout, 600);
});

check("解释器补 600s", () => {
  const { event } = call("python scripts/run.py");
  assert.strictEqual(event.input.timeout, 600);
});

check("递归大目录抬到 180s", () => {
  const { event } = call("Get-ChildItem -Recurse C:\\Users");
  assert.strictEqual(event.input.timeout, 180);
});

check("盘符根扫描抬到 180s", () => {
  const { event } = call("rg foo C:\\");
  assert.strictEqual(event.input.timeout, 180);
});

check("模型自带 timeout 不被覆盖", () => {
  const { event } = call("some-tool --x", "bash", 45);
  assert.strictEqual(event.input.timeout, 45);
});

check("自带 timeout 大于扫描下限时不被压低", () => {
  const { event } = call("Get-ChildItem -Recurse C:\\Users", "bash", 300);
  assert.strictEqual(event.input.timeout, 300);
});

console.log("\n── ssh 有界化 ──");

check("ssh 补 ConnectTimeout", () => {
  const { event } = call("ssh root@10.0.0.5 uptime");
  assert.match(event.input.command, /ConnectTimeout=15/);
  assert.match(event.input.command, /< \/dev\/null/);
});

check("已有 ConnectTimeout 不重复注入", () => {
  const { event } = call("ssh -o ConnectTimeout=5 root@10.0.0.5 uptime");
  assert.strictEqual((event.input.command.match(/ConnectTimeout/g) || []).length, 1);
});

check("echo 里的 ssh 不被改写", () => {
  const { event } = call("echo \"ssh is old\" > note.txt");
  assert.ok(!event.input.command.includes("ConnectTimeout"));
});

check("powershell 侧不补 </dev/null", () => {
  const { event } = call("ssh root@10.0.0.5 uptime", "powershell");
  assert.match(event.input.command, /ConnectTimeout=15/);
  assert.ok(!event.input.command.includes("/dev/null"));
});

console.log("\n── 结果回灌 ──");

check("长链命令的提示回灌进 content", () => {
  const { event } = call("a && b && c && d && e && f && g && h && i && j");
  const res = fire("tool_result", {
    toolCallId: event.toolCallId, isError: false,
    content: [{ type: "text", text: "ok" }], details: undefined,
  }, ctx).find(Boolean);
  assert.ok(res && res.content && res.content.length === 2, "提示没回灌");
  assert.match(res.content[1].text, /串了 10 段/);
});

check("正常命令不产生多余提示", () => {
  const { event } = call("echo hi");
  const res = fire("tool_result", {
    toolCallId: event.toolCallId, isError: false,
    content: [{ type: "text", text: "ok" }],
  }, ctx).find(Boolean);
  assert.ok(!res || !res.content || res.content.length === 1, "平白多了一段");
});

console.log("\n── 命令与 UI ──");

// 这几个 handler 的函数体里没有 await，副作用是同步发生的。
// 所以这里故意不 await：check() 是同步的，await 会让断言跑到后面的用例之后，顺序就乱了。
check("/stall 已注册且能跑", () => {
  assert.ok(commands.has("stall"));
  log.length = 0;
  commands.get("stall").handler("", ctx);
  assert.ok(log.some((l) => l.kind === "notify" && /cmd-guard 状态/.test(l.text)));
});

check("/guard rules 列出派生名目", () => {
  assert.ok(commands.has("guard"));
  log.length = 0;
  commands.get("guard").handler("rules", ctx);
  const t = log.find((l) => l.kind === "notify")?.text || "";
  assert.match(t, /GUI 名单/);
  assert.match(t, /tshark/, "派生项没列出来");
});

check("/guard off 后不再拦截，on 后恢复", () => {
  commands.get("guard").handler("off", ctx);
  const off = call("die.exe x.exe");
  assert.ok(!off.out, "off 之后还在拦");
  commands.get("guard").handler("on", ctx);
  const on = call("die.exe x.exe");
  assert.ok(on.out && on.out.block === true, "on 之后没恢复拦截");
});

check("底栏状态确实被写过（不是空转）", () => {
  drain(); // 前面的用例留下的未结算调用先清掉
  log.length = 0;
  const { event } = call("Get-ChildItem C:\\relab2");
  // 命令一开跑就该有底栏状态；命令结束后状态行要收成汇总
  assert.ok(log.some((l) => l.kind === "status" && /bash/.test(String(l.text))), "起跑时没写状态；log=" + JSON.stringify(log));
  log.length = 0;
  fire("tool_execution_update", { toolCallId: event.toolCallId }, ctx);
  fire("tool_result", { toolCallId: event.toolCallId, isError: false, content: [] }, ctx);
  assert.ok(log.some((l) => l.kind === "status" && /guard/.test(String(l.text))), "结束后没收状态");
});

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
