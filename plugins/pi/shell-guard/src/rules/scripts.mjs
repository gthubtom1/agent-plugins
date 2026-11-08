// A small lexer for inline Python/JS deletion calls, not a language interpreter.
// Strings/comments are data; dynamic targets and unsupported execution confirm.
const uncertain = () => ({ action: 'confirm', tier: 'T2', rule: 'script-delete-unknown', reason: '内联脚本含动态删除或执行，无法静态确定目标，需要明确确认。' });

function lex(source) {
  const tokens = [];
  for (let i = 0; i < source.length;) {
    const ch = source[i], next = source[i + 1];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '#' || ch === '/' && next === '/') {
      const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue;
    }
    if (['"', "'", '`'].includes(ch)) {
      const triple = ch !== '`' && source.slice(i, i + 3) === ch.repeat(3);
      const delimiter = triple ? ch.repeat(3) : ch;
      let value = '', dynamic = ch === '`', end = false;
      i += delimiter.length;
      while (i < source.length) {
        if (source.startsWith(delimiter, i)) { i += delimiter.length; end = true; break; }
        if (source[i] === '\\') { dynamic = true; i++; if (i < source.length) value += source[i++]; }
        else value += source[i++];
      }
      tokens.push({ type: 'string', value, dynamic: dynamic || !end }); continue;
    }
    const identifier = /^[\w$]+/.exec(source.slice(i));
    if (identifier) { tokens.push({ type: 'word', value: identifier[0] }); i += identifier[0].length; continue; }
    tokens.push({ type: 'punct', value: ch }); i++;
  }
  return tokens;
}

export function inlineSources(program, args, options) {
  const sources = [];
  for (let i = 0; i < args.length; i++) {
    if (['-c', '-e', '--eval', '--print', '-p'].includes(args[i])) {
      if (args[i + 1]) sources.push(args[++i]);
    } else if (/^--(?:eval|print)=/.test(args[i])) sources.push(args[i].slice(args[i].indexOf('=') + 1));
    else if (/^-[ce]/.test(args[i]) && args[i].length > 2) sources.push(args[i].slice(2));
  }
  let scriptFile = false;
  const valueFlags = new Set(['-c', '-e', '--eval', '--print', '-p', '-m', '-r', '--require', '--import', '--loader', '--input-type', '-W', '-X']);
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.has(args[i])) { i++; continue; }
    if (args[i] !== '-' && !args[i].startsWith('-')) scriptFile = true;
  }
  if (!scriptFile) sources.push(...(options.stdinSources || []));
  return sources;
}

export function scriptedDeletes(program, args, options, classifyTarget) {
  const sources = inlineSources(program, args, options);
  let decision = null;
  const merge = (next) => {
    if (!decision || ({ allow: 0, confirm: 1, block: 2 })[next.action] >= ({ allow: 0, confirm: 1, block: 2 })[decision.action]) decision = next;
  };
  for (const source of sources) {
    const tokens = lex(source);
    for (let i = 0; i < tokens.length; i++) {
      const name = tokens[i].value;
      const owner = tokens[i - 1]?.value === '.' ? tokens[i - 2]?.value : '';
      const direct = tokens[i].type === 'word' && (/^(rmtree|rimraf|rmSync|rmdirSync|unlinkSync)$/.test(name)
        || /^(rm|rmdir|unlink)$/.test(name) && tokens[i - 1]?.value === '.'
        || name === 'remove' && ['fs', 'os', 'shutil', 'promises'].includes(owner));
      const computed = tokens[i].type === 'string' && !tokens[i].dynamic && /^(rm|remove|unlink|rmtree|rmSync|rmdirSync|unlinkSync)$/.test(name) && tokens[i - 1]?.value === '[' && tokens[i + 1]?.value === ']';
      const call = computed ? i + 2 : i + 1;
      if (!(direct || computed) || tokens[call]?.value !== '(') {
        if (/^(eval|exec|execSync|spawn|spawnSync|system|popen|run|call)$/.test(name) && tokens[i + 1]?.value === '(') merge(uncertain());
        continue;
      }
      const recursive = !/^(unlink|unlinkSync|remove)$/.test(name);
      // Known destructive calls cannot hide hard literals inside an unresolved
      // first-argument expression. This is deliberately conservative for joins.
      let nesting = 0;
      for (let j = call + 1; j < tokens.length; j++) {
        const token = tokens[j];
        if (!nesting && [',', ')'].includes(token.value)) break;
        if (token.value === '(' || token.value === '[') nesting++;
        if (token.value === ')' || token.value === ']') nesting--;
        if (token.type === 'string' && !token.dynamic) {
          const resolvedLiteral = options.resolveScriptTarget(token.value);
          if (resolvedLiteral) {
            const hard = classifyTarget(resolvedLiteral, options, { recursive, raw: token.value });
            if (hard.action === 'block') merge(hard);
          }
        }
      }
      const target = tokens[call + 1], after = tokens[call + 2];
      if (target?.type !== 'string' || target.dynamic || ![',', ')'].includes(after?.value)) { merge(uncertain()); continue; }
      const resolved = options.resolveScriptTarget(target.value);
      if (!resolved) merge(uncertain());
      else merge(classifyTarget(resolved, options, { recursive, raw: target.value }));
    }
    // Imported aliases and computed method calls cannot be safely resolved by
    // this lexer. Request confirmation instead of pretending they do nothing.
    if (tokens.some((t, i) => t.type === 'word' && /^(rmtree|rimraf|rmSync|unlinkSync|rmdirSync)$/.test(t.value) && tokens[i + 1]?.value !== '(')
        || tokens.some((t, i) => t.type === 'word' && /^(rm|rmdir|unlink|remove)$/.test(t.value) && tokens[i + 1]?.value !== '(') && tokens.some((t) => /^(import|require|from)$/.test(t.value))
        || tokens.some((t, i) => ['fs', 'os', 'shutil', 'promises'].includes(t.value) && tokens[i + 1]?.value === '[')
        || tokens.some((t, i) => t.value === '[' && tokens[i + 1]?.type === 'string' && /^(rm|remove|unlink|rmtree|rmSync|rmdirSync|unlinkSync)$/.test(tokens[i + 1].value))) merge(uncertain());
  }
  return decision;
}
