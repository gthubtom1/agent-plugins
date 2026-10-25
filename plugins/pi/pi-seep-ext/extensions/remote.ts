import { networkInterfaces } from "node:os";
import { resolveAgentDir } from "../lib/agent-dir.ts";
import { listReachableAddresses, type Address, type NetworkInterfaces } from "../lib/net.ts";
import type { BaseContext, CommandContext, ExtensionApi } from "../lib/pi-api.ts";
import { canConnect, detectPort } from "../lib/probe.ts";
import { renderQrBlock } from "../lib/qr.ts";
import {
  allowedHostsEnv,
  generatePassword,
  mergeAllowedHosts,
  readRemoteSettings,
  writeRemoteSettings,
} from "../lib/remote-settings.ts";
import { tailscaleCandidates, tailscaleGuiCandidates } from "../lib/tailscale-binary.ts";
import { describeStatus, isTransient, isUsable, parseTailscaleStatus, statusFromAddresses, type TailscaleStatus } from "../lib/tailscale.ts";
import { spawn } from "node:child_process";
import { platform } from "node:os";

/**
 * `/remote`: get a phone onto this machine, with a QR code you can scan.
 *
 * The split of responsibility is the whole point:
 *
 * - what an extension *can* do is report and prepare — enumerate addresses,
 *   probe them, drive the Tailscale CLI, generate a password at runtime;
 * - what it *cannot* do is change where the server is already bound, so when the
 *   probe fails the report says "restart pi-web with PI_WEB_HOSTNAME=0.0.0.0"
 *   instead of handing out a link that will not open.
 *
 * Nothing is machine-specific. The Tailscale CLI is looked up through several
 * strategies because its install location differs per machine and per package
 * manager, and a failed guess costs one spawn rather than the feature.
 */

const MENU_LAN = "🏠 局域网（同一 Wi-Fi）";
const MENU_TAILSCALE = "🌍 Tailscale（随时随地）";
const MENU_PASSWORD = "🔑 登录密码（显示 / 生成 / 关闭）";
const MENU_CHECK = "🩺 自检（绑定 / 端口 / 可达性）";

const MESSAGE_TYPE = "remote";

/**
 * QR codes are drawn only where the renderer keeps line-height at 1: the TUI, or
 * when someone explicitly asks for one. In a web code block the rows drift apart
 * and the code stops scanning, so pi-web gets the URL instead.
 */
let forceQr = false;

function qrWanted(ctx: { mode: string }): boolean {
  return forceQr || ctx.mode === "tui";
}

