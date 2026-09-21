import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const source = fileURLToPath(new URL('../', import.meta.url));
const publicIP = '203.0.113.10';
const raw = '{ "results": [{ "result": { "status": "failed" } }], "large": 9007199254740993 }\n';

async function runBatch(t, { mode = 'success', quota = 250, resourceCount = 2, cityCount = 7 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'globalping-stats-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'resources'));
  await mkdir(join(root, 'bin'));
  for (const file of ['probe-resource.mjs', 'probe-resource-batch.mjs', 'read-resource-hits.mjs']) {
    await cp(join(source, file), join(root, file));
  }
  const urls = Array.from({ length: resourceCount }, (_, i) => `https://example.com/resource-${i}.css`);
  const cities = Array.from({ length: cityCount }, (_, i) => `US+City ${i}`);
  await writeFile(join(root, 'resources/probe-batches.json'), JSON.stringify({ cities, batches: [{ id: 1, urls }] }));
  await writeFile(join(root, 'mock-ip.mjs'), `
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
globalThis.fetch = async (url) => {
  assert.equal(url, 'https://api.ipify.org?format=json');
  const stats = JSON.parse(readFileSync(process.env.STATS_FILE, 'utf8'));
  appendFileSync(process.env.CALL_LOG, JSON.stringify({ type: 'ip', stats }) + '\\n');
  if (process.env.CLI_MODE === 'ip-error') throw new Error('IP lookup failed');
  return new Response(JSON.stringify({ ip: '${publicIP}' }));
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
  } else if (process.env.CLI_MODE === 'limits-invalid') {
    console.log('Unexpected limits response');
  } else {
    const remaining = Number(process.env.QUOTA);
    console.log('Authentication: IP address\\n\\nCreating measurements:\\n - 250 tests per hour\\n - ' + (250 - remaining) + ' consumed, ' + remaining + ' remaining\\n - resets in 10 minutes');
  }
} else if (process.env.CLI_MODE === 'all-failed' || (process.env.CLI_MODE === 'mixed' && [7, 12].includes(stats.attempted_records))) {
  console.error('Quota exceeded or network failure');
  process.exitCode = 1;
} else if (process.env.CLI_MODE === 'mixed' && stats.attempted_records === 14) {
  console.log('invalid JSON');
} else {
  process.stdout.write(${JSON.stringify(raw)});
}
`, { mode: 0o755 });
  const statsFile = join(root, 'results/probe-stats.json');
  const log = join(root, 'calls.jsonl');
  const result = spawnSync(process.execPath, ['--import', join(root, 'mock-ip.mjs'), join(root, 'probe-resource-batch.mjs'), '1'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, STATS_FILE: statsFile,
      CALL_LOG: log, CLI_MODE: mode, QUOTA: String(quota) },
  });
  const events = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const stats = JSON.parse(await readFile(statsFile, 'utf8'));
  const calls = events.filter((event) => event.type === 'http');
  return { root, urls, cities, statsFile, result, events, stats, calls };
}

for (const mode of ['mixed', 'all-failed']) {
  test(`persists IP, quota, and attempted records before every CLI call (${mode})`, async (t) => {
    const { root, urls, cities, statsFile, result, events, stats, calls } = await runBatch(t, { mode });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(events.slice(0, 2).map((event) => event.type), ['ip', 'limits']);
    assert.equal(events[1].stats.public_ip, publicIP);
    assert.equal(events[1].stats.available_quota, null);
    assert.deepEqual(calls.map((call) => call.stats.attempted_records), [5, 7, 12, 14]);
    assert.deepEqual(calls.map((call) => call.stats.attempted_resources), [1, 1, 2, 2]);
    assert.deepEqual(calls.map((call) => Number(call.args[call.args.indexOf('--limit') + 1])), [5, 2, 5, 2]);
    assert.deepEqual(stats, { public_ip: publicIP, available_quota: 250, assigned_resources: 2, attempted_resources: 2, attempted_records: 14 });
    const records = (await readdir(join(root, 'results'))).filter((name) => name !== 'probe-stats.json');
    assert.equal(records.length, mode === 'mixed' ? 1 : 0);
    if (records.length) assert.equal(await readFile(join(root, 'results', records[0]), 'utf8'), raw);
    await mkdir(join(root, 'collected-results/round-1/probe-results-1'), { recursive: true });
    await cp(statsFile, join(root, 'collected-results/round-1/probe-results-1/probe-stats.json'));
    const { readResourceHits } = await import(pathToFileURL(join(root, 'read-resource-hits.mjs')));
    assert.deepEqual((await readResourceHits(urls, cities)).map((resource) => resource.hits.size), [0, 0]);
  });
}

test('220 remaining tests and 50 cities only permit the first four of five assigned resources', async (t) => {
  const { urls, result, stats, calls } = await runBatch(t, { quota: 220, cityCount: 50, resourceCount: 5 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(stats, { public_ip: publicIP, available_quota: 220, assigned_resources: 5, attempted_resources: 4, attempted_records: 200 });
  assert.deepEqual([...new Set(calls.map((call) => call.args[1]))], urls.slice(0, 4));
  assert.equal(calls.length, 40);
});

for (const quota of [0, 6]) {
  test(`saves zero actual probes and exits successfully when quota ${quota} cannot cover one resource`, async (t) => {
    const { result, stats, calls } = await runBatch(t, { quota });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(stats, { public_ip: publicIP, available_quota: quota, assigned_resources: 2, attempted_resources: 0, attempted_records: 0 });
    assert.equal(calls.length, 0);
  });
}

for (const mode of ['ip-error', 'limits-error', 'limits-invalid']) {
  test(`preserves partial statistics and does not assume a quota after ${mode}`, async (t) => {
    const { result, stats, calls } = await runBatch(t, { mode });
    assert.equal(result.status, 1);
    assert.deepEqual(stats, { public_ip: mode === 'ip-error' ? null : publicIP, available_quota: null, assigned_resources: 2, attempted_resources: 0, attempted_records: 0 });
    assert.equal(calls.length, 0);
  });
}
