import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { analyzeProbeResults } from '../analyze-probe-results.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const urls = ['https://example.com/a.css?v=1', 'https://example.com/a.css?v=2', 'https://example.com/missing.js'];
const cities = ['CN+Shanghai', 'JP+Tokyo'];
const inputs = { 'CN-main': true, 'CN-aroung': false, 'global-main': false, max_parallel: '12', max_rounds: '5' };

async function fixture(t, previous) {
  const root = await mkdtemp(join(tmpdir(), 'globalping-round-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probe = join(root, 'probe');
  await mkdir(join(probe, 'resources'), { recursive: true });
  await mkdir(join(root, 'cities'));
  for (const file of (await readdir(source)).filter((file) => file.endsWith('.mjs'))) {
    await cp(join(source, file), join(probe, file));
  }
  if (previous) {
    await cp(join(previous, 'resources'), join(probe, 'resources'), { recursive: true });
    await cp(join(previous, 'rounds'), join(probe, 'rounds'), { recursive: true });
    await cp(join(previous, 'collected-results'), join(probe, 'collected-results'), { recursive: true });
  }
  await writeFile(join(root, 'cities/CN-main.json'), JSON.stringify(cities));
  await writeFile(join(probe, 'resources/urls.json'), JSON.stringify(urls));
  const plan = async () => JSON.parse(await readFile(join(probe, 'resources/probe-batches.json'), 'utf8'));
  async function run(script, request = inputs) {
    const output = join(root, 'outputs');
    await writeFile(output, '');
    execFileSync(process.execPath, [join(probe, script)], {
      cwd: root,
      env: { ...process.env, PROBE_INPUTS: JSON.stringify(request), GITHUB_OUTPUT: output,
        GITHUB_RUN_ID: '12345', GITHUB_REF_NAME: 'main', GITHUB_STEP_SUMMARY: join(root, 'summary.md') },
      stdio: 'pipe',
    });
    return Object.fromEntries((await readFile(output, 'utf8')).trim().split('\n').filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  }
  async function result(round, resource, statuses) {
    const url = new URL(urls[resource]);
    const directory = join(probe, 'collected-results', `round-${round}`, 'probe-results-1');
    await mkdir(directory, { recursive: true });
    const file = join(directory, `${resource}.json`);
    const data = {
      target: url.hostname,
      measurementOptions: { protocol: 'HTTPS', request: { path: url.pathname, query: url.search.slice(1) } },
      results: statuses.map(([city, statusCode, cacheStatus]) => ({
        probe: { country: city.split('+')[0], city: city.split('+')[1] },
        result: { status: statusCode ? 'finished' : 'failed', statusCode, headers: { 'CF-Cache-Status': cacheStatus } },
      })),
    };
    await writeFile(file, JSON.stringify(data, null, 2) + '\n');
    return file;
  }
  return { root, probe, plan, run, result };
}

test('accumulates HITs across fresh runners, skips complete resources, and summarizes every round', async (t) => {
  const first = await fixture(t);
  const initial = await first.run('prepare-probe-batches.mjs');
  assert.equal(initial.round, '1');
  assert.equal(initial.max_parallel, '12');
  assert.equal(initial.has_work, 'true');
  assert.deepEqual((await first.plan()).batches.flatMap((batch) => batch.urls), urls);
  const original = await first.result(1, 0, cities.map((city) => [city, 200, 'HIT']));
  const originalBytes = await readFile(original);
  await first.result(1, 1, [[cities[0], 200, 'HIT'], [cities[0], 200, 'HIT'], [cities[1], 404, 'HIT']]);
  const continuation = await first.run('complete-probe-round.mjs');
  assert.equal(continuation.continue, 'true');
  const dispatch = JSON.parse(continuation.next_round);
  // The dispatch API expects numeric inputs as strings, despite their workflow type.
  assert.deepEqual(dispatch, { ref: 'main', inputs: { ...inputs, previous_run_id: '12345' } });
  assert.equal((await first.plan()).inputs.max_parallel, 12);
  assert.equal((await first.plan()).inputs.max_rounds, 5);
  await assert.rejects(readFile(join(first.probe, 'probe-summary.md')), { code: 'ENOENT' });

  const second = await fixture(t, first.probe);
  const next = await second.run('prepare-probe-batches.mjs', dispatch.inputs);
  const nextPlan = await second.plan();
  assert.equal(next.round, '2');
  assert.equal(next.max_parallel, '12');
  assert.equal(nextPlan.inputs.max_rounds, 5);
  assert.deepEqual(nextPlan.urls, urls);
  assert.deepEqual(nextPlan.cities, cities);
  assert.deepEqual(nextPlan.batches.flatMap((batch) => batch.urls), urls.slice(1));
  await second.result(2, 1, [[cities[0], 200, 'MISS'], [cities[1], 200, 'HIT']]);
  await second.result(2, 2, cities.map((city) => [city, 200, 'HIT']));
  const done = await second.run('complete-probe-round.mjs');
  assert.equal(done.continue, 'false');
  assert.equal(done.next_round, undefined);
  await second.run('summarize-probe-results.mjs');
  const summary = await readFile(join(second.probe, 'probe-summary.md'), 'utf8');
  assert.match(summary, /Cities \/ selected groups \| 2 \//);
  assert.match(summary, /6\/6 \(100\.00%\)/);
  assert.match(summary, /MISS by city\n\nAll resources hit/);
  assert.match(summary, /MISS by resource\n\nAll cities hit/);
  assert.deepEqual(await readFile(join(second.probe, 'collected-results/round-1/probe-results-1/0.json')), originalBytes);
  assert.deepEqual(await readdir(join(second.probe, 'collected-results')), ['round-1', 'round-2']);

  const empty = await second.run('prepare-probe-batches.mjs', dispatch.inputs);
  assert.equal(empty.has_work, 'false');
  assert.deepEqual(JSON.parse(empty.matrix), { batch: [] });
  assert.equal((await second.run('complete-probe-round.mjs')).continue, 'false');
});

test('stops at the round limit while preserving failed and missing pairs in the final denominator', async (t) => {
  const state = await fixture(t);
  await state.run('prepare-probe-batches.mjs', { ...inputs, max_rounds: '2' });
  await state.result(1, 0, [[cities[0], 200, 'HIT'], [cities[1], 404, 'HIT']]);
  await state.result(1, 1, [[cities[0], 304, 'HIT'], [cities[1], null, null]]);
  const next = JSON.parse((await state.run('complete-probe-round.mjs')).next_round).inputs;
  await state.run('prepare-probe-batches.mjs', next);
  await state.result(2, 0, [[cities[0], 500, 'HIT'], [cities[1], 200, 'MISS']]);
  assert.equal((await state.run('complete-probe-round.mjs')).continue, 'false');
  await state.run('summarize-probe-results.mjs');
  const summary = await readFile(join(state.probe, 'probe-summary.md'), 'utf8');
  assert.match(summary, /1\/6 \(16\.67%\)/);
  assert.match(summary, /\| CN\+Shanghai \| 2\/3 \|/);
  await assert.rejects(state.run('prepare-probe-batches.mjs', next), /maximum number of rounds/);
});

test('validates round inputs and fails if continuation state is unavailable', async (t) => {
  const state = await fixture(t);
  for (const max_rounds of ['0', '-1', '1.5', '', 'invalid']) {
    await assert.rejects(state.run('prepare-probe-batches.mjs', { ...inputs, max_rounds }), /max_rounds must/);
  }
  await assert.rejects(state.run('prepare-probe-batches.mjs', { ...inputs, previous_run_id: '999' }), /ENOENT/);
  await assert.rejects(state.run('prepare-probe-batches.mjs', { ...inputs, history_run_id: '999' }), /ENOENT/);
  await assert.rejects(state.run('prepare-probe-batches.mjs', { ...inputs, previous_run_id: '999', history_run_id: '888' }), /Set only one/);
  await state.run('prepare-probe-batches.mjs', { ...inputs, max_rounds: '1' });
  assert.equal((await state.run('complete-probe-round.mjs')).continue, 'false');
});

test('prepares resource batches using a 250-test budget', async (t) => {
  const state = await fixture(t);
  const inventory = Array.from({ length: 126 }, (_, i) => `https://example.com/${i}.css`);
  await writeFile(join(state.probe, 'resources/urls.json'), JSON.stringify(inventory));
  await state.run('prepare-probe-batches.mjs');
  const plan = await state.plan();
  assert.deepEqual(plan.batches.map((batch) => batch.urls.length), [125, 1]);
  assert.deepEqual(plan.batches.flatMap((batch) => batch.urls), inventory);
});

test('adds rounds to imported progress once and keeps all previous results and counters', async (t) => {
  const saveStats = async (state, attempts) => {
    const plan = await state.plan();
    const directory = join(state.probe, 'collected-results', `round-${plan.round}`, 'probe-results-1');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'probe-stats.json'), JSON.stringify({
      round: plan.round, batch_id: 1, attempted_resources: plan.batches[0].urls.length,
      attempted_records: attempts,
    }));
  };

  const first = await fixture(t);
  await first.run('prepare-probe-batches.mjs');
  await first.result(1, 0, cities.map((city) => [city, 200, 'HIT']));
  await saveStats(first, 6);
  const next = JSON.parse((await first.run('complete-probe-round.mjs')).next_round).inputs;
  const second = await fixture(t, first.probe);
  await second.run('prepare-probe-batches.mjs', next);
  await second.result(2, 1, [[cities[0], 200, 'HIT'], [cities[1], 200, 'MISS']]);
  await saveStats(second, 4);
  await second.run('complete-probe-round.mjs');

  // Import after two rounds of a five-round plan: two more rounds end at four, not seven.
  const imported = await fixture(t, second.probe);
  const request = { ...inputs, history_run_id: '111', max_rounds: '2', max_parallel: '7' };
  const start = await imported.run('prepare-probe-batches.mjs', request);
  const plan = await imported.plan();
  assert.equal(start.round, '3');
  assert.equal(start.max_parallel, '7');
  assert.equal(plan.inputs.max_rounds, 4);
  assert.deepEqual(plan.batches.flatMap((batch) => batch.urls), urls.slice(1));
  await imported.result(3, 1, [[cities[0], 200, 'MISS'], [cities[1], 200, 'HIT']]);
  await saveStats(imported, 4);
  const continuation = JSON.parse((await imported.run('complete-probe-round.mjs')).next_round).inputs;
  assert.equal(continuation.max_rounds, '4');
  assert.equal(continuation.previous_run_id, '12345');
  assert.equal(continuation.history_run_id, undefined);

  const last = await fixture(t, imported.probe);
  assert.equal((await last.run('prepare-probe-batches.mjs', continuation)).round, '4');
  assert.equal((await last.plan()).inputs.max_rounds, 4);
  assert.deepEqual((await last.plan()).batches.flatMap((batch) => batch.urls), [urls[2]]);
  // The last resource still has no result; the fixed round limit must stop the task.
  await saveStats(last, 2);
  assert.equal((await last.run('complete-probe-round.mjs')).continue, 'false');
  const report = await analyzeProbeResults(pathToFileURL(`${last.probe}/`));
  assert.equal(report.overview.roundCount, 4);
  assert.equal(report.overview.maxRounds, 4);
  assert.equal(report.overview.attemptedRecords, 16);
  assert.equal(report.overview.hitRecords, 4);
  assert.equal(report.overview.hitCityPairs, 4);
  assert.equal(report.overview.totalCityPairs, 6);
  assert.deepEqual(report.runners.map((r) => [r.id, r.attemptedRecords, r.hitRecords]),
    [['1/1', 6, 2], ['2/1', 4, 1], ['3/1', 4, 1], ['4/1', 2, 0]]);
});
