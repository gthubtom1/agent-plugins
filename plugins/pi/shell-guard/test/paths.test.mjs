import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasGlob, isDriveRoot, isHomeRoot, isSystemPath, isUncRoot, isUnder, msysToWin, resolveTarget, stripTrailingSep,
} from '../src/paths.mjs';
import { buildArgs, describe as describeEs, parseOutput } from '../src/everything.mjs';

const CWD = 'D:/Project/demo';
const HOME = 'C:/Users/toti';

test('git bash paths map to windows drives', () => {
  assert.equal(msysToWin('/d/Project'), 'D:/Project');
  assert.equal(msysToWin('/c'), 'C:/');
  assert.equal(msysToWin('C:/already'), 'C:/already');
});

test('targets resolve relative to cwd without escaping', () => {
  assert.equal(resolveTarget('notes.txt', CWD).path, 'D:/Project/demo/notes.txt');
  assert.equal(resolveTarget('../other', CWD).path, 'D:/Project/other');
  assert.equal(resolveTarget('../../..', CWD).path, 'D:/');
  assert.equal(resolveTarget('/d/Project/demo/../../x', CWD).path, 'D:/x');
  assert.equal(resolveTarget('~/a', CWD, HOME).path, 'C:/Users/toti/a');
  assert.equal(resolveTarget('$HOME', CWD, HOME).path, HOME);
});

test('dynamic targets are reported instead of guessed', () => {
  assert.equal(resolveTarget('$TARGET/x').dynamic, true);
  assert.equal(resolveTarget('$(pwd)/x').dynamic, true);
  assert.equal(resolveTarget('%TEMP%/x').dynamic, true);
  assert.equal(resolveTarget('-').dynamic, true);
});

test('root and containment predicates', () => {
  assert.equal(isDriveRoot('D:/'), true);
  assert.equal(isDriveRoot('D:'), true);
  assert.equal(isDriveRoot('/'), true);
  assert.equal(isDriveRoot('D:/Project'), false);
  assert.equal(isHomeRoot(HOME + '/', HOME), true);
  assert.equal(isUnder('D:/a/b', 'D:/a'), true);
  assert.equal(isUnder('D:/ab', 'D:/a'), false);
  assert.equal(isUncRoot('//server/share'), true);
  assert.equal(isUncRoot('//server/share/deep'), false);
  assert.equal(hasGlob('*.js'), true);
  assert.equal(hasGlob('a.txt'), false);
});

test('system directories are recognised on any drive', () => {
  assert.equal(isSystemPath('C:/Windows/System32'), true);
  assert.equal(isSystemPath('D:/Program Files/App'), true);
  assert.equal(isSystemPath('C:/ProgramData/x'), true);
  assert.equal(isSystemPath('D:/Project/app'), false);
  assert.equal(isSystemPath('/usr/local'), true);
  assert.equal(stripTrailingSep('D:/a/'), 'D:/a');
});

test('everything CLI arguments and JSON parsing', () => {
  assert.deepEqual(buildArgs('skinforge', { limit: 5 }), ['-n', '5', '-json', 'skinforge']);
  assert.deepEqual(buildArgs('auth', { limit: 5, path: 'D:/Project/x', regex: true }), ['-n', '5', '-json', '-path', 'D:/Project/x', '-r', 'auth']);
  assert.match(describeEs('skinforge', { esPath: 'D:/Tools/es/es.exe', limit: 5 }), /D:\/Tools\/es\/es\.exe -n 5 -json "skinforge"/);

  const json = '[{"filename":"C:\\\\a\\\\b.txt"},{"filename":"D:\\\\c\\\\d.js"}]';
  assert.deepEqual(parseOutput(json), ['C:\\a\\b.txt', 'D:\\c\\d.js']);
  assert.throws(() => parseOutput('C:\\one\r\nD:\\two\r\n'));
  assert.throws(() => parseOutput(''));
  assert.throws(() => parseOutput('not json at all'));
  assert.deepEqual(parseOutput('[]'), []);
});
