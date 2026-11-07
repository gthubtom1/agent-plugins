import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluate } from '../src/policy.mjs';
import { hasBackgroundRedirect, isBackground, splitSegments, words } from '../src/split.mjs';

const BASE = {
  cwd: 'D:/Project/demo',
  projectRoot: 'D:/Project/demo',
  home: 'C:/Users/toti',
  settings: { everything: { esPath: 'D:/Tools/es/es.exe' } },
};

const run = (command, extra = {}) => evaluate(command, { ...BASE, ...extra });

// Builds `python - <<'PY' ... PY` without fighting shell quoting in the test file.
const script = (body) => `python - <<'PY'\n${body}\nPY`;

function expect(command, expected, extra = {}) {
  const got = run(command, extra);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(got[key], value, `${command} -> ${key}: expected ${value}, got ${got[key]} (rule=${got.rule})`);
  }
  return got;
}

test('whole-disk searches are blocked', () => {
  // The exact command from the failing session.
  expect('find / -maxdepth 6 -name "*skinforge*" -newermt "2026-11-06" -type f 2>/dev/null | head -30',
    { action: 'block', rule: 'whole-disk-search' });
  expect('grep -r token /', { action: 'block', rule: 'whole-disk-search' });
  expect('rg -n pattern /', { action: 'block', rule: 'whole-disk-search' });
  expect('du -sh /', { action: 'block', rule: 'whole-disk-search' });
  expect('dir /s C:\\', { action: 'block', rule: 'whole-disk-search' });
  expect('Get-ChildItem -Recurse C:\\', { action: 'block', rule: 'whole-disk-search' });
  expect('where /R C:\\ notepad', { action: 'block', rule: 'whole-disk-search' });
  expect('find /d -maxdepth 2 -name x', { action: 'block', rule: 'whole-disk-search' });
  expect('find ~ -maxdepth 2 -name x', { action: 'block', rule: 'whole-disk-search' });
});

test('bounded searches stay allowed', () => {
  expect('find . -maxdepth 3 -name "*.js"', { action: 'allow' });
  expect('rg -n token work/', { action: 'allow' });
  expect('find D:/Project/lol-hf -maxdepth 2 -name x', { action: 'allow' });
  expect('ls /', { action: 'allow' });
  expect('cat notes.txt', { action: 'allow' });
  expect('rg token .', { action: 'allow' });
  expect('grep -rn token src/', { action: 'allow' });
});

test('blocked whole-disk search explains the fast alternative', () => {
  const got = expect('find / -name "*skinforge*"', { action: 'block' });
  assert.match(got.reason, /search_files|es\.exe/);
  assert.match(got.reason, /rg -n/);
});

test('destructive deletes are tiered', () => {
  expect('rm notes.txt', { action: 'allow', tier: 'T0' });
  expect('rm -rf node_modules', { action: 'allow', tier: 'T1' });
  expect('rm -rf build', { action: 'allow', tier: 'T1' });
  expect('rm -rf /tmp/scratch', { action: 'allow', tier: 'T1' });

  expect('rm -rf /', { action: 'block', tier: 'T3' });
  expect('rm -rf C:\\', { action: 'block', tier: 'T3' });
  expect('rm -rf ~', { action: 'block', tier: 'T3' });
  expect('rm -rf $HOME', { action: 'block', tier: 'T3' });
  expect('rm -rf D:/Project/demo/../../..', { action: 'block', tier: 'T3' });
  expect('rm -rf C:\\Windows', { action: 'block', tier: 'T3' });
  expect('del /s /q C:\\Windows', { action: 'block', tier: 'T3' });
  expect('Remove-Item -Recurse -Force "C:\\Program Files"', { action: 'block', tier: 'T3' });
  expect('rm -rf C:/Users/toti/.ssh', { action: 'block', tier: 'T3' });
  expect('rm', { action: 'block', tier: 'T3' });

  expect('rm -rf ../other', { action: 'confirm', tier: 'T2' });
  expect('rm -rf *', { action: 'confirm', tier: 'T2' });
  expect('rm -rf .', { action: 'confirm', tier: 'T2' });
  expect('rm -rf .git', { action: 'confirm', tier: 'T2' });
  expect('rm -rf %TEMP%/x', { action: 'confirm', tier: 'T2' });
});

