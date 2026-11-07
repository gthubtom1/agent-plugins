#!/usr/bin/env node
// Offline replay: run real recorded commands through the policy and report what
// would happen, so false positives are found before anything is installed.
//
// Usage:
//   node scripts/replay.mjs <commands.json> [--cwd D:/Project/x] [--project D:/Project/x]
//                            [--json out.json] [--all]
//
// The JSON file is an array of command strings.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluate } from '../src/policy.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node scripts/replay.mjs <commands.json> [--cwd DIR] [--project DIR] [--json OUT] [--all]');
  process.exit(1);
}
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
};
const showAll = args.includes('--all');
const cwd = flag('cwd', process.cwd());
const projectRoot = flag('project', cwd);
const out = flag('json', '');

const commands = JSON.parse(await readFile(file, 'utf8'));
if (!Array.isArray(commands)) {
  console.error('commands file must contain a JSON array of strings');
  process.exit(1);
}

const rows = commands.map((command, index) => {
  let decision;
  try {
    decision = evaluate(command, { cwd, projectRoot, home: process.env.HOME || process.env.USERPROFILE });
  } catch (error) {
    decision = { action: 'error', rule: 'threw', reason: String(error?.message || error) };
  }
  return {
    index,
    command,
    action: decision.action,
    rule: decision.rule,
    tier: decision.tier,
    timeout: decision.timeout,
    reason: decision.reason,
  };
});

const byAction = rows.reduce((acc, row) => {
  acc[row.action] = (acc[row.action] ?? 0) + 1;
  return acc;
}, {});
const byRule = rows
  .filter((row) => row.action !== 'allow')
  .reduce((acc, row) => {
    acc[row.rule] = (acc[row.rule] ?? 0) + 1;
    return acc;
  }, {});

const printable = showAll ? rows : rows.filter((row) => row.action !== 'allow');
for (const row of printable) {
  console.log(`${row.action.toUpperCase().padEnd(7)} ${String(row.rule).padEnd(26)} ${row.command.slice(0, 110).replace(/\n/g, ' ⏎ ')}`);
  if (row.action !== 'allow' && row.reason) console.log(`        ↳ ${row.reason.slice(0, 220)}`);
}

const report = { cwd, projectRoot, total: rows.length, byAction, byRule, rows };
if (out) await writeFile(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${rows.length} commands → ${JSON.stringify(byAction)}`);
