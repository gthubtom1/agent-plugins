import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Finding the Tailscale CLI on a machine we have never seen.
 *
 * The install location is not stable across machines, platforms or package
 * managers: `C:\Program Files\Tailscale`, a per-user install, scoop, chocolatey,
 * winget links, the Homebrew prefix, a snap, or the CLI inside the macOS app
 * bundle. So the resolver is a list, tried in order, and the caller runs each
 * candidate until one answers — a wrong guess costs one failed spawn, nothing
 * more.
 *
 * Nothing here is machine-specific: every path is derived from environment
 * variables or the platform, and the user can always win by setting
 * `TAILSCALE_PATH` / `PI_TAILSCALE_PATH` / `TAILSCALE_CLI`.
 */

export interface BinaryCandidate {
  /** Absolute path, or a bare command name to be looked up on PATH. */
  path: string;
  /** Where this candidate came from, for the report. */
  source: string;
}

export interface CandidateOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Injected for tests; defaults to fs.existsSync. */
  exists?: (path: string) => boolean;
  home?: string;
}

function windowsCandidates(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): BinaryCandidate[] {
  const roots = [
    env.ProgramW6432,
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.ProgramData,
    env.LOCALAPPDATA,
    env.APPDATA,
    env.USERPROFILE,
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData",
  ].filter((root): root is string => Boolean(root));

  const candidates: BinaryCandidate[] = [];
  for (const root of roots) {
    candidates.push({ path: join(root, "Tailscale", "tailscale.exe"), source: `install dir (${root})` });
  }
  // Package managers put a shim somewhere else.
  if (env.USERPROFILE) {
    candidates.push({ path: join(env.USERPROFILE, "scoop", "apps", "tailscale", "current", "tailscale.exe"), source: "scoop" });
  }
  if (env.LOCALAPPDATA) {
    candidates.push({ path: join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "tailscale.exe"), source: "winget link" });
  }
  if (env.ProgramData) {
    candidates.push({ path: join(env.ProgramData, "chocolatey", "bin", "tailscale.exe"), source: "chocolatey" });
  }
  return candidates.filter((candidate) => exists(candidate.path));
}

export function tailscaleCandidates(options: CandidateOptions = {}): BinaryCandidate[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? homedir();

  const candidates: BinaryCandidate[] = [];

  // 1. An explicit answer always wins.
  for (const name of ["PI_TAILSCALE_PATH", "TAILSCALE_PATH", "TAILSCALE_CLI"]) {
    const value = env[name]?.trim();
    if (value) candidates.push({ path: value, source: `$${name}` });
  }

  // 2. Whatever PATH resolves. No existence check: the spawn decides, and this
  //    also covers shims and symlinks that are not regular files.
  candidates.push({ path: platform === "win32" ? "tailscale.exe" : "tailscale", source: "PATH" });

  // 3. Platform install locations.
  if (platform === "win32") {
    candidates.push(...windowsCandidates(env, exists));
  } else if (platform === "darwin") {
    const additions = [
      { path: "/Applications/Tailscale.app/Contents/MacOS/Tailscale", source: "app bundle" },
      { path: join(home, "Applications/Tailscale.app/Contents/MacOS/Tailscale"), source: "app bundle (user)" },
      { path: "/opt/homebrew/bin/tailscale", source: "homebrew (arm64)" },
      { path: "/usr/local/bin/tailscale", source: "homebrew (intel)" },
      { path: "/usr/local/Tailscale.app/Contents/MacOS/Tailscale", source: "app bundle (/usr/local)" },
    ];
    candidates.push(...additions.filter((candidate) => exists(candidate.path)));
  } else {
    const additions = [
      { path: "/usr/bin/tailscale", source: "distro package" },
      { path: "/usr/local/bin/tailscale", source: "manual install" },
      { path: "/usr/sbin/tailscale", source: "distro package" },
      { path: "/sbin/tailscale", source: "distro package" },
      { path: "/snap/bin/tailscale", source: "snap" },
      { path: "/opt/bin/tailscale", source: "opt install" },
    ];
    candidates.push(...additions.filter((candidate) => exists(candidate.path)));
  }

  // De-duplicate, keeping the earliest (highest-priority) entry.
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = platform === "win32" ? candidate.path.toLowerCase() : candidate.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The GUI entry point, used only to tell a person where to finish a login. */
export function tailscaleGuiCandidates(options: CandidateOptions = {}): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? homedir();

  if (platform === "win32") {
    return [env.ProgramFiles, env.ProgramW6432, "C:\\Program Files"]
      .filter((root): root is string => Boolean(root))
      .map((root) => join(root, "Tailscale", "tailscale-ipn.exe"))
      .filter((path) => exists(path));
  }
  if (platform === "darwin") {
    return ["/Applications/Tailscale.app", join(home, "Applications/Tailscale.app")].filter((path) => exists(path));
  }
  return [];
}
