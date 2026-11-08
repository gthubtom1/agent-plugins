// Contextual timeout classes. Routine inspection is short; generic scripts get
// the default. Only recognized builds, analysis and transfers get the long class.
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
  'adb', 'fastboot', 'apktool', 'apksigner', 'keytool', 'zipalign',
  'dex2jar', 'd8', 'java', 'frida', 'frida-ps', 'qemu', 'wine', 'ffmpeg', 'yara', 'clamscan', 'docker',
]);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'branch', 'tag', 'describe']);
const GIT_TRANSFER = new Set(['clone', 'fetch', 'pull']);
const INSTALL = new Set(['install', 'i', 'ci', 'add', 'update', 'upgrade', 'rebuild']);

export function classify(program, args = []) {
  if (program === 'git') {
    let i = 0;
    while (args[i]?.startsWith('-')) {
      if (['-C', '-c', '--git-dir', '--work-tree'].includes(args[i])) i++;
      i++;
    }
    return GIT_READ.has(args[i]) ? 'fast' : GIT_TRANSFER.has(args[i]) ? 'heavy' : 'default';
  }
  if (['python', 'python3', 'py'].includes(program) && args[0] === '-m' && args[1] === 'pip') return classify('pip', args.slice(2));
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) {
    const sub = args[0];
    if (INSTALL.has(sub) || ['build', 'test'].includes(sub) || sub === 'run' && ['build', 'test', 'compile'].includes(args[1])) return 'heavy';
    return 'default';
  }
  if (['pip', 'pip3', 'uv', 'poetry', 'conda'].includes(program)) {
    const sub = program === 'uv' && args[0] === 'pip' ? args[1] : args[0];
    return ['install', 'sync', 'update', 'add', 'download', 'wheel', 'build'].includes(sub) ? 'heavy' : 'default';
  }
  if (program === 'strings' && args.some((a) => ['-a', '--all'].includes(a))) return 'heavy';
  if (FAST.has(program)) return 'fast';
  if (HEAVY.has(program)) return 'heavy';
  return 'default';
}

export function timeoutFor(program, args, options) {
  const klass = classify(program, args), limits = options.timeout || {};
  const value = klass === 'fast' ? limits.fast ?? 60 : klass === 'heavy' ? limits.heavy ?? 900 : limits.default ?? 120;
  return { klass, seconds: Math.min(Number(value), Number(limits.ceiling ?? 1800)) };
}

export function clampExplicit(explicit, options) {
  const ceiling = Number(options.timeout?.ceiling ?? 1800), value = Number(explicit);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(value, ceiling);
}

export { FAST, HEAVY };
