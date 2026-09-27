import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { analyzeProbeResults } from '../analyze-probe-results.mjs';
import { readTaskPlans } from '../probe-state.mjs';
import { readJson } from '../read-probe-results.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const urls = ['https://example.com/a.css', 'https://example.com/b.js'];
const cities = ['CN+Shanghai', 'JP+Tokyo'];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'globalping-plan-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probe = join(root, 'probe');
  const save = async (file, value) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value, null, 2) + '\n');
  };
  await mkdir(join(probe, 'resources'), { recursive: true });
  await mkdir(join(root, 'bin'));
  for (const file of (await readdir(source)).filter((file) => file.endsWith('.mjs'))) await cp(join(source, file), join(probe, file));
  await cp(join(source, 'plans'), join(probe, 'plans'), { recursive: true });
  await save(join(root, 'cities/CN-main.json'), cities);
  await save(join(root, 'cities/CN-aroung.json'), [cities[0]]);
  await save(join(root, 'cities/global-main.json'), ['SG+Singapore', cities[1]]);
  await save(join(root, 'inventory.json'), { resources: urls.map((url) => ({ url })) });
  const mockFetch = join(root, 'mock-fetch.mjs');
  await writeFile(mockFetch, `import { readFile } from 'node:fs/promises';
globalThis.fetch = async (url) => {
  if (url === 'https://api.ipify.org?format=json') return new Response('{"ip":"203.0.113.10"}');
  if (url === 'https://sshawn9.com/resource-inventory.json') return new Response(await readFile(process.env.INVENTORY_FILE));
  throw new Error('Unexpected request: ' + url);
};`);
  await writeFile(join(root, 'bin/gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'run' || args[1] !== 'download' || !/^\\d+$/.test(args[2]) || args[4] !== 'probe-state') process.exit(2);
fs.cpSync(process.env.SOURCE_STATE, args[6], { recursive: true });
`, { mode: 0o755 });
  await writeFile(join(root, 'bin/globalping-cli'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'limits') {
  console.log('Creating measurements:\\n - 250 tests per hour\\n - 0 consumed, ' + process.env.PROBE_QUOTA + ' remaining');
} else {
  const url = new URL(args[1]);
  const replies = JSON.parse(process.env.RESPONSES);
  const cities = args[args.indexOf('--from') + 1].split(',');
  console.log(JSON.stringify({ target: url.hostname,
    measurementOptions: { protocol: 'HTTPS', request: { path: url.pathname, query: url.search.slice(1) } },
    results: cities.map((location) => {
      const [country, city] = location.split('+');
      const [statusCode, cache] = replies[url.href]?.[location] ?? [200, 'MISS'];
      return { probe: { country, city }, result: { statusCode, headers: { 'CF-Cache-Status': cache } } };
    }),
  }));
}
`, { mode: 0o755 });
  const execute = (file, args, env) => execFileSync(process.execPath, ['--import', mockFetch, join(probe, file), ...args], {
    cwd: root, stdio: 'pipe', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      INVENTORY_FILE: join(root, 'inventory.json'), ...env },
  });
  const readOutputs = async (file) => Object.fromEntries((await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  let run = 0;
  const prepare = async ({ state, start = !state, settings = {}, scheduled = false, request = {} } = {}) => {
    const directory = join(root, `run-${++run}`);
    await mkdir(directory);
    const output = join(directory, 'prepare-output');
    await writeFile(output, '');
    const destination = join(directory, 'prepared-state');
    execute('prepare-probe-plan.mjs', [destination], {
      SOURCE_STATE: state ?? '', GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: scheduled ? 'schedule' : 'workflow_dispatch',
      PROBE_REQUEST: JSON.stringify({ state_run_id: state ? String(run) : '', definition: start ? 'probe/plans/globalping.mjs' : '', settings: JSON.stringify(settings), ...request }),
    });
    const outputs = await readOutputs(output);
    const tasks = (await Promise.all(JSON.parse(outputs.matrix).batch.map((id) =>
      readJson(join(destination, 'tasks', `round-${outputs.round}`, `batch-${id}.json`))))).flat();
    return { directory, state: destination, outputs, tasks };
  };
  const perform = async (prepared, responses = {}, quota = 250) => {
    const results = join(prepared.directory, 'results');
    const batches = JSON.parse(prepared.outputs.matrix).batch;
    for (const id of batches) {
      await rm(join(probe, 'results'), { recursive: true, force: true });
      execute('execute-probe-tasks.mjs', [join(prepared.state, 'tasks', `round-${prepared.outputs.round}`, `batch-${id}.json`)], {
        RESPONSES: JSON.stringify(responses), PROBE_QUOTA: String(quota),
      });
      await cp(join(probe, 'results'), batches.length === 1 ? results : join(results, `probe-results-${id}`), { recursive: true });
    }
    return results;
  };
  const finish = async (prepared, results = join(root, 'no-results')) => {
    const state = join(prepared.directory, 'finished-state');
    await cp(prepared.state, state, { recursive: true });
    const output = join(prepared.directory, 'finish-output');
    await writeFile(output, '');
    execute('finish-probe-plan.mjs', [state, results, join(prepared.directory, 'report')], {
      PROBE_ROUND: prepared.outputs.round, GITHUB_OUTPUT: output,
    });
    return { state, outputs: await readOutputs(output), report: await analyzeProbeResults(state) };
  };
  return { root, probe, save, prepare, perform, finish, execute, readOutputs };
}

test('new and scheduled tasks normalize inputs, fetch current resources, and deduplicate cities', async (t) => {
  const f = await fixture(t);
  await f.save(join(f.root, 'inventory.json'), { resources: [urls[0], urls[0], 'https://EXAMPLE.com/b.js'].map((url) => ({ url })) });
  const first = await f.prepare({ settings: { max_rounds: '2', max_parallel: '7', 'CN-main': 'false', 'global-main': true } });
  assert.deepEqual(first.tasks, urls.map((url) => ({ url, cities: ['SG+Singapore', cities[1]] })));
  assert.equal(first.outputs.max_parallel, '7');
  const flow = await readJson(join(first.state, 'flow.json'));
  assert.deepEqual(flow.steps, ['pending-pairs', 'pending-pairs', 'analyze']);
  const scheduled = await f.prepare({ scheduled: true });
  assert.deepEqual(scheduled.tasks, urls.map((url) => ({ url, cities: [...cities, 'SG+Singapore'] })));
  assert.equal(scheduled.outputs.max_parallel, '12');
  const files = await readdir(join(first.state, 'resources'));
  assert.equal(files.length, 1);
  assert.deepEqual(await readFile(join(first.state, 'resources', files[0])), await readFile(join(f.root, 'inventory.json')));
  await assert.rejects(f.prepare({ settings: { max_rounds: true } }), /max_rounds must/);
  await assert.rejects(f.prepare({ request: { state_run_id: 'state_run_id=123' } }), /Run ID digits/);
});

test('uses the caller\'s task definition and continues its saved plan without reloading the definition', async (t) => {
  const f = await fixture(t);
  let prepared = await f.prepare({ settings: { max_rounds: 1 } });
  let result = await f.finish(prepared, await f.perform(prepared, { [urls[0]]: { [cities[0]]: [200, 'HIT'] } }, 1));
  const definition = join(f.probe, 'plans/intermediate.mjs');
  await writeFile(definition, `export default () => ({
    'CN-main': true, max_parallel: 3, steps: ['pending-pairs', 'analyze', 'pending-pairs', 'analyze'],
  });`);
  const previous = await readFile(join(result.state, 'rounds/round-1.json'));
  prepared = await f.prepare({ state: result.state, start: true, request: { definition: 'probe/plans/intermediate.mjs' } });
  assert.deepEqual(prepared.tasks, [{ url: urls[0], cities: [cities[1]] }, { url: urls[1], cities }]);
  assert.equal(prepared.outputs.max_parallel, '3');
  result = await f.finish(prepared, await f.perform(prepared, {
    [urls[0]]: { [cities[1]]: [200, 'HIT'] },
    [urls[1]]: { [cities[0]]: [200, 'HIT'], [cities[1]]: [404, 'HIT'] },
  }));
  assert.equal(result.outputs.analyzed, 'true');
  assert.equal(result.outputs.continue, 'true');
  assert.equal(result.report.overview.attemptedRecords, 4);
  assert.equal(result.report.overview.hitCityPairs, 3);
  assert.match(await readFile(join(prepared.directory, 'report/probe-summary.md'), 'utf8'), /3\/4 \(75\.00%\)/);
  await rm(definition);
  prepared = await f.prepare({ state: result.state });
  assert.deepEqual(prepared.tasks, [{ url: urls[1], cities: [cities[1]] }]);
  result = await f.finish(prepared, await f.perform(prepared, { [urls[1]]: { [cities[1]]: [200, 'HIT'] } }));
  assert.equal(result.outputs.continue, 'false');
  assert.equal(result.report.overview.attemptedRecords, 5);
  assert.equal(result.report.overview.hitRecords, 4);
  assert.equal(result.report.overview.hitCityPairs, 4);
  assert.deepEqual(await readFile(join(result.state, 'rounds/round-1.json')), previous);
});

test('actual quota carries partial resources into later tasks; automatic continuation keeps targets and settings', async (t) => {
  const f = await fixture(t);
  let prepared = await f.prepare({ settings: { max_rounds: 5, max_parallel: 4 } });
  const targets = await readFile(join(prepared.state, 'targets.json'));
  const replies = Object.fromEntries(urls.map((url) => [url, Object.fromEntries(cities.map((city) => [city, [200, 'HIT']]))]));
  let result = await f.finish(prepared, await f.perform(prepared, replies, 1));
  assert.equal(result.outputs.analyzed, undefined);
  assert.equal(result.report.overview.attemptedRecords, 1);
  await f.save(join(f.root, 'inventory.json'), { resources: [{ url: 'https://example.com/new.css' }] });
  await f.save(join(f.root, 'cities/CN-main.json'), ['CN+Beijing']);
  prepared = await f.prepare({ state: result.state, settings: { max_parallel: 99, max_rounds: 1 } });
  assert.deepEqual(prepared.tasks, [{ url: urls[0], cities: [cities[1]] }, { url: urls[1], cities }]);
  assert.equal(prepared.outputs.max_parallel, '4');
  result = await f.finish(prepared, await f.perform(prepared, replies));
  assert.equal(result.outputs.continue, 'false');
  assert.equal(result.outputs.analyzed, 'true');
  assert.equal(result.report.overview.attemptedRecords, 4);
  assert.deepEqual((await readTaskPlans(result.state)).map(({ round }) => round), [1, 2]);
  assert.deepEqual(await readFile(join(result.state, 'targets.json')), targets);
  await f.save(join(result.state, '.extra/settings.json'), { keep: true });
  const fresh = await f.prepare({ state: result.state, start: true, settings: { max_rounds: 1 } });
  assert.deepEqual(fresh.tasks, [{ url: 'https://example.com/new.css', cities: ['CN+Beijing'] }]);
  assert.equal(fresh.outputs.round, '3');
  assert.equal((await readJson(join(fresh.state, 'flow.json'))).position, 0);
  assert.equal((await readdir(join(fresh.state, 'resources'))).length, 2);
  assert.deepEqual(await readJson(join(fresh.state, '.extra/settings.json')), { keep: true });
});

test('the configured attempt limit stops a plan with misses and keeps all rounds in its final report', async (t) => {
  const f = await fixture(t);
  let prepared = await f.prepare({ settings: { max_rounds: 2 } });
  let result = await f.finish(prepared, await f.perform(prepared));
  assert.equal(result.outputs.continue, 'true');
  prepared = await f.prepare({ state: result.state });
  result = await f.finish(prepared, await f.perform(prepared));
  assert.equal(result.outputs.continue, 'false');
  assert.equal(result.outputs.analyzed, 'true');
  assert.equal(result.report.overview.attemptedRecords, 8);
  assert.equal(result.report.overview.hitRecords, 0);
  assert.equal(result.report.overview.roundCount, 2);
});

test('already covered targets skip all probe tasks without making empty round records', async (t) => {
  const f = await fixture(t);
  let prepared = await f.prepare();
  const replies = Object.fromEntries(urls.map((url) => [url, Object.fromEntries(cities.map((city) => [city, [200, 'HIT']]))]));
  let result = await f.finish(prepared, await f.perform(prepared, replies));
  prepared = await f.prepare({ state: result.state, start: true });
  assert.equal(prepared.outputs.has_work, 'false');
  assert.equal(prepared.outputs.round, '0');
  result = await f.finish(prepared);
  assert.equal(result.outputs.analyzed, 'true');
  assert.equal(result.outputs.continue, 'false');
  assert.equal(result.report.overview.roundCount, 1);
  assert.equal(result.report.overview.attemptedRecords, 4);
});

test('failed analysis leaves a saved checkpoint that resumes analysis without repeating probes', async (t) => {
  const f = await fixture(t);
  let prepared = await f.prepare({ settings: { max_rounds: 1 } });
  const results = await f.perform(prepared);
  await writeFile(join(f.probe, 'summarize-probe-results.mjs'),
    'export async function summarizeProbeResults() { throw new Error("Report storage unavailable"); }');
  await assert.rejects(f.finish(prepared, results), /Report storage unavailable/);
  const saved = join(prepared.directory, 'finished-state');
  assert.deepEqual(await f.readOutputs(join(prepared.directory, 'finish-output')), { state_ready: 'true' });
  assert.equal((await readJson(join(saved, 'flow.json'))).position, 1);
  assert.equal((await analyzeProbeResults(saved)).overview.attemptedRecords, 4);
  await cp(join(source, 'summarize-probe-results.mjs'), join(f.probe, 'summarize-probe-results.mjs'));
  prepared = await f.prepare({ state: saved });
  assert.equal(prepared.outputs.has_work, 'false');
  const result = await f.finish(prepared);
  assert.equal(result.outputs.analyzed, 'true');
  assert.equal(result.outputs.continue, 'false');
  assert.equal(result.report.overview.roundCount, 1);
  assert.equal(result.report.overview.attemptedRecords, 4);
});

test('multiple runners pack at 250, keep separate records, and consume only their actual quota', async (t) => {
  const f = await fixture(t);
  const resources = Array.from({ length: 126 }, (_, i) => `https://example.com/${i}.css`);
  await f.save(join(f.root, 'inventory.json'), { resources: resources.map((url) => ({ url })) });
  let prepared = await f.prepare();
  const [plan] = await readTaskPlans(prepared.state);
  assert.deepEqual(plan.batches.map(({ urls }) => urls.length), [125, 1]);
  const replies = Object.fromEntries([resources[0], resources.at(-1)].map((url) => [url, { [cities[0]]: [200, 'HIT'] }]));
  const results = await f.perform(prepared, replies, 1);
  let result = await f.finish(prepared, results);
  for (const { id } of plan.batches) {
    assert.deepEqual(await readFile(join(result.state, 'collected-results/round-1', `probe-results-${id}`, 'probe-stats.json')),
      await readFile(join(results, `probe-results-${id}`, 'probe-stats.json')));
  }
  assert.equal(result.report.overview.attemptedRecords, 2);
  assert.equal(result.report.overview.hitCityPairs, 2);
  prepared = await f.prepare({ state: result.state });
  assert.equal(JSON.parse(prepared.outputs.matrix).batch.length, 1);
  assert.equal(prepared.tasks.reduce((n, { cities }) => n + cities.length, 0), 250);
  result = await f.finish(prepared, await f.perform(prepared, {}, 0));
  assert.equal(result.report.overview.attemptedRecords, 2);
  assert.equal(result.report.overview.hitCityPairs, 2);
  assert.equal(result.outputs.continue, 'true');
});
