import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from '../src/policy.mjs';
import { buildArgs, parseOutput } from '../src/everything.mjs';
import { isUnder, normalisePath, resolveTarget } from '../src/paths.mjs';
import { hasBackgroundRedirect, parseShell } from '../src/split.mjs';

// These commands are only strings given to pure evaluate(), never executed.
const BASE = { cwd: 'D:/work/project', projectRoot: 'D:/work/project', home: 'C:/Users/example', platform: 'win32' };
const decide = (command, extra = {}) => evaluate(command, { ...BASE, ...extra });
function cases(rows, extra) {
  for (const [command, action, overrides] of rows) {
    const result = decide(command, { ...extra, ...overrides });
    assert.equal(result.action, action, `${JSON.stringify(command)}: ${JSON.stringify(result)}`);
    assert.ok(Number.isFinite(result.timeout) && result.timeout > 0 && result.timeout <= 1800, JSON.stringify(result));
  }
}

test('negative, quoted, hypothetical, mixed and excluded instructions grant nothing', () => {
  for (const userText of ['不要删除 D:/outside', '请不要删除 D:/outside', 'do not delete D:/outside', '示例：`删除 D:/outside`', '"delete D:/outside"', 'He said delete D:/outside', 'delete D:/outside but not D:/keep', 'delete D:/outside; keep D:/keep', 'delete D:/outside\n不要删除 D:/keep', '如果需要就删除 D:/outside', '可以删除 D:/outside 吗？', 'delete all', '删除所有', 'delete D:/outside && echo ok']) {
    assert.equal(decide('rm -rf D:/outside', { userText }).action, 'confirm', userText);
  }
  cases([['rm -rf D:/outside D:/keep', 'confirm', { userText: 'delete D:/outside but not D:/keep' }]]);
});

test('affirmative grants are exact, single-target, platform-aware and never root grants', () => {
  cases([
    ['rm -rf D:/outside', 'allow', { userText: 'delete D:/outside' }],
    ['rm -rf D:/outside', 'allow', { userText: '请删除 D:/outside' }],
    ['rm -rf "D:/outside folder"', 'allow', { userText: 'please remove "D:/outside folder"' }],
    ['rm -rf ../other', 'allow', { userText: '把 D:/work/other 删掉' }],
    ['rm -rf D:/outside/child', 'confirm', { userText: 'delete D:/outside' }],
    ['rm -rf D:/outside D:/keep', 'confirm', { userText: 'delete D:/outside' }],
    ['rm -rf src', 'allow', { userText: '删除 src' }],
    ['rm -rf D:/OUTSIDE', 'allow', { userText: 'delete D:/outside' }],
    ['rm -rf /', 'block', { userText: 'delete /' }],
    ['rm -rf C:/Windows', 'block', { userText: 'delete C:/Windows' }],
  ]);
  cases([['rm -rf /work/Project/src', 'confirm', { platform: 'linux', cwd: '/work/project', projectRoot: '/work/project', home: '/home/example', userText: 'delete /work/project/src' }]]);
});

test('root and home-wide globs hard block while scoped project globs confirm', () => {
  cases([
    ['rm -rf /*', 'block'], ['rm -rf C:/*', 'block'], ['rm -rf C:/Users/*', 'block'],
    ['rm -rf C:/Users/exam*', 'block'], ['rm -rf ~/*', 'block'], ['rm -rf ${HOME}/*', 'block'],
    ['rm -rf C:/Windows/*', 'block'], ['rm -rf //host/share/*', 'block'],
    ['rm -rf src/*', 'confirm'], ['rm -rf *.tmp', 'confirm'], ['rm -rf build/*', 'confirm'],
  ], { settings: { allow: ['.*'] } });
  cases([['rm -rf /home/*', 'block'], ['rm -rf /home/example/*', 'block'], ['rm -rf src/*', 'confirm']], { platform: 'linux', cwd: '/work/project', projectRoot: '/work/project', home: '/home/example' });
  cases([['rm -rf vault/*', 'block']], { settings: { protectedPaths: ['D:/work/project/vault/private'] } });
  cases([['rm -rf /*', 'block']], { realpath: () => { throw new Error('unavailable'); } });
});