test('indirect deletes require confirmation, scripted deletes follow their literal path', () => {
  expect('git clean -fdx', { action: 'confirm', tier: 'T2' });
  expect('git clean -n', { action: 'allow' });
  expect('find . -name "*.tmp" -delete', { action: 'confirm', tier: 'T2' });
  expect('ls | xargs rm', { action: 'confirm', tier: 'T2' });

  // A scripted delete is judged by its literal path, like rm itself: in-project
  // allow, outside confirm, drive root refused.
  expect('python -c "import shutil; shutil.rmtree(\'x\')"', { action: 'allow' });
  expect('python -c "import shutil; shutil.rmtree(\'D:/other\')"', { action: 'confirm' });
  expect('python -c "import shutil; shutil.rmtree(\'/\')"', { action: 'block', tier: 'T3' });
  expect('node -e "require(\'fs\').rmSync(\'x\',{recursive:true})"', { action: 'allow' });

  // A variable target or documentation text is not treated as a delete.
  expect(script('shutil.rmtree(STAGE)'), { action: 'allow' });
  expect(script("open('README.md','w').write('shutil.rmtree(STAGE)')"), { action: 'allow' });
});

test('commands that never return are blocked', () => {
  expect('python', { action: 'block', rule: 'bare-repl' });
  expect('node', { action: 'block', rule: 'bare-repl' });
  expect('cat', { action: 'block', rule: 'stdin-wait' });
  expect('tail -f app.log', { action: 'block', rule: 'tail-follow' });
  expect('adb logcat', { action: 'block', rule: 'adb-logcat' });
  expect('adb wait-for-device', { action: 'block', rule: 'adb-wait' });
  expect('python -m http.server 8000', { action: 'block', rule: 'http-server' });
  expect('npm run dev', { action: 'block', rule: 'dev-server' });
  expect('less file.txt', { action: 'block', rule: 'pager-editor' });
  expect('ssh example.com', { action: 'block', rule: 'remote-interactive' });
  expect('sudo ls', { action: 'block', rule: 'sudo' });
  expect('git commit', { action: 'block', rule: 'git-commit-editor' });
});

test('normal non-interactive forms stay allowed', () => {
  expect('python script.py', { action: 'allow' });
  expect('python -c "print(1)"', { action: 'allow' });
  expect('node -e "1+1"', { action: 'allow' });
  expect('cat notes.txt', { action: 'allow' });
  expect('tail -n 50 app.log', { action: 'allow' });
  expect('adb logcat -d > log.txt', { action: 'allow' });
  expect('adb devices', { action: 'allow' });
  expect('npm install', { action: 'allow' });
  expect('git commit -m "message"', { action: 'allow' });
  expect('git status', { action: 'allow' });
});

test('background commands must redirect stdio', () => {
  expect('python server.py &', { action: 'block', rule: 'background-no-redirect' });
  expect('python server.py > .pi/logs/s.log 2>&1 &', { action: 'allow' });
  // A heredoc body is data: `&` inside CSS/JS must not look like a background job.
  const heredoc = `cat >> design.css <<'EOF'
.a { color: red; }
.b { &:hover { color: blue; } }
EOF`;
  expect(heredoc, { action: 'allow' });
  expect(`python - <<'PYEOF'
print('x & y')
PYEOF`, { action: 'allow' });
  expect('python server.py > .pi/logs/s.log 2>&1 </dev/null &', { action: 'allow' });
  expect('make && make install', { action: 'allow' });
  expect('echo "a & b"', { action: 'allow' });
});

test('timeouts follow the command class', () => {
  assert.equal(run('ls -la').timeout, 60);
  assert.equal(run('rg token .').timeout, 60);
  assert.equal(run('python script.py').timeout, 900);
  assert.equal(run('jadx -d out app.apk').timeout, 900);
  assert.equal(run('git clone https://example.com/x.git').timeout, 900);
  assert.equal(run('some-unknown-tool --flag').timeout, 120);
  assert.equal(run('ls', { explicitTimeout: 30 }).timeout, 30);
  assert.equal(run('ls', { explicitTimeout: 9999 }).timeout, 1800);
  assert.equal(run('ls', { explicitTimeout: 0 }).timeout, 60);
});

