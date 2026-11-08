// Bounded lexer for simple shell command lists. Unsupported control flow and
// expansions are reported, never interpreted as evidence of safety. Not a sandbox.
const LIMIT = 65536;
export function parseShell(command) {
  const segments = [], issues = [];
  if (typeof command !== 'string' || command.length > LIMIT || command.includes('\0')) {
    return { segments, issues: ['invalid-or-oversize-command'], uncertain: true };
  }
  let segment, value = '', raw = '', quote = '', started = false, dynamic = false, expansion = false;
  let redirection = null, pending = [], groupStart = 0;
  const fresh = () => ({ text: '', tokens: [], redirects: [], heredocs: [], connector: '', background: false });
  segment = fresh();
  const flush = () => {
    if (!started) return;
    const token = { value, raw, dynamic, expansion };
    if (redirection) {
      const item = { ...redirection, target: token };
      segment.redirects.push(item);
      if (item.op.startsWith('<<') && item.op !== '<<<') pending.push({ segment, item });
      redirection = null;
    } else segment.tokens.push(token);
    value = ''; raw = ''; started = false; dynamic = false; expansion = false;
  };
  const push = (connector) => {
    flush();
    if (redirection) { issues.push('missing-redirection-target'); redirection = null; }
    if (segment.tokens.length || segment.redirects.length) {
      segment.connector = connector;
      segments.push(segment);
    }
    if (connector === '&') {
      for (let k = groupStart; k < segments.length; k++) segments[k].background = true;
    }
    if ([';', '\n', '&'].includes(connector)) groupStart = segments.length;
    segment = fresh();
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i], next = command[i + 1];
    segment.text += ch;
    if (quote) {
      raw += ch;
      if (ch === quote) quote = '';
      else if (quote === '"' && ch === '\\' && /[$`"\\\n]/.test(next ?? '')) {
        raw += next; if (next !== '\n') value += next; i++;
      } else {
        value += ch;
        if (quote === '"' && /[$`]/.test(ch)) { dynamic = true; if (ch === '`' || next === '(') expansion = true; }
      }
      continue;
    }
    if (ch === '\\' && next !== undefined) {
      if (next === '\n') { i++; continue; }
      // Preserve ambiguous unquoted Win32 paths for critical-path checks.
      if (/^[a-z]:/i.test(value)) { raw += ch; value += ch; started = true; dynamic = true; continue; }
      raw += ch + next; value += next; started = true; i++; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; raw += ch; started = true; continue; }
    if (ch === '#' && !started) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
      continue;
    }
    if (ch === '\n') {
      push('\n');
      for (const { segment: owner, item } of pending) {
        const delimiter = item.target.value;
        let body = '', found = false;
        while (i + 1 < command.length) {
          const end = command.indexOf('\n', i + 1);
          const stop = end < 0 ? command.length : end;
          let line = command.slice(i + 1, stop);
          i = stop;
          if (item.op === '<<-') line = line.replace(/^\t+/, '');
          if (line === delimiter) { found = true; break; }
          body += line + '\n';
        }
        if (!found) issues.push('unterminated-heredoc');
        const quoted = /['"\\]/.test(item.target.raw);
        owner.heredocs.push({ body, quoted });
        if (!quoted && /\$\(|`/.test(body)) issues.push('heredoc-expansion');
      }
      pending = [];
      continue;
    }
    if (/\s/.test(ch)) { flush(); continue; }
    const redir = /^(?:&>>?|<<<|<<-?|<>|<&|>&|>\||>>?|<)/.exec(command.slice(i));
    if (redir) {
      let fd;
      if (started && /^\d+$/.test(raw)) { fd = Number(value); started = false; value = ''; raw = ''; }
      else flush();
      if (redirection) issues.push('missing-redirection-target');
      let op = redir[0];
      // Prefer descriptor duplication to the single-character output operator.
      if ((op === '>' || op === '<') && next === '&') op += '&';
      redirection = { fd: fd ?? (op.startsWith('<') ? 0 : 1), explicitFd: fd !== undefined, op };
      i += op.length - 1;
      continue;
    }
    if (ch === '&' || ch === '|' || ch === ';') {
      let connector = ch;
      if (next === ch && ch !== ';' || ch === '|' && next === '&') { connector += next; i++; }
      push(connector); continue;
    }
    if (ch === '(' || ch === ')') { flush(); issues.push('shell-group-or-substitution'); push(';'); continue; }
    if (ch === '{' || ch === '}') { dynamic = true; issues.push('shell-brace-expansion-or-group'); }
    if (/[$`]/.test(ch)) { dynamic = true; if (ch === '`' || next === '(') expansion = true; }
    raw += ch; value += ch; started = true;
  }
  if (quote) issues.push('unterminated-quote');
  push('');
  if (pending.length) issues.push('unterminated-heredoc');
  if (segments.length > 256 || segments.some((item) => item.tokens.length > 4096)) issues.push('parser-limit');
  return { segments: segments.slice(0, 256), issues, uncertain: issues.length > 0 };
}

export const splitSegments = (command) => parseShell(command).segments;
export const words = (command) => parseShell(command).segments.flatMap((segment) => segment.tokens.map((token) => token.value));
export function programName(token) {
  return String(token ?? '').replace(/\\/g, '/').split('/').at(-1).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}
export const isBackground = (segments) => segments.some((segment) => segment.background);

// Track fd copies in order: `2>&1 >log` leaves stderr attached to the harness.
export function streamsDetached(segment, piped = false) {
  const descriptors = new Map([[0, 'harness'], [1, piped ? 'pipe' : 'harness'], [2, 'harness']]);
  for (const { fd, explicitFd, op, target } of segment.redirects) {
    if (op.startsWith('<<') || op === '<') { descriptors.set(fd, 'input'); continue; }
    const bothByName = op === '>&' && !explicitFd && !/^(?:\d+|-)$/.test(target.value);
    if ((op === '>&' || op === '<&') && !bothByName) {
      descriptors.set(fd, target.value === '-' ? 'closed' : descriptors.get(Number(target.value)) ?? 'harness');
      continue;
    }
    let sink = target.dynamic ? 'harness' : 'file';
    const alias = /^(?:\/dev\/fd\/|\/proc\/self\/fd\/)(\d+)$/.exec(target.value);
    if (alias) sink = descriptors.get(Number(alias[1])) ?? 'harness';
    if (/^\/dev\/(stdout|stderr|tty|console)$/.test(target.value)) sink = 'harness';
    if (op.startsWith('&>') || bothByName) { descriptors.set(1, sink); descriptors.set(2, sink); }
    else descriptors.set(fd, sink);
  }
  if (segment.connector === '|&') descriptors.set(2, descriptors.get(1));
  return [1, 2].every((fd) => ['file', 'closed', 'pipe'].includes(descriptors.get(fd)));
}
export function hasBackgroundRedirect(command) {
  const parsed = parseShell(command);
  return !parsed.uncertain && parsed.segments.filter((segment) => segment.background).length > 0
    && parsed.segments.every((segment) => !segment.background || streamsDetached(segment, ['|', '|&'].includes(segment.connector)));
}