test('recursive source trees and global temp do not inherit automatic cleanup grants', () => {
  cases([
    ['rm -rf src', 'confirm'], ['rm -rf docs', 'confirm'], ['rm -rf test', 'confirm'],
    ['rmdir src', 'confirm'], ['del src', 'confirm'], ['Remove-Item -Recurse src', 'confirm'],
    ['rm -R build', 'allow'],
    ['rm -rf /tmp/unrelated', 'confirm'], ['rm -rf C:/Users/example/AppData/Local/Temp/unrelated', 'confirm'],
    ['rm -rf build', 'allow'], ['rm -rf .cache/task', 'allow'], ['rm -rf nested/node_modules', 'confirm'],
    ['rm -rf tmp', 'confirm'], ['rm -rf temp', 'confirm'], ['rm -rf .tmp', 'confirm'],
    ['rm -rf src/build', 'confirm'],
    ['rm notes.txt', 'allow'], ['rm -f -- notes.txt', 'allow'], ['unlink notes.txt', 'allow'],
    ['rm -rf .git/build', 'confirm'], ['rm -rf *', 'confirm'], ['rm -rf "$TARGET"', 'confirm'],
  ]);
});

test('config allow patterns never override roots, protected descendants or uncertainty', () => {
  cases([
    ['rm -rf /', 'block'], ['rm -rf C:/Windows', 'block'], ['rm -rf //host/share', 'block'],
    ['rm -rf src', 'confirm'], ['find . / -name x', 'block'], ['worker &', 'block'],
    ['ls -la', 'allow'],
  ], { settings: { allow: ['.*'] } });
  cases([['rm -rf vault', 'block'], ['rm vault', 'block'], ['rm -rf vault/private/file', 'block']], { settings: { allow: ['.*'], protectedPaths: ['D:/work/project/vault/private'] } });
  cases([['rm -rf D:/work', 'block']], { settings: { protectedPaths: ['D:/work/project/vault/private'] }, userText: 'delete D:/work' });
});

test('cd and env cwd changes cannot hide relative destructive paths or root searches', () => {
  cases([
    ['cd / && rm -rf etc', 'block'], ['cd /; rm -rf etc', 'block'],
    ['cd C:/ && rm -rf Windows', 'block'], ['cd / && find . -name x', 'block'],
    ['cd / && rg --files', 'block'], ['cd "$DEST" && rm -rf build', 'confirm'],
    ['env -C / rm -rf etc', 'block'], ['env --chdir=C:/ rm -rf Windows', 'block'],
    ['env -u MODE -C D:/outside rm -rf build', 'confirm'],
    ['cd work && rm -rf node_modules', 'confirm'], ['cd work && rm notes.txt', 'allow'],
    ['cd / | echo ok; rm notes.txt', 'allow'],
    ['cd / >cdlog 2>&1 && worker >log 2>&1 & rm notes.txt', 'allow'],
    ['bash -c "cd /; rm -rf etc"', 'block'],
    ['bash -c "rm -rf D:/outside"', 'allow', { userText: 'delete D:/outside' }],
  ]);
});

test('common wrapper value options cannot mask the executable', () => {
  cases([
    ['timeout -s TERM -k 2 5 rm -rf /', 'block'],
    ['timeout --signal=TERM --kill-after=2 5 find / -name x', 'block'],
    ['env --unset=MODE --chdir=/ rm -rf etc', 'block'],
    ['nice -n 10 rm -rf /', 'block'], ['nice -n10 rm -rf /', 'block'],
    ['ionice -c 2 -n 7 rm -rf /', 'block'], ['stdbuf -o L -e 0 rm -rf /', 'block'],
    ['time -f "%E" -o timing.log rm -rf /', 'block'], ['exec -a alias rm -rf /', 'block'],
    ['FOO=bar command -p rm -rf /', 'block'], ['command rm -v -rf /', 'block'],
    ['env -S "rm -rf /"', 'block'],
    ['timeout --unknown 5 rm -rf /', 'block'],
    ['timeout -s TERM 60 python script.py', 'allow'], ['env -u MODE nice -n 5 rg token src', 'allow'],
    ['command -v python', 'allow'], ['command -V pwsh', 'allow'],
  ]);
});

