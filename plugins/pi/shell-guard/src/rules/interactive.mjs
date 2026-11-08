// Commands that never return on their own: they wait for stdin, a device, a
// port, or an editor. These are the "looks like a hang" class, distinct from
// merely slow commands.

const BARE_REPL = new Set([
  'python', 'python3', 'py', 'node', 'nodejs', 'deno', 'bun', 'ruby', 'irb',
  'php', 'perl', 'lua', 'ipython', 'julia', 'r', 'R',
  'bash', 'sh', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd',
]);

const STDIN_FILTER = new Set([
  'cat', 'sort', 'wc', 'xxd', 'hexdump', 'od', 'head', 'tail', 'grep', 'egrep',
  'fgrep', 'strings', 'tr', 'cut', 'tee', 'nl', 'rev', 'uniq', 'base64', 'jq', 'sed', 'awk',
]);

const PAGER_EDITOR = new Set([
  'less', 'more', 'vim', 'vi', 'nvim', 'nano', 'emacs', 'htop', 'top', 'tig',
  'mc', 'man', 'info', 'watch',
]);

const LOG_FOLLOW = new Set(['ping', 'journalctl']);

const LONG_INFO_FLAGS = new Set(['--help', '--version']);
const SHORT_INFO_FLAGS = new Map([
  ['grep', new Set(['-V'])], ['egrep', new Set(['-V'])], ['fgrep', new Set(['-V'])], ['zgrep', new Set(['-V'])],
  ['head', new Set(['-V'])], ['tail', new Set(['-V'])], ['sed', new Set(['-V'])],
  ['less', new Set(['-V'])], ['more', new Set(['-V'])], ['vim', new Set(['-V'])],
  ['vi', new Set(['-V'])], ['nvim', new Set(['-V'])], ['nano', new Set(['-V'])],
  ['watch', new Set(['-V'])],
]);

function isImmediateInfo(program, args) {
  const short = SHORT_INFO_FLAGS.get(program) ?? new Set();
  return args.length > 0 && args.every((arg) => LONG_INFO_FLAGS.has(arg) || short.has(arg));
}

