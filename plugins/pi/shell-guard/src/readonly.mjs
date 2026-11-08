// Positive AST grammar only; never executes shell text or expands a loop list.
import { parse } from './vendor/unbash/parser.js';

const quote = value => `'${value.replaceAll("'", `'"'"'`)}'`;

export function isReadOnlyControl(command, checkLeaf) {
  if (typeof command !== 'string' || command.length > 65536 || command.includes('\0')) return false;
  let budget = 4096, control = false;
  try {
    const ast = parse(command);
    if (ast.errors?.length || !ast.commands.some(statement => ['For', 'If'].includes(statement.command?.type))) return false;
    function word(item, variables, literalOnly = false) {
      if (!item || typeof item.text !== 'string') return false;
      function parts(items, quoted = false) {
        return items.every(part => {
          if (part.type === 'Literal') return quoted || !/[*?[{~]/.test(part.text);
          if (part.type === 'SingleQuoted') return true;
          if (part.type === 'DoubleQuoted') return parts(part.parts, true);
          if (!literalOnly && part.type === 'SimpleExpansion') return variables.has(part.text.slice(1));
          if (!literalOnly && part.type === 'ParameterExpansion') return /^\$\{[a-zA-Z_][a-zA-Z0-9_]*\}$/.test(part.text) && variables.has(part.parameter);
          return false;
        });
      }
      return item.parts ? parts(item.parts) : !/[*?[{~]/.test(item.text);
    }
    const literal = item => word(item, new Set(), true);
    function leaf(node, variables, condition) {
      if (node.prefix.length || node.redirects.length || !(node.name?.text === '[' || literal(node.name))) return false;
      const name = node.name.value, args = node.suffix;
      if (!args.every(arg => word(arg, variables))) return false;
      const values = args.map(arg => arg.value);
      if (name === 'test' || name === '[') {
        const operands = name === '[' ? args.slice(0, -1) : args.slice();
        if (name === '[' && values.at(-1) !== ']') return false;
        if (operands[0]?.value === '!') operands.shift();
        return operands.length === 2 && literal(operands[0]) && ['-f', '-d', '-e', '-r', '-s', '-n', '-z', '-w', '-x', '-L', '-h'].includes(operands[0].value)
          && (literal(operands[1]) || /^".*"$/s.test(operands[1].text));
      }
      if (condition) return false;
      if (name === 'echo') return checkLeaf('echo ok');
      if (name === 'printf') {
        const format = values[0] === '--' ? 1 : 0;
        if (!literal(args[format]) || values[format].startsWith('-')) return false;
        const remainder = values[format].replace(/%(?:%|s)/g, '');
        return !remainder.includes('%') && checkLeaf('printf %s ok');
      }
      if (!['cat', 'head', 'stat'].includes(name)) return false;
      let files = 0, options = true;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i], value = arg.value;
        if (options && value === '--' && literal(arg)) { options = false; continue; }
        if (options && value.startsWith('-')) {
          if (!literal(arg)) return false;
          if (name === 'cat' && /^-[AbEnstTuv]+$/.test(value)) continue;
          if (name === 'head' && /^-(?:[qv]|\d+)$/.test(value)) continue;
          if (name === 'head' && ['-n', '-c'].includes(value) && literal(args[i + 1]) && /^\d+$/.test(values[i + 1])) { i++; continue; }
          if (name === 'stat' && ['-L', '-f', '--terse'].includes(value)) continue;
          return false;
        }
        // Read operands must be literal paths or quoted loop references. This
        // prevents splitting a list value into flags or the stdin operand '-'.
        if (!value || value === '-' || !literal(arg) && !/^".*"$/s.test(arg.text)) return false;
        if (!literal(arg) && [...variables.values()].some(list => list.some(v => !v || v === '-' || v.startsWith('-')))) return false;
        files++;
      }
      if (!files) return false;
      // Existing interactive/search rules still assess the validated argv.
      return checkLeaf([name, ...values.map(value => quote(value.replace(/\$\{?[a-zA-Z_][a-zA-Z0-9_]*\}?/g, 'loop-file')))].join(' '));
    }
    function visit(node, variables = new Map(), condition = false, depth = 0) {
      if (!node || --budget < 0 || depth > 32 || node.redirects?.length || node.background) return false;
      switch (node.type) {
        case 'Script': case 'CompoundList':
          return node.commands.length > 0 && node.commands.every(child => visit(child, variables, condition, depth + 1));
        case 'Statement': return visit(node.command, variables, condition, depth + 1);
        case 'AndOr':
          return node.operators.every(op => ['&&', '||'].includes(op)) && node.commands.every(child => visit(child, variables, condition, depth + 1));
        case 'For': {
          if (condition || !literal(node.name) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(node.name.value) || !node.wordlist?.length || variables.has(node.name.value)) return false;
          // Bash special variables can change directory lookup, splitting or
          // command resolution even when the body contains read-only commands.
          if (['PATH', 'IFS', 'HOME', 'PWD', 'OLDPWD', 'CDPATH', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'GLOBIGNORE'].includes(node.name.value)) return false;
          if (!node.wordlist.every(item => literal(item) && item.value && !/[\x00-\x1f\x7f]/.test(item.value))) return false;
          control = true;
          const inner = new Map(variables); inner.set(node.name.value, node.wordlist.map(item => item.value));
          return visit(node.body, inner, false, depth + 1);
        }
        case 'If':
          control = true;
          return visit(node.clause, variables, true, depth + 1) && visit(node.then, variables, false, depth + 1)
            && (!node.else || visit(node.else, variables, false, depth + 1));
        case 'Command': return leaf(node, variables, condition);
        default: return false;
      }
    }
    return visit(ast) && control;
  } catch { return false; }
}