test('allowlist and disable switches work', () => {
  expect('find / -maxdepth 1', { action: 'allow' }, { settings: { allow: ['^find /'] } });
  expect('rm -rf /', { action: 'allow' }, { settings: { enabled: false } });
  expect('rm -rf /', { action: 'allow' }, { settings: { rm: { policy: 'off' } } });
  expect('python', { action: 'allow' }, { settings: { interactive: false } });
});

test('segment splitting and background detection', () => {
  assert.equal(splitSegments('a && b').length, 2);
  assert.equal(splitSegments('a || b').length, 2);
  assert.equal(splitSegments('a | b').length, 2);
  assert.equal(splitSegments('echo "a & b"').length, 1);
  assert.deepEqual(words('git   commit -m "hello world"'), ['git', 'commit', '-m', 'hello world']);

  const bg = splitSegments('python server.py &');
  assert.equal(isBackground(bg, 'python server.py &'), true);
  assert.equal(hasBackgroundRedirect('python server.py > log 2>&1 </dev/null &'), true);
  assert.equal(hasBackgroundRedirect('python server.py > log &'), true);
  assert.equal(isBackground(splitSegments('a && b'), 'a && b'), false);
  assert.equal(isBackground(splitSegments('cmd 2>&1 | tail -5'), 'cmd 2>&1 | tail -5'), false);
});

test('segments are evaluated independently', () => {
  expect('cd work && rm -rf node_modules', { action: 'allow' });
  expect('cd work && rm -rf ../../outside', { action: 'confirm' });
  expect('cd / && find / -maxdepth 2 -name x', { action: 'block' });
});

test('user-named deletes are allowed, but scope cannot be widened', () => {
  // User explicitly names the folder: deletion goes through without a prompt.
  expect('rm -rf ../other', { action: 'allow', rule: 'rm-user-granted' },
    { userText: '帮我删除 D:/Project/other' });
  expect('rm -rf .git', { action: 'allow', rule: 'rm-user-granted' },
    { userText: '把 D:/Project/demo/.git 删掉' });
  expect('rm -rf .', { action: 'allow', rule: 'rm-user-granted' },
    { userText: '删除 D:/Project/demo' });

  // Same command without the user naming it: still needs a confirmation.
  expect('rm -rf ../other', { action: 'confirm' });

  // No delete verb in the message: not a grant.
  expect('rm -rf ../other', { action: 'confirm' },
    { userText: '看看 D:/Project/other 里有什么' });

  // Grant covers one path only; a second target reopens the confirmation.
  expect('rm -rf ../other ../outside', { action: 'confirm' },
    { userText: '删除 D:/Project/other' });

  // T3 is never grantable.
  expect('rm -rf /', { action: 'block' }, { userText: '删除 D:/ 整个盘' });
  expect('rm -rf C:/Windows', { action: 'block' }, { userText: '删除 C:/Windows' });

  // Globs and indirect deletes keep their confirmation.
  expect('rm -rf *', { action: 'confirm' }, { userText: '删除 D:/Project/demo' });
  expect('find . -name x -delete', { action: 'confirm' }, { userText: '删除 D:/Project/demo' });
});

test('junction targets are judged by their real path', () => {
  const realpath = (p) => (p.endsWith('/link') ? 'C:/Windows/System32' : p);
  expect('rm -rf link', { action: 'block', tier: 'T3' }, { realpath });
  expect('rm -rf notes.txt', { action: 'allow' }, { realpath });
});

test('wrapper commands are unwrapped before judging', () => {
  // The live UI test found this bypass: the guard saw `timeout`, not `find`.
  expect('timeout 5 find / -maxdepth 3 -name x', { action: 'block', rule: 'whole-disk-search' });
  expect('env FOO=1 find / -name x', { action: 'block', rule: 'whole-disk-search' });
  expect('timeout 10 rm -rf /', { action: 'block', tier: 'T3' });
  expect('nohup python', { action: 'block', rule: 'bare-repl' });

  expect('timeout 60 python script.py', { action: 'allow' });
  assert.equal(run('timeout 60 python script.py').timeout, 900);
  expect('nice -n 10 rg token .', { action: 'allow' });
  expect('env PATH=/usr/bin node -e "1"', { action: 'allow' });
});

test('command -v is a lookup, not an execution', () => {
  expect('command -v pwsh || command -v powershell || true', { action: 'allow' });
  expect('command -v python3', { action: 'allow' });
});