export default function remoteExtension(pi: ExtensionApi): void {
  const agentDir = resolveAgentDir();

  // A password generated at runtime lives in this process's environment, which
  // pi-web reads per request. Writing it back on load is what keeps a phone
  // logged in after a restart.
  const stored = readRemoteSettings(agentDir);
  if (!process.env.PI_WEB_PASSWORD && stored.password) {
    process.env.PI_WEB_PASSWORD = stored.password;
  }
  if (stored.allowedHosts.length > 0) {
    const merged = mergeAllowedHosts(
      (process.env.PI_WEB_ALLOWED_HOSTS ?? "").split(","),
      stored.allowedHosts[0],
    );
    let hosts = merged;
    for (const host of stored.allowedHosts.slice(1)) hosts = mergeAllowedHosts(hosts, host);
    process.env.PI_WEB_ALLOWED_HOSTS = allowedHostsEnv(hosts);
  }

  let cliPath: string | null | undefined; // undefined: not tried yet, null: none worked

  const port = (): number => detectPort();
  const addresses = (): Address[] => listReachableAddresses(networkInterfaces() as NetworkInterfaces);
  const password = (): string | null => process.env.PI_WEB_PASSWORD || null;
  const allowedHosts = (): string[] =>
    [process.env.PI_WEB_HOSTNAME, ...(process.env.PI_WEB_ALLOWED_HOSTS?.split(",") ?? [])]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value) && value !== "0.0.0.0");

  async function post(content: string): Promise<void> {
    await pi.sendMessage({ customType: MESSAGE_TYPE, content, display: true });
  }

  /** Try every candidate until one answers; remember the winner for this session. */
  async function resolveTailscale(): Promise<{ path: string; status: TailscaleStatus } | null> {
    if (cliPath === null) return null;
    for (const candidate of tailscaleCandidates()) {
      if (cliPath && candidate.path !== cliPath) continue;
      try {
        const result = await pi.exec(candidate.path, ["status", "--json"], { timeout: 8000 });
        if (result.killed) continue;
        const status = parseTailscaleStatus(result.stdout);
        if (status) {
          cliPath = candidate.path;
          return { path: candidate.path, status };
        }
      } catch {
        // Not this one: wrong path, no execute permission, or a shim that is not
        // the CLI. The next candidate costs one spawn.
      }
    }
    if (!cliPath) cliPath = null;
    return null;
  }

  /**
   * Wait for the backend to commit. One second per attempt and a generous budget,
   * because a first connection over DERP regularly takes ten to thirty seconds,
   * and on Windows the tray process has to join before the state settles.
   */
  async function pollUntilSettled(path: string, attempts = 45): Promise<TailscaleStatus | null> {
    let last: TailscaleStatus | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const result = await pi.exec(path, ["status", "--json"], { timeout: 8000 });
        const status = parseTailscaleStatus(result.stdout);
        if (status) {
          last = status;
          if (!isTransient(status)) return status;
        }
      } catch { /* keep polling */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return last;
  }

  /** Whether the tray app is up; on Windows the backend waits for it. */
  async function trayRunning(): Promise<boolean> {
    if (platform() !== "win32") return true;
    try {
      const result = await pi.exec("tasklist", ["/FI", "IMAGENAME eq tailscale-ipn.exe", "/NH"], { timeout: 8000 });
      return /tailscale-ipn\.exe/i.test(result.stdout);
    } catch {
      return false;
    }
  }

  /**
   * Start the tray app detached. `tailscale up` alone can stay in `Starting`
   * until the IPN process exists — the service is up, the icon is not, and the
   * backend never commits. That is what "Tailscale 启动不了" looked like.
   */
  function launchTray(path: string): void {
    const child = spawn(path, [], { detached: true, stdio: "ignore" });
    child.unref();
  }

  function passwordAdvice(): string {
    return password() ? "密码已开启（打开后输一次）" : "⚠ 无密码：同一网络内任何设备都能进（`/remote password` 可加）";
  }

  /**
   * Three lines at most: what to do, the address on its own line so the markdown
   * renderer turns it into a clickable link, and one line of caveat. A URL inside
   * backticks stays plain text, so no address here is wrapped in a code span.
   */
  async function connectionBlock(heading: string, url: string, extra: string[], ctx: CommandContext): Promise<string> {
    const lines = [heading, url, ...extra.filter(Boolean)];
    // The text QR needs line-height 1 to join its rows; a web code block has ~1.5
    // and tears the pattern apart, so it is only drawn where it can be scanned.
    // The encoder is optional: when it is missing the address alone still works.
    if (qrWanted(ctx)) {
      const qr = await renderQrBlock(url);
      if (qr) lines.push("", qr);
      else lines.push("", "（二维码需要可选依赖 qrcode-generator，未安装也能用上面的网址）");
    }
    return lines.join("\n");
  }

  async function showLan(ctx: CommandContext): Promise<void> {
    const currentPort = port();
    const all = addresses();
    const candidates = all.filter((address) => address.kind !== "tailscale");
    const probed = await Promise.all(
      candidates.map(async (address) => ({ ...address, reachable: await canConnect(address.address, currentPort) })),
    );
    const reachable = probed.filter((entry) => entry.reachable);
    const preferred = reachable.find((entry) => entry.kind === "lan") ?? reachable[0];

    if (!preferred) {
      const bind = process.env.PI_WEB_HOSTNAME?.trim() || "127.0.0.1";
      await post([
        "手机连不上：服务还只绑在本机",
        `当前绑定 ${bind} · 端口 ${currentPort}`,
        "一次修好（之后照常 `pi-web`）",
        "`setx PI_WEB_HOSTNAME 0.0.0.0`",
        "然后重开终端、重启 pi-web",
      ].join("\n"));
      return;
    }

    const url = `http://${preferred.address}:${currentPort}`;
    // Only real LAN addresses make a good fallback: a reachable virtual adapter
    // (WSL, VirtualBox host-only) answers on this machine but not from a phone.
    const others = reachable.filter((entry) => entry.address !== preferred.address && entry.kind === "lan");
    writeRemoteSettings({ lastMode: "lan" }, agentDir);
    const extra: string[] = [];
    if (preferred.kind !== "lan") extra.push("⚠ 这是虚拟网卡，手机可能连不上");
    if (others.length > 0) extra.push(`备用地址 ${others[0].address}:${currentPort}`);
    extra.push(passwordAdvice());
    await post(await connectionBlock("手机打开（同一 Wi-Fi）", url, extra, ctx));
  }

  async function showTailscale(ctx: CommandContext): Promise<void> {
    const currentPort = port();
    const found = await resolveTailscale();
    let status = found?.status ?? statusFromAddresses(addresses());

    if (!status) {
      const gui = tailscaleGuiCandidates();
      await post([
        "## 没检测到 Tailscale",
        "",
        "试过：环境变量 `TAILSCALE_PATH` / `PATH` / 各平台常见安装位置，都没找到能用的 CLI；网卡上也没有 100.x 地址。",
        "",
        "## 三种可能",
        "",
        "1. **没装**：装一次 Tailscale 客户端，电脑和手机登录同一个账号即可。",
        "2. **装了但 CLI 不在常见位置**：把路径告诉插件，然后重启 pi-web：",
        "",
        "```powershell",
        "setx TAILSCALE_PATH \"<你机器上的 tailscale 可执行文件完整路径>\"",
        "```",
        "",
        gui.length > 0 ? `3. **只装了图形界面**：打开 \`${gui[0]}\` 登录一次。` : "3. **只装了图形界面**：打开 Tailscale 客户端登录一次。",
      ].join("\n"));
      return;
    }

    if (isTransient(status)) {
      const label = found ? describeStatus(status).line : "Tailscale 未连接";
      const gui = tailscaleGuiCandidates();
      const needsTray = platform() === "win32" && gui.length > 0 && !(await trayRunning());
      const start = await ctx.ui.confirm(
        "启动 Tailscale？",
        [
          label,
          "会执行 tailscale up（已登录过的账号通常几秒内连上）。",
          needsTray ? "Windows 上还会打开托盘程序 tailscale-ipn.exe —— 后端要等它才会完成连接。" : "",
        ].filter(Boolean).join("\n"),
      );
      if (!start) return;
      if (!found) {
        await post([
          "没有可用的 Tailscale CLI，无法自动启动。",
          gui.length > 0 ? `打开托盘程序完成连接：\`${gui[0]}\`` : "请打开 Tailscale 客户端手动连接。",
        ].join("\n"));
        return;
      }

      if (needsTray) {
        try {
          launchTray(gui[0]);
          ctx.ui.notify("已打开 Tailscale 托盘程序", "info");
          await new Promise((resolve) => setTimeout(resolve, 1500));
        } catch {
          // Keep going: on some machines `tailscale up` is enough without the tray.
        }
      }

      let upError: string | null = null;
      try {
        const result = await pi.exec(found.path, ["up"], { timeout: 45000 });
        if (result.code !== 0 && result.stderr.trim()) upError = result.stderr.trim();
      } catch (error) {
        upError = error instanceof Error ? error.message : String(error);
      }

      ctx.ui.notify("正在等待 Tailscale 连接…（首次连接可能要 10–30 秒）", "info");
      status = await pollUntilSettled(found.path);
      if (!status || isTransient(status)) {
        const detail = describeStatus(status);
        await post([
          "## 还没连上",
          "",
          `- ${detail.line}`,
          detail.advice ? `- ${detail.advice}` : "",
          upError ? `- \`tailscale up\` 输出：\`${upError.split("\n")[0]}\`` : "",
          needsTray ? `- 托盘程序：\`${gui[0]}\`（已尝试打开）` : "",
          "",
          "再试一次 `/remote tailscale`；仍不行就用托盘图标登录一次。",
        ].filter(Boolean).join("\n"));
        return;
      }
    }

    if (status.backend === "needs-login") {
      const { line, advice } = describeStatus(status);
      await post([
        "## Tailscale 需要登录",
        "",
        `- ${line}`,
        advice ? `- ${advice}` : "",
        "",
        found ? `CLI：\`${found.path}\`` : "",
      ].filter(Boolean).join("\n"));
      return;
    }

    if (!isUsable(status)) {
      const { line, advice } = describeStatus(status);
      await post(["## Tailscale 还不可用", "", `- ${line}`, advice ? `- ${advice}` : ""].filter(Boolean).join("\n"));
      return;
    }

    const ip = status.ips[0];
    const url = `http://${ip}:${currentPort}`;
    const reachable = await canConnect(ip, currentPort);
    const extra: string[] = [];
    if (!reachable) extra.push("⚠ 探测不通：服务大概还绑在 127.0.0.1");
    if (status.dnsName) {
      const allowed = allowedHosts();
      const domainUrl = `http://${status.dnsName}:${currentPort}`;
      if (allowed.includes(status.dnsName)) {
        extra.unshift(`域名 ${domainUrl}`);
      } else {
        const enable = await ctx.ui.confirm(
          "也启用域名访问？",
          `${status.dnsName}\n\n用域名打开会被 pi-web 挡成 403（它只信任被告知的域名）。现在加上立即生效，不用重启。`,
        );
        if (enable) {
          const next = mergeAllowedHosts(allowed, status.dnsName);
          process.env.PI_WEB_ALLOWED_HOSTS = allowedHostsEnv(next); // read per request
          const saved = writeRemoteSettings({ allowedHosts: next }, agentDir).saved;
          extra.unshift(`域名 ${domainUrl}`);
          if (!saved) extra.push("⚠ 域名写入配置失败，重启后要再启用一次");
        }
      }
    }
    if (status.source === "interface") {
      extra.push("（没找到 Tailscale CLI，状态是从网卡读的）");
    }
    extra.push(passwordAdvice());
    writeRemoteSettings({ lastMode: "tailscale" }, agentDir);
    await post(await connectionBlock("手机打开（手机需开着 Tailscale）", url, extra, ctx));
  }

  async function managePassword(ctx: CommandContext): Promise<void> {
    const current = password();
    const options = [
      current ? "显示当前密码" : "（当前没有密码）",
      "生成一个新密码（立即生效）",
      "关闭密码（同网络内谁都能进）",
    ];
    const choice = await ctx.ui.select("登录密码（pi-web 的 PI_WEB_PASSWORD）", options);
    if (choice === undefined) return;

    if (choice === options[0]) {
      if (!current) {
        ctx.ui.notify("当前没有密码。选「生成一个新密码」即可加上。", "info");
      } else {
        await post(`## 当前登录密码\n\n\`\`\`text\n${current}\n\`\`\`\n\n手机打开页面后输一次，之后 30 天免输。`);
      }
      return;
    }

    if (choice === options[1]) {
      const next = generatePassword();
      process.env.PI_WEB_PASSWORD = next; // proxy reads env per request: live immediately
      const saved = writeRemoteSettings({ password: next }, agentDir).saved;
      ctx.ui.notify(
        saved ? "新密码已生成并立即生效（重启 pi-web 后依然有效）" : "新密码已生成并立即生效（写入配置失败：重启后需要重新生成）",
        saved ? "info" : "warning",
      );
      await post(`## 新密码（已生效）\n\n\`\`\`text\n${next}\n\`\`\`\n\n手机下次打开页面时输入它。`);
      return;
    }

    const ok = await ctx.ui.confirm(
      "关闭密码？",
      "关闭后，能和这台机器连通的人打开浏览器就能操作你的 agent（读文件、跑命令）。局域网里就是「同一个 Wi-Fi 的所有人」。",
    );
    if (!ok) return;
    delete process.env.PI_WEB_PASSWORD;
    writeRemoteSettings({ password: null }, agentDir);
    ctx.ui.notify("密码已关闭（立即生效）", "info");
  }

  async function selfCheck(): Promise<void> {
    const currentPort = port();
    const bind = process.env.PI_WEB_HOSTNAME?.trim() || "127.0.0.1";
    const all = addresses();
    const probed = await Promise.all(
      all.map(async (address) => ({ ...address, reachable: await canConnect(address.address, currentPort) })),
    );
    const found = await resolveTailscale();
    const status = found?.status ?? statusFromAddresses(all);
    const ts = describeStatus(status);
    const lanReachable = probed.filter((entry) => entry.reachable && entry.kind === "lan");
    const allowed = allowedHosts();

    const addressLine = probed.length
      ? probed
          .map((entry) => `${entry.address} ${entry.reachable ? "✅" : "❌"}${entry.kind === "lan" ? "" : `(${entry.kind})`}`)
          .join(" · ")
      : "（没找到可用地址）";

    await post([
      "自检",
      `绑定 ${bind} · 端口 ${currentPort} · 密码 ${password() ? "已开启" : "未设置"} · 白名单 ${allowed.length ? allowed.join(",") : "无"}`,
      `${ts.line}${found ? ` · CLI ${found.path}` : ""}`,
      `地址 ${addressLine}`,
      "",
      lanReachable.length > 0
        ? `手机可用 http://${lanReachable[0].address}:${currentPort}`
        : "局域网地址都不通：服务可能还绑在 127.0.0.1（`setx PI_WEB_HOSTNAME 0.0.0.0` 后重启 pi-web）",
      ts.advice ? `提示 ${ts.advice}` : "",
    ].filter(Boolean).join("\n"));
  }

  pi.registerCommand("remote", {
    description: "让手机连上：局域网 / Tailscale 二维码、登录密码、自检",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "lan" || arg === "局域网") return showLan(ctx);
      if (arg === "ts" || arg === "tailscale" || arg === "公网") return showTailscale(ctx);
      if (arg === "password" || arg === "pw" || arg === "密码") return managePassword(ctx);
      if (arg === "check" || arg === "自检") return selfCheck();
      if (arg === "qr") {
        forceQr = !forceQr;
        ctx.ui.notify(forceQr ? "二维码已开启（网页里行高会撕开图案，可能扫不了；终端里正常）" : "二维码已关闭，只显示网址", "info");
        return;
      }
      if (arg !== "" && arg !== "menu") {
        ctx.ui.notify("用法：/remote [lan | tailscale | password | check]", "info");
        return;
      }

      const last = readRemoteSettings(agentDir).lastMode;
      const preferred = last === "tailscale" ? MENU_TAILSCALE : last === "lan" ? MENU_LAN : null;
      const menu = [MENU_LAN, MENU_TAILSCALE, MENU_PASSWORD, MENU_CHECK];
      const options = preferred ? [preferred, ...menu.filter((label) => label !== preferred)] : menu;
      const choice = await ctx.ui.select("让手机连上", options);
      if (choice === undefined) return;
      if (choice === MENU_LAN) return showLan(ctx);
      if (choice === MENU_TAILSCALE) return showTailscale(ctx);
      if (choice === MENU_PASSWORD) return managePassword(ctx);
      return selfCheck();
    },
  });

  // Re-apply the stored password when a session starts, so a restart keeps
  // phones logged in without touching the system environment.
  pi.on("session_start", (_event, _ctx: BaseContext) => {
    const settings = readRemoteSettings(agentDir);
    if (!process.env.PI_WEB_PASSWORD && settings.password) {
      process.env.PI_WEB_PASSWORD = settings.password;
    }
  });
}
