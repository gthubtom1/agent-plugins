import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from '../src/policy.mjs';

// These are parser inputs only. No candidate is ever run by a shell.
const options = { cwd: '/work/project', projectRoot: '/work/project', home: '/home/example', platform: 'linux' };
const decision = command => evaluate(command, options);
const loop = body => `for p in AGENTS.md '目录/说明 文档.md'; do ${body}; done`;

const positives = [
  ['screenshot test/printf', loop('if test -f "$p"; then printf "%s\\n" "$p"; fi')],
  ['bracket file test', loop('if [ -f "$p" ]; then printf \'%s\\n\' "$p"; fi')],
  ['directory test, negation and all branches', loop('if [ ! -d "${p}" ]; then echo "file: $p"; elif test -f "$p"; then printf -- "%s\\n" "${p}"; else echo missing; fi')],
  ['simple echo loop', 'for x in a b; do echo $x; done'],
  ['multiline, whitespace and Unicode', `for file in "项目/一.md" '项目/二.md'
do
  if [ -e "$file" ] && test -r "$file"
  then
    printf '%s\n' "$file"
  else
    echo "missing $file"
  fi
done`],
  ['standalone if and trailing readonly command', 'if test -f a; then echo yes; else echo no; fi; printf "%s\\n" done'],
  ['validated read leaves', loop('if test -f "$p"; then cat -n -- "$p"; head -n 3 "$p"; stat -L -- "$p"; fi')],
  ['string predicate', loop('if [ -n "$p" ]; then echo "$p"; fi')],
];
for (const [label, command] of positives) test(`readonly AST allows ${label}`, () => {
  const got = decision(command);
  assert.equal(got.action, 'allow', JSON.stringify(got));
  assert.equal(got.rule, 'readonly-control');
  assert.equal(got.timeout, 60);
  assert.equal(evaluate(command, { ...options, explicitTimeout: 17 }).timeout, 17);
});

const negatives = [
  ['unknown leaf', loop('unknown "$p"')],
  ['dangerous else branch', loop('if test -f "$p"; then echo yes; else rm "$p"; fi')],
  ['dangerous condition', loop('if rm "$p"; then echo yes; fi')],
  ['trailing deletion', `${loop('echo "$p"')}; rm a`],
  ['trailing unknown command', `${loop('echo "$p"')}; unknown a`],
  ['command substitution list', 'for p in $(echo a); do echo "$p"; done'],
  ['process substitution', loop('cat <(echo a)')],
  ['backticks', loop('echo `pwd`')],
  ['substitution in unused branch', loop('if [ -f "$p" ]; then echo yes; else echo "$(rm a)"; fi')],
  ['dynamic list', 'for p in "$TARGET"; do echo "$p"; done'],
  ['glob list', 'for p in *.md; do echo "$p"; done'],
  ['brace list', 'for p in {a,b}; do echo "$p"; done'],
  ['implicit list', 'for p; do echo "$p"; done'],
  ['assignment', loop('x=changed; echo "$p"')],
  ['eval', loop('eval echo "$p"')],
  ['source', loop('. helper.sh')],
  ['printf variable write', loop('printf -v output "%s" "$p"')],
  ['printf percent n', loop('printf "%n" output')],
  ['dynamic printf format', loop('printf "$p" a')],
  ['redirection', `${loop('echo "$p"')} > result`],
  ['branch redirection', loop('if test -f "$p"; then echo "$p" >result; fi')],
  ['background', loop('echo "$p" & echo done')],
  ['arithmetic loop', 'for ((i=0;i<3;i++)); do echo "$i"; done'],
  ['numeric comparison', loop('if [ "$p" -eq 1 ]; then echo yes; fi')],
  ['variable test', loop('if test -v "$p"; then echo yes; fi')],
  ['double bracket', loop('if [[ $p -eq 1 ]]; then echo yes; fi')],
  ['unquoted test variable', loop('if [ -f $p ]; then echo yes; fi')],
  ['parameter assignment', loop('echo "${p:=changed}"')],
  ['unknown head option', loop('head --unknown "$p"')],
  ['stdin cat argument', 'for p in -; do cat "$p"; done'],
  ['cat argument splitting', loop('cat $p')],
  ['PATH mutation', 'for PATH in a; do cat file; done'],
  ['parser missing done', 'for p in a; do echo "$p"'],
  ['parser missing fi', 'if test -f a; then echo yes'],
  ['trailing parse failure', `${loop('echo "$p"')}; if`],
];
for (const [label, command] of negatives) test(`readonly AST blocks ${label}`, () => {
  const got = decision(command);
  assert.equal(got.action, 'block', JSON.stringify(got));
  assert.ok(Number.isFinite(got.timeout) && got.timeout > 0);
});

test('readonly leaf checks still honor the configured guard rules', () => {
  // A literal '-' cannot become a stdin read through the loop variable.
  assert.equal(decision('for p in a -; do head -- "$p"; done').action, 'block');
  assert.equal(decision('for p in a; do cat; done').action, 'block');
});