test('multiple roots, implicit roots and pattern-option arities in searches', () => {
  cases([
    ['find . / -name x', 'block'], ['find -L . D:/ -name x', 'block'],
    ['rg --files', 'block', { cwd: 'D:/', projectRoot: 'D:/' }],
    ['find -name x', 'block', { cwd: 'D:/', projectRoot: 'D:/' }],
    ['grep -r -e token /', 'block'], ['rg -e token /', 'block'], ['rg -f patterns.txt /', 'block'],
    ['rg --glob "*.mjs" token /', 'block'], ['rg --files --hidden /', 'block'],
    ['find "$ROOT" -name x', 'confirm'], ['find -files0-from roots.txt -name x', 'confirm'],
    ['find /d -name x', 'allow', { platform: 'linux', cwd: '/work/project', projectRoot: '/work/project', home: '/home/example' }],
    ['find . src -name "*.mjs"', 'allow'], ['rg -e token -g "*.mjs" src', 'allow'],
    ['rg --files src', 'allow'], ['grep -r -f patterns.txt src', 'allow'],
    ['dir /s C:/ D:/work/project', 'block'], ['Get-ChildItem -Recurse C:/ D:/work/project', 'block'],
  ]);
});

test('newlines and comments execute following commands while heredoc data does not', () => {
  cases([
    ['echo ready\nrm -rf /', 'block'], ['echo ready # note\nrm -rf /', 'block'],
    ["cat <<'EOF'\ntext\nEOF\nrm -rf /", 'block'],
    ["cat <<'EOF'\nrm -rf /\nEOF", 'allow'],
    ["cat <<'EOF'\n$(rm -rf /) &\nEOF", 'allow'],
    ['cat <<EOF\n$(rm -rf /)\nEOF', 'confirm'],
    ["cat <<'EOF'\nunclosed", 'confirm'],
    ['echo "$(rm -rf /)"', 'confirm'],
    ['if true; then rm -rf /; fi', 'block'],
    ['for x in src; do echo "$x"; done', 'confirm'],
  ]);
  assert.equal(parseShell("cat <<'EOF'\na & b\nEOF").segments.length, 1);
});

test('each background job and each pipeline stage must detach both output streams', () => {
  cases([
    ['worker </dev/null &', 'block'], ['worker >log &', 'block'], ['worker 2>err &', 'block'],
    ['worker >log 2>&1 &', 'allow'], ['worker &>log &', 'allow'], ['worker >&log &', 'allow'],
    ['worker 2>&1 >log &', 'block'], ['worker >log 2>&1 & worker &', 'block'],
    ['worker >log 2>&1 & worker >other 2>&1 &', 'allow'],
    ['worker 2>err | sink >log 2>other &', 'allow'], ['worker | sink >log 2>&1 &', 'block'],
    ['worker |& sink >log 2>&1 &', 'allow'], ['worker 2>&1 | sink >log &', 'block'],
    ['worker >/dev/stdout 2>/dev/stderr &', 'block'], ['worker >log 2>/dev/fd/1 &', 'allow'],
    ['npm run dev >log 2>&1 &', 'allow'], ['npm run dev &', 'block'],
  ]);
  assert.equal(hasBackgroundRedirect('worker >log &'), false);
  assert.equal(hasBackgroundRedirect('worker >log 2>&1 &'), true);
});

test('pipeline input is local to the adjacent stage, and input redirect/heredoc feeds filters', () => {
  cases([
    ['echo ready; cat', 'block'], ['echo ready && cat', 'block'], ['echo ready\ncat', 'block'],
    ['echo ready | cat', 'allow'], ['cat <notes.txt', 'allow'], ['cat <<EOF\ntext\nEOF', 'allow'],
    ['echo ready | cat; cat', 'block'], ['echo ready; head -5', 'block'],
    ['python /work/tool.py', 'allow'], ['echo "print(1)" | python', 'allow'],
  ]);
});

