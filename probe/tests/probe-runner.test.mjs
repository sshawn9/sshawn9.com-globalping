import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = fileURLToPath(new URL('../', import.meta.url));
const tasks = [
  { url: 'https://example.com/a.css', cities: ['CN+Shanghai', 'JP+Tokyo'] },
  { url: 'https://example.com/b.js', cities: ['US+New York', 'US+Los Angeles', 'DE+Berlin', 'FR+Paris', 'GB+London', 'SG+Singapore', 'AU+Sydney'] },
  { url: 'https://example.com/c.png', cities: ['CN+Beijing'] },
];
const raw = '{ "results": [{ "result": { "status": "failed" } }], "large": 9007199254740993 }\n';

async function runTasks(t, { quota = 10, mode = 'success', input = tasks } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'globalping-runner-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bin'));
  for (const file of ['execute-probe-tasks.mjs', 'probe-resource.mjs']) await cp(join(source, file), join(root, file));
  const taskFile = join(root, 'tasks.json');
  await writeFile(taskFile, JSON.stringify(input));
  const statsFile = join(root, 'results/probe-stats.json');
  const log = join(root, 'calls.jsonl');
  await writeFile(join(root, 'mock-ip.mjs'), `
import { appendFileSync, readFileSync } from 'node:fs';
globalThis.fetch = async (url) => {
  if (url !== 'https://api.ipify.org?format=json') throw new Error('Unexpected request');
  const stats = JSON.parse(readFileSync(process.env.STATS_FILE, 'utf8'));
  appendFileSync(process.env.CALL_LOG, JSON.stringify({ type: 'ip', stats }) + '\\n');
  if (process.env.CLI_MODE === 'ip-error') throw new Error('IP lookup failed');
  return new Response(JSON.stringify({ ip: '203.0.113.10' }));
};
`);
  await writeFile(join(root, 'bin/globalping-cli'), `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const stats = JSON.parse(readFileSync(process.env.STATS_FILE, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, JSON.stringify({ type: args[0], stats, args }) + '\\n');
if (args[0] === 'limits') {
  if (process.env.CLI_MODE === 'limits-error') {
    console.error('Limits lookup failed');
    process.exitCode = 1;
  } else {
    console.log('Creating measurements:\\n - 250 tests per hour\\n - 0 consumed, ' + process.env.QUOTA + ' remaining');
  }
} else if (process.env.CLI_MODE === 'mixed' && stats.attempted_records === 7) {
  console.error('Network failure');
  process.exitCode = 1;
} else if (process.env.CLI_MODE === 'mixed' && stats.attempted_records === 9) {
  console.log('invalid JSON');
} else {
  process.stdout.write(${JSON.stringify(raw)});
  if (process.env.CLI_MODE === 'mixed' && stats.attempted_records === 2) process.exitCode = 1;
}
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, ['--import', join(root, 'mock-ip.mjs'), join(root, 'execute-probe-tasks.mjs'), taskFile], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      STATS_FILE: statsFile, CALL_LOG: log, CLI_MODE: mode, QUOTA: String(quota) },
  });
  const events = (await readFile(log, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  })).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { root, result, events, statsFile, calls: events.filter(({ type }) => type === 'http') };
}

test('executes each task\'s cities, records attempts before calls, and preserves JSON despite CLI errors', async (t) => {
  const { root, result, events, calls, statsFile } = await runTasks(t, { mode: 'mixed' });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(calls.map(({ args }) => [args[1], args[args.indexOf('--from') + 1], Number(args[args.indexOf('--limit') + 1])]), [
    [tasks[0].url, tasks[0].cities.join(','), 2],
    [tasks[1].url, tasks[1].cities.slice(0, 5).join(','), 5],
    [tasks[1].url, tasks[1].cities.slice(5).join(','), 2],
    [tasks[2].url, tasks[2].cities.join(','), 1],
  ]);
  assert.deepEqual(events.slice(0, 2).map(({ type }) => type), ['ip', 'limits']);
  assert.equal(events[0].stats.public_ip, null);
  assert.equal(events[1].stats.public_ip, '203.0.113.10');
  assert.equal(events[1].stats.available_quota, null);
  assert.deepEqual(calls.map(({ stats }) => [stats.attempted_resources, stats.attempted_records]), [[1, 2], [2, 7], [2, 9], [3, 10]]);
  assert.deepEqual(JSON.parse(await readFile(statsFile, 'utf8')), {
    public_ip: '203.0.113.10', available_quota: 10, assigned_resources: 3, attempted_resources: 3, attempted_records: 10,
  });
  const results = (await readdir(join(root, 'results'))).filter((name) => name !== 'probe-stats.json');
  assert.equal(results.length, 2);
  for (const file of results) assert.equal(await readFile(join(root, 'results', file), 'utf8'), raw);
});

for (const quota of [0, 8]) {
  test(`quota ${quota} bounds attempts while allowing a partial resource in input order`, async (t) => {
    const { result, calls, statsFile } = await runTasks(t, { quota });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls.map(({ args }) => [args[1], args[args.indexOf('--from') + 1], Number(args[args.indexOf('--limit') + 1])]), quota === 0 ? [] : [
      [tasks[0].url, 'CN+Shanghai,JP+Tokyo', 2],
      [tasks[1].url, 'US+New York,US+Los Angeles,DE+Berlin,FR+Paris,GB+London', 5],
      [tasks[1].url, 'SG+Singapore', 1],
    ]);
    const stats = JSON.parse(await readFile(statsFile, 'utf8'));
    assert.equal(stats.attempted_resources, quota === 0 ? 0 : 2);
    assert.equal(stats.attempted_records, quota);
  });
}

for (const mode of ['ip-error', 'limits-error']) {
  test(`${mode} preserves partial statistics and sends no probes`, async (t) => {
    const { result, calls, statsFile } = await runTasks(t, { mode });
    assert.equal(result.status, 1);
    assert.deepEqual(calls, []);
    assert.deepEqual(JSON.parse(await readFile(statsFile, 'utf8')), {
      public_ip: mode === 'ip-error' ? null : '203.0.113.10', available_quota: null,
      assigned_resources: 3, attempted_resources: 0, attempted_records: 0,
    });
  });
}

test('rejects an invalid task before sending requests for earlier valid tasks', async (t) => {
  const { result, events } = await runTasks(t, { input: [tasks[0], { url: tasks[1].url, cities: ['Shanghai'] }] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cities array/);
  assert.deepEqual(events, []);
});