export function checkInteractive(program, args, options, context = {}) {
  if (!options.interactive) return null;
  const piped = context.piped === true;
  const has = (...flags) => args.some((t) => flags.some((f) => t === f || t.startsWith(`${f}=`) || t.startsWith(f)));
  if (isImmediateInfo(program, args) && (STDIN_FILTER.has(program) || PAGER_EDITOR.has(program))) return null;

  // --- language shells -----------------------------------------------------
  if (BARE_REPL.has(program)) {
    if (has('--version', '-V', '--help', '-h', '--usage')) return null;
    const inline = has('-c', '-e', '-r', '--eval', '-Command', '-EncodedCommand', '/c');
    // `python - <<'EOF' ... EOF` feeds a script through stdin; it is not a REPL.
    const stdinScript = args.includes('-') && /<<-?\s*['"]?[A-Za-z_]/.test(options.commandText ?? '');
    const scriptFile = stdinScript || piped || args.some((t) => !t.startsWith('-') && !/^\/[ck]$/i.test(t));
    if (!inline && !scriptFile) {
      return block('bare-repl', `${program} 无参数会进入交互式 REPL 并一直等待输入。改用：${program} script.py，或 ${program} -c "<一行代码>"。`);
    }
  }

  // --- stdin filters -------------------------------------------------------
  if (program === 'tail' && has('-f', '-F', '--follow')) return block('tail-follow', 'tail -f 会持续等待新内容。改存快照（tail -n 200 file）或放到后台并重定向。');
  if (STDIN_FILTER.has(program) && !piped && !isImmediateInfo(program, args)) {
    const valueFlags = new Set(['-n', '--lines', '-c', '--bytes', '-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '-B', '-C', '--context', '--include', '--exclude']);
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const token = args[i];
      if (valueFlags.has(token)) { i++; continue; }
      if (token.startsWith('-')) continue;
      positional.push(token);
    }
    const hasPatternFlag = args.some((token) => ['-e', '--regexp', '-f', '--file'].includes(token));
    const needsPatternAndFile = ['grep', 'egrep', 'fgrep', 'sed', 'awk', 'jq'].includes(program) && !hasPatternFlag;
    if (positional.length === 0 || (needsPatternAndFile && positional.length < 2)) {
      return block('stdin-wait', `${program} 没有足够的文件参数，会等待标准输入直到被执行器关闭。请显式给出文件或路径。`);
    }
  }

  if (context.background && ['python', 'python3', 'py', 'npm', 'pnpm', 'yarn', 'bun', 'vite', 'next', 'nuxt', 'tail', 'ping', 'journalctl', 'docker', 'kubectl', 'nc', 'ncat', 'netcat', 'socat', 'scrcpy'].includes(program)) return null;

  // --- pagers and editors --------------------------------------------------
  if (PAGER_EDITOR.has(program) && !isImmediateInfo(program, args)) {
    return block('pager-editor', `${program} 是交互式分页/编辑器，会等待按键。读取内容改用 head/sed 分段，或写入文件后再读。`);
  }

  // --- git interactive -----------------------------------------------------
  if (program === 'git') {
    const sub = args.find((t) => !t.startsWith('-')) || '';
    if (sub === 'rebase' && has('-i', '--interactive')) return block('git-rebase-i', 'git rebase -i 会打开编辑器并等待输入；请改用非交互参数或先写好 todo 文件。');
    if (sub === 'commit' && !has('-m', '-F', '--file', '--no-edit', '--fixup', '--squash')) return block('git-commit-editor', 'git commit 不带 -m/-F 会打开编辑器并等待输入；请加 -m "<message>"。');
    if (['add', 'checkout', 'restore', 'reset', 'stash'].includes(sub) && has('-p', '--patch', '-i', '--interactive')) return block('git-patch-mode', `git ${sub} -p/-i 会进入交互式选择；请改用明确路径。`);
  }

  // --- devices -------------------------------------------------------------
  if (program === 'adb') {
    const sub = args.find((t) => !t.startsWith('-')) || '';
    if (sub === 'wait-for-device') return block('adb-wait', 'adb wait-for-device 会一直等到设备出现。先 adb devices 确认连接，或加 timeout。');
    if (sub === 'logcat' && !has('-d', '--dump', '-c', '--clear')) return block('adb-logcat', 'adb logcat 会持续输出。改用 adb logcat -d > log.txt 取一次性快照。');
    if (sub === 'shell' && args.filter((t) => !t.startsWith('-')).length <= 1) return block('adb-shell', 'adb shell 无命令会进入设备交互 shell。请把命令写在后面，例如 adb shell ls /sdcard。');
  }
  if (program === 'fastboot' && args.filter((t) => !t.startsWith('-')).length === 0) {
    return block('fastboot-wait', 'fastboot 无子命令会等待设备。请给出具体子命令，例如 fastboot devices。');
  }
  if (program === 'scrcpy') return block('scrcpy', 'scrcpy 是常驻投屏进程，不会自行退出。');
  if (program === 'frida' && !has('-f', '--file', '-l', '--load', '-s', '--script')) {
    return block('frida-repl', 'frida 无脚本会进入交互 REPL。请用 frida -f <app> -l <script.js> 并放入后台。');
  }

  // --- servers and followers ----------------------------------------------
  if (program === 'tail' && has('-f', '-F', '--follow')) return block('tail-follow', 'tail -f 会持续等待新内容。改存快照（tail -n 200 file）或放到后台并重定向。');
  if (program === 'watch' && !isImmediateInfo(program, args)) return block('watch', 'watch 会循环刷新直到按键退出。');
  if (program === 'ping' && !has('-c', '-n', '-w')) return block('ping-forever', 'ping 不加次数会一直跑。加 -c 4 或 -n 4。');
  if (LOG_FOLLOW.has(program) && has('-f', '--follow')) return block('log-follow', `${program} -f 会持续跟随日志。改取快照，或放到后台并重定向。`);
  if (['docker', 'kubectl'].includes(program) && args.includes('logs') && has('-f', '--follow')) {
    return block('logs-follow', `${program} logs -f 会持续跟随日志。去掉 -f 取快照。`);
  }
  if (program === 'mitmproxy') return block('mitmproxy', 'mitmproxy 是交互式代理，会占用终端。改用 mitmdump 并放到后台。');
  if (program === 'nc' || program === 'ncat' || program === 'netcat') {
    if (has('-l', '--listen')) return block('netcat-listen', 'nc -l 会监听端口并阻塞。放到后台并重定向，或改用一次性脚本。');
  }
  if (program === 'socat') {
    return block('socat', 'socat 通常会常驻转发，需后台运行并重定向。');
  }
  if ((program === 'python' || program === 'python3' || program === 'py') && args.join(' ').includes('http.server')) {
    return block('http-server', 'python -m http.server 是常驻服务。放到后台并重定向：python -m http.server 8000 > .pi/logs/http.log 2>&1 </dev/null &');
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) {
    const sub = args.find((t) => !t.startsWith('-')) || '';
    if (sub === 'run' && /^(dev|start|serve|watch)$/i.test(args[args.indexOf(sub) + 1] || '')) {
      return block('dev-server', `${program} run ${args[args.indexOf(sub) + 1]} 是常驻开发服务。放到后台并重定向，或改用一次性构建命令。`);
    }
    if (sub === 'login' || sub === 'adduser') return block('npm-login', `${program} ${sub} 需要交互式输入凭据。请在一次性终端完成，或使用已配置的 token。`);
  }
  if (['vite', 'next', 'nuxt'].includes(program)) {
    const sub = args.find((t) => !t.startsWith('-')) || '';
    if (sub === 'dev' || program === 'vite') return block('dev-server', `${program} 是常驻开发服务，不会自行退出。`);
  }

  // --- interactive auth / elevation ---------------------------------------
  if (['ssh', 'scp', 'sftp', 'telnet'].includes(program)) {
    return block('remote-interactive', `${program} 可能需要交互式密码或主机确认。请用已配置的密钥/批处理模式（如 ssh -o BatchMode=yes）。`);
  }
  if (program === 'sudo') return block('sudo', 'sudo 可能需要交互式密码；本机也不应以提权执行分析命令。');
  if (program === 'gh' && args.includes('auth') && args.includes('login')) return block('gh-auth', 'gh auth login 会打开浏览器等待授权。');
  if (program === 'gpg' && args.some((t) => /^--(gen-key|edit-key|sign|decrypt|export-secret)/.test(t))) {
    return block('gpg-interactive', 'gpg 该子命令可能要求口令输入。');
  }

  return null;
}

function block(rule, reason) {
  return { action: 'block', rule, reason };
}

export const INTERACTIVE_PROGRAMS = new Set([
  ...BARE_REPL, ...STDIN_FILTER, ...PAGER_EDITOR, ...LOG_FOLLOW,
  'adb', 'fastboot', 'scrcpy', 'frida', 'tail', 'watch', 'docker', 'kubectl',
  'mitmproxy', 'nc', 'ncat', 'netcat', 'socat', 'npm', 'pnpm', 'yarn', 'bun',
  'vite', 'next', 'nuxt', 'ssh', 'scp', 'sftp', 'telnet', 'sudo', 'gh', 'gpg', 'git',
]);