test('inline deletion variables confirm, literals tier correctly, quoted documentation is data', () => {
  cases([
    ["python -c 'shutil.rmtree(TARGET)'", 'confirm'], ["node -e 'fs.rmSync(target,{recursive:true})'", 'confirm'],
    ["python <<< 'shutil.rmtree(TARGET)'", 'confirm'], ["bash <<< 'rm -rf /'", 'block'],
    ["python -u <<'PY'\nshutil.rmtree(TARGET)\nPY", 'confirm'],
    ["node --input-type=module <<< 'fs.rmSync(TARGET)'", 'confirm'],
    ["bash script.sh <<'EOF'\nrm -rf /\nEOF", 'allow'],
    ["node -e \"require('fs').rm(target,{recursive:true})\"", 'confirm'],
    ["node -e \"require('fs').rm('/',{recursive:true})\"", 'block'],
    ["python - <<'PY'\nshutil.rmtree(TARGET)\nPY", 'confirm'],
    ["python -c \"shutil.rmtree('/')\"", 'block'], ["node -e \"require('fs').rmSync('C:/Windows',{recursive:true})\"", 'block'],
    ["python -c \"shutil.rmtree('src')\"", 'confirm'], ["python -c \"shutil.rmtree('build')\"", 'allow'],
    ["node -e \"fs.unlinkSync('notes.txt')\"", 'allow'],
    ["python -c \"open('README.md','w').write('shutil.rmtree(TARGET)')\"", 'allow'],
    ["python -c \"# shutil.rmtree('/')\nprint(1)\"", 'allow'],
    ["node -e \"const docs = 'fs.rmSync(target)'; console.log(docs)\"", 'allow'],
    ["python -c \"shutil.rmtree('build' + suffix)\"", 'confirm'],
    ["python -c \"shutil.rmtree('/' + suffix)\"", 'block'],
    ["node -e \"fs['rmSync']('/',{recursive:true})\"", 'block'],
    ["node -e \"fs.rmSync(target || '/', {recursive:true})\"", 'block'],
    ["python -c \"shutil.rmtree(f'build/{name}')\"", 'confirm'],
    ["node -e \"fs['rmSync'](target)\"", 'confirm'],
    ["node -e \"fs[method](target)\"", 'confirm'],
    ["node -e \"const {rm: wipe} = require('fs'); fs.unlinkSync('notes.txt'); wipe(target)\"", 'confirm'],
    ["python -c \"from shutil import rmtree as wipe; wipe(TARGET)\"", 'confirm'],
    ["find . -exec rm -rf / \\;", 'block'], ['echo paths | xargs rm', 'confirm'],
    ['echo paths | xargs rm -rf /', 'block'],
  ]);
});

test('POSIX case sensitivity, UNC structure, root containment and Windows suffixes', () => {
  assert.equal(isUnder('/work/Project/x', '/work/project', 'linux'), false);
  assert.equal(isUnder('/etc/file', '/', 'linux'), true);
  assert.equal(isUnder('D:/x', 'D:/', 'win32'), true);
  assert.equal(isUnder('D:/ab', 'D:/a', 'win32'), false);
  assert.equal(normalisePath('//server/share/a/../b', 'win32'), '//server/share/b');
  assert.equal(resolveTarget('../other', BASE.cwd, BASE.home, 'win32').path, 'D:/work/other');
  assert.equal(resolveTarget('/d', '/work/project', '/home/example', 'linux').path, '/d');
  cases([
    ['rm -rf "C:/Windows. /System32"', 'block'], ['rm -rf "D:/work/project/.. /.. /.. /"', 'block'],
    ["rm -rf '\\\\server\\share'", 'block'], ['rm -rf //server/share', 'block'],
    ['rm -rf "D:relative"', 'confirm'], ['rm -rf "\\\\?\\C:\\Windows"', 'block'],
    ['rm -rf "\\Windows"', 'block'],
  ]);
});

