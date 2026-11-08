// Pure parsing of common execution wrappers. Unsupported options are uncertain.
import { programName } from './split.mjs';
import { hasGlob, resolveTarget } from './paths.mjs';

const WRAPPERS = new Set(['timeout', 'env', 'command', 'builtin', 'exec', 'nice', 'ionice', 'stdbuf', 'time', 'nohup']);
const VALUE_OPTIONS = {
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  env: ['-u', '--unset', '-C', '--chdir', '-a', '--argv0'],
  nice: ['-n', '--adjustment'], ionice: ['-c', '--class', '-n', '--classdata'],
  stdbuf: ['-i', '--input', '-o', '--output', '-e', '--error'],
  time: ['-f', '--format', '-o', '--output'], exec: ['-a'],
};
const FLAG_OPTIONS = {
  timeout: ['--foreground', '--preserve-status', '-v', '--verbose'],
  env: ['-i', '--ignore-environment', '-0', '--null', '-v', '--debug'],
  command: ['-p'], builtin: [], exec: ['-c', '-l'], nice: [],
  ionice: ['-t', '--ignore'], stdbuf: [], time: ['-p', '--portability', '-a', '--append', '-v', '--verbose', '-q', '--quiet'], nohup: [],
};

export function unwrap(tokens, options) {
  let rest = tokens.slice(), cwd = options.cwd, uncertain = false, depth = 0;
  while (rest[0] && /^[A-Za-z_][A-Za-z_0-9]*=/.test(rest[0].value)) rest.shift();
  while (rest.length && WRAPPERS.has(programName(rest[0].value))) {
    if (++depth > 12) { uncertain = true; break; }
    const name = programName(rest.shift().value);
    let lookup = false;
    while (rest[0]?.value.startsWith('-')) {
      const value = rest.shift().value;
      if (value === '--') break;
      if (name === 'command' && /^-[vV]+$/.test(value)) { lookup = true; continue; }
      if (value === '--help' || value === '--version') return { program: 'true', args: [], cwd, uncertain };
      let key = (VALUE_OPTIONS[name] || []).find((flag) => value === flag || value.startsWith(flag + '=') || (flag.length === 2 && value.startsWith(flag) && value.length > 2));
      if (key) {
        const argument = value === key ? rest.shift() : { value: value.slice(key.length).replace(/^=/, '') };
        if (!argument?.value) { uncertain = true; break; }
        if (name === 'env' && ['-C', '--chdir'].includes(key)) {
          const resolved = resolveTarget(argument.value, cwd, options.home, options.platform);
          if (resolved?.path) cwd = resolved.path; else uncertain = true;
        }
        continue;
      }
      if (name === 'nice' && /^-\d+$/.test(value)) continue;
      if (!(FLAG_OPTIONS[name] || []).includes(value)) { uncertain = true; break; }
    }
    if (lookup) return { program: 'command', args: ['-v'], cwd, uncertain };
    if (uncertain) break;
    if (name === 'timeout' && !/^\d+(?:\.\d+)?[smhd]?$/.test(rest.shift()?.value ?? '')) { uncertain = true; break; }
    if (name === 'env') {
      while (rest[0] && /^[A-Za-z_][A-Za-z_0-9]*=/.test(rest[0].value)) rest.shift();
    }
  }
  const first = rest.shift();
  if (first?.dynamic || first && hasGlob(first.value)) uncertain = true;
  return { program: programName(first?.value), args: rest.map((token) => token.value), argTokens: rest, cwd, uncertain };
}
