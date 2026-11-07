// Timeout classes. A single 120s default is wrong for reverse work: Ghidra,
// rizin -A, frida scripts, git clone and package installs legitimately exceed it,
// while `ls` should never run for two minutes.

const FAST = new Set([
  'ls', 'dir', 'pwd', 'cd', 'echo', 'cat', 'head', 'tail', 'wc', 'stat', 'file',
  'which', 'where', 'command', 'type', 'rg', 'grep', 'egrep', 'fgrep', 'sed',
  'awk', 'cut', 'sort', 'uniq', 'tr', 'jq', 'sha256sum', 'md5sum', 'sha1sum',
  'certutil', 'xxd', 'hexdump', 'od', 'strings', 'nm', 'readelf', 'chmod', 'mkdir',
  'touch', 'cp', 'mv', 'ln', 'env', 'export', 'test', 'true', 'false', 'timeout',
]);

const HEAVY = new Set([
  'jadx', 'jadx-gui', 'ghidra', 'analyzeheadless', 'rizin', 'radare2', 'r2',
  'objdump', 'binwalk', '7z', '7za', 'tar', 'unzip', 'zip', 'rar', 'unrar',
  'cargo', 'go', 'dotnet', 'mvn', 'gradle', 'gradlew', 'make', 'cmake', 'ninja',
  'npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'uv', 'poetry', 'conda',
  'git', 'adb', 'fastboot', 'apktool', 'apksigner', 'keytool', 'zipalign',
  'dex2jar', 'd8', 'java', 'python', 'python3', 'node', 'frida', 'frida-ps',
  'qemu', 'wine', 'ffmpeg', 'yara', 'clamscan', 'docker',
]);

/** Programs that are heavy only with specific arguments. */
const HEAVY_ARGS = [
  { program: 'objdump', pattern: /^(-D|--disassemble-all|-d)$/ },
  { program: 'rizin', pattern: /^(-A|--analyze|-AA)$/ },
  { program: 'radare2', pattern: /^(-A|--analyze|-AA)$/ },
  { program: 'r2', pattern: /^(-A|--analyze|-AA)$/ },
  { program: 'strings', pattern: /^(-a|--all)$/ },
];

export function classify(program, args = []) {
  if (HEAVY_ARGS.some((entry) => entry.program === program && args.some((a) => entry.pattern.test(a)))) {
    return 'heavy';
  }
  if (FAST.has(program)) return 'fast';
  if (HEAVY.has(program)) return 'heavy';
  // Unknown commands: assume they are cheap; an explicit timeout still applies.
  return 'default';
}

export function timeoutFor(program, args, options) {
  const klass = classify(program, args);
  const limits = options.timeout || {};
  const fast = Number(limits.fast ?? 60);
  const normal = Number(limits.default ?? 120);
  const heavy = Number(limits.heavy ?? 900);
  const ceiling = Number(limits.ceiling ?? 1800);
  const value = klass === 'fast' ? fast : klass === 'heavy' ? heavy : normal;
  return { klass, seconds: Math.min(value, ceiling) };
}

export function clampExplicit(explicit, options) {
  const ceiling = Number(options.timeout?.ceiling ?? 1800);
  const value = Number(explicit);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(value, ceiling);
}

export { FAST, HEAVY };
