import { Socket } from "node:net";

/**
 * "Can a phone actually reach this address?"
 *
 * Reading `PI_WEB_HOSTNAME` only says what was asked for; the socket is the
 * truth. A refused connection to the LAN address means the server is still bound
 * to loopback, which is the single most common reason a QR code does not work —
 * so the report says that instead of handing out a dead link.
 */
export function canConnect(host: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/** Which port the server is on: argv first (that is how pi-web passes it), then env. */
export function detectPort(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): number {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "-p" || arg === "--port") {
      const value = Number(argv[index + 1]);
      if (Number.isInteger(value) && value > 0) return value;
    }
    const inline = /^--port=(\d+)$/.exec(arg);
    if (inline) {
      const value = Number(inline[1]);
      if (Number.isInteger(value) && value > 0) return value;
    }
  }
  for (const candidate of [env.PI_WEB_PORT, env.PORT]) {
    const value = Number(candidate);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return 30141;
}