test('realpath failure, protected referents and generated links never become grants', () => {
  cases([['rm -rf build', 'block']], { realpath: (p) => p.endsWith('/build') ? 'C:/Windows' : p });
  cases([['rm -rf build', 'confirm']], { realpath: (p) => p.endsWith('/build') ? 'D:/outside/build' : p });
  cases([['rm notes.txt', 'confirm']], { realpath: () => { throw new Error('unavailable'); } });
  cases([['rm -rf /', 'block'], ['rm -rf C:/Windows', 'block'], ['rm -rf C:/Users/example/.ssh', 'block']], { realpath: () => { throw new Error('unavailable'); } });
});

test('independent review regressions: argv expansion, CDPATH, PS arrays and option arities', () => {
  const linux = { platform: 'linux', cwd: '/work/app', projectRoot: '/work/app', home: '/home/alice' };
  cases([['/bin/r[m] -rf /home/alice/.ssh', 'confirm'], ['CDPATH=/home/alice cd .ssh; rm -f id_ed25519', 'confirm']], linux);
  cases([['Remove-Item -Recurse ./dist/a,/Users/Alice/.ssh', 'block']], { cwd: 'C:/work/app', projectRoot: 'C:/work/app', home: 'C:/Users/Alice' });
  cases([['git clean -fd -e -n', 'confirm'], ['git clean -fen', 'confirm'], ['git clean -- -n', 'confirm'], ['git clean -n -e pattern', 'allow']]);
  cases([['rg -L needle /', 'block'], ['rg -I needle /', 'block'], ['grep -rE needle /', 'block'], ['rg -L needle src', 'allow'], ['fd --glob needle /', 'block'], ['grep -r --color needle /', 'block']]);
});

test('Every enabled/disabled/config-error decision has a finite bounded timeout', () => {
  cases([
    ['ls', 'allow', { settings: { enabled: false } }],
    ['ls', 'allow', { settings: { enabled: false }, explicitTimeout: 99999 }],
    ['ls', 'allow', { settings: { timeout: { fast: Infinity, default: -1, heavy: NaN, ceiling: 99999 } } }],
    ['ls', 'block', { settings: { protectedPaths: ['$TARGET'] } }],
  ]);
  assert.equal(decide('ls', { settings: { enabled: false }, explicitTimeout: 99999 }).timeout, 1800);
  const broken = { get settings() { throw new Error('configuration read failed'); } };
  assert.deepEqual(evaluate('ls', broken), { action: 'block', timeout: 120, reason: '策略发生内部或配置错误，未完成评估，已拒绝执行。', rule: 'policy-error', tier: 'T3' });
  assert.equal(decide('ls', { settings: { protectedPaths: ['$TARGET'] } }).rule, 'policy-error');
});

test('Everything query arguments are bounded literals and strict JSON errors are visible', () => {
  for (const query of ['', ' ', '-n 9999', '/ad', '\t-delete', 'x\0y', 'a'.repeat(513), undefined, 123]) assert.throws(() => buildArgs(query), String(query));
  for (const limit of [0, -1, 201, 1.5, NaN, Infinity, '5']) assert.throws(() => buildArgs('name', { limit }), String(limit));
  for (const path of ['.', '../other', '-path', 'D:relative', 'D:/x\0y', '$HOME/x', '']) assert.throws(() => buildArgs('name', { path }), path);
  assert.deepEqual(buildArgs('foo|bar', { regex: true, foldersOnly: true, limit: 200, path: 'D:/work' }), ['-n', '200', '-json', '-path', 'D:/work', '-r', '/ad', 'foo|bar']);
  assert.deepEqual(parseOutput('[{"filename":"D:/work/a"},{"path":"D:/work/b"}]'), ['D:/work/a', 'D:/work/b']);
  assert.deepEqual(parseOutput('[]'), []);
  for (const output of ['not json', '[{"filename":', '', 'null', '{}', '[{}]', '[1]', '[{"filename":""}]']) assert.throws(() => parseOutput(output), output);
});
