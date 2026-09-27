import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { analyzeProbeResults, timingSummary } from '../analyze-probe-results.mjs';
import { renderProbeSummary } from '../summarize-probe-results.mjs';
import { writeTaskPlan } from '../probe-state.mjs';

const A = 'https://example.com/shared.css?v=1';
const B = 'https://example.com/shared.css?v=2';
const C = 'https://example.com/failed.js';
const D = 'https://example.com/new.js';
const SH = 'CN+Shanghai';
const TK = 'JP+Tokyo';
const SG = 'SG+Singapore';
const components = [
  { id: 'asia', name: 'Asia', group: true },
  { name: 'Tokyo, Japan - (NRT)', group_id: 'asia' },
  { name: 'Singapore, Singapore -\u00a0(SIN)', group_id: 'asia' },
  { name: 'Hong Kong - (HKG)', group_id: 'asia' },
];

function record(city, asn, statusCode, cache, colo, total = null, firstByte = null) {
  const [country, name] = city.split('+');
  return { probe: { country, city: name, asn, network: `Network ${asn}` }, result: {
    status: statusCode ? 'finished' : 'failed', statusCode,
    headers: { 'cF-cAcHe-StAtUs': [cache], ...(colo ? { 'CF-Ray': `abcd-${colo}` } : {}) },
    timings: { total, firstByte },
  } };
}

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), 'globalping-analysis-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const directory = pathToFileURL(`${path}/`);
  const save = async (name, value) => {
    const file = join(path, name);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify(value, null, 2) + '\n');
    return file;
  };
  const runnerPath = (round, batch) => `collected-results/round-${round}/probe-results-${batch}`;
  return { path, directory, save,
    targets: (urls, cities) => save('targets.json', urls.map((url) => ({ url, cities }))),
    plan: (round, urls, cities, batches) => save(`rounds/round-${round}.json`, { strategy: 'pending-pairs', round,
      targets: urls.map((url) => ({ url, cities })),
      batches: batches.map((urls, index) => ({ id: index + 1, urls, tasks_file: `tasks/round-${round}/batch-${index + 1}.json` })) }),
    stats: (round, batch, assigned, attemptedResources, attemptedRecords, { quota = 250 } = {}) => save(
      `${runnerPath(round, batch)}/probe-stats.json`, { public_ip: '203.0.113.10', available_quota: quota, assigned_resources: assigned,
        attempted_resources: attemptedResources, attempted_records: attemptedRecords }),
    result: (round, batch, name, url, results) => {
      const target = new URL(url);
      return save(`${runnerPath(round, batch)}/${name}.json`, {
        target: target.hostname, measurementOptions: { protocol: 'HTTPS',
          request: { path: target.pathname, query: target.search.slice(1) } }, results,
      });
    },
  };
}

async function multipleRounds(t) {
  const f = await fixture(t);
  const cities = [SH, TK, SG];
  await f.targets([A, B, D], cities);
  await f.plan(1, [A, B, C], cities, [[A, B, C]]);
  await f.stats(1, 1, 3, 3, 9);
  await f.result(1, 1, 'a', A, [record(SH, 1, 200, 'HIT', 'NRT', 10, 1), record(TK, 1, 200, 'MISS', 'NRT', 20, 2), record(SG, 3, 200, 'MISS', 'SIN', 30, 3)]);
  await f.result(1, 1, 'b', B, [record(SH, 1, 404, 'HIT', 'LAX', 40, 4), record(TK, 1, null, null, null, -1, null), record(SG, 3, 200, 'HIT', 'SIN', 50, 5)]);
  // C's CLI call failed without JSON; all three attempts were recorded.
  // The next deployment removes C and adds D. A and B still need probing.
  await f.plan(2, [A, B, D], cities, [[A, B, D]]);
  // A and B use six attempts; D is assigned but never attempted.
  await f.stats(2, 1, 3, 2, 6, { quota: 8 });
  await f.result(2, 1, 'a', A, [record(SH, 1, 200, 'hit', 'NRT', 60, 6), record(TK, 1, 200, 'HIT', 'NRT', 70, 7), record(SG, 3, 200, 'HIT', 'SIN', 80, 8)]);
  await f.result(2, 1, 'b', B, [record(SH, 9, 200, 'HIT', 'ZZZ', 90, 9), record(TK, 1, 200, 'HIT', 'NRT', 100, 10), record(SG, 3, 200, 'MISS', 'SIN', 110, 11)]);
  return f;
}

test('counts repeated HIT records and failed attempts while excluding retired targets', async (t) => {
  const f = await multipleRounds(t);
  const report = await analyzeProbeResults(f.directory);
  assert.equal(report.overview.resourceCount, 3);
  assert.equal(report.overview.cityCount, 3);
  assert.equal(report.overview.attemptedResources, 2);
  assert.equal(report.overview.attemptedRecords, 15);
  assert.equal(report.overview.hitRecords, 7);
  assert.equal(report.overview.hitCityPairs, 6);
  assert.equal(report.overview.totalCityPairs, 9);
  assert.deepEqual(report.rounds.map((r) => [r.attemptedResources, r.attemptedRecords, r.newCityPairs, r.newColoPairs, r.cumulativeCityPairs]),
    [[3, 9, 2, 2, 2], [2, 6, 4, 3, 6]]);
  assert.deepEqual(report.runners.map((r) => [r.id, r.attemptedRecords, r.hitRecords]), [['1/1', 9, 2], ['2/1', 6, 5]]);
  assert.deepEqual(report.resources.find((r) => r.url === A).misses, []);
  // The later MISS in Singapore must not erase B's first-round HIT.
  assert.deepEqual(report.resources.find((r) => r.url === B).misses, []);
  assert.equal(report.resources.some((r) => r.url === C), false);
  assert.deepEqual(report.resources.find((r) => r.url === D).misses, [SH, TK, SG]);
  assert.deepEqual(report.cities.map((c) => [c.city, c.misses.length]), [[SH, 1], [TK, 1], [SG, 1]]);
});

test('groups by city and ASN, excludes invalid timings, and only lists reached colos', async (t) => {
  const f = await multipleRounds(t);
  const report = await analyzeProbeResults(f.directory);
  // Same ASN in different cities and different ASNs in the same city remain separate.
  assert.deepEqual(report.sources.map((s) => [s.city, s.asn, s.records, s.hits]).sort(),
    [[SH, 1, 3, 2], [SH, 9, 1, 1], [TK, 1, 4, 2], [SG, 3, 4, 2]].sort());
  const shanghai = report.sources.find((s) => s.city === SH && s.asn === 1);
  assert.deepEqual(shanghai.total, { n: 3, p50: 40, p95: 60 });
  assert.deepEqual(shanghai.firstByte, { n: 3, p50: 4, p95: 6 });
  assert.deepEqual(shanghai.colos, ['LAX', 'NRT']);
  const tokyo = report.sources.find((s) => s.city === TK);
  assert.deepEqual(tokyo.total, { n: 3, p50: 70, p95: 100 });
  const nrt = report.colos.find((c) => c.code === 'NRT');
  assert.deepEqual([nrt.resources, nrt.hits, nrt.cities], [2, 2, [SH, TK]]);
  const sourceById = new Map(report.sources.map((s) => [s.id, s]));
  assert.deepEqual(nrt.sources.map((id) => {
    const source = sourceById.get(id);
    return [source.city, source.asn];
  }).sort(), [[SH, 1], [TK, 1]].sort());
  assert.equal(report.colos.find((c) => c.code === 'LAX').hits, 0);
  const sections = renderProbeSummary(report, components);
  assert.match(sections.colos, /Tokyo, Japan \/ Asia/);
  assert.match(sections.colos, /Singapore, Singapore \/ Asia/);
  assert.match(sections.colos, /ZZZ \| — \/ —/);
  assert.doesNotMatch(sections.colos, /HKG/);
  assert.match(sections.rounds, /22\.22 \/ 22\.22/);
  assert.match(sections.rounds, /66\.67 \/ 50\.00/);
  assert.doesNotMatch(sections['missing-resources'], /shared\.css\?v=[12]/);
});

test('a runner with no quota contributes zero attempts and leaves its resource uncovered', async (t) => {
  const f = await fixture(t);
  await f.targets([A], [SH]);
  await f.plan(1, [A], [SH], [[A]]);
  await f.stats(1, 1, 1, 0, 0, { quota: 0 });
  const report = await analyzeProbeResults(f.directory);
  assert.equal(report.overview.attemptedResources, 0);
  assert.equal(report.overview.attemptedRecords, 0);
  assert.equal(report.overview.hitCityPairs, 0);
  assert.equal(report.overview.coloCount, 0);
  assert.equal(report.sources.length, 0);
  assert.deepEqual(report.resources[0].misses, [SH]);
  assert.match(renderProbeSummary(report).overview, /0\/0 \(—\)/);
});

test('computes median and nearest-rank P95 using only finite nonnegative samples', () => {
  assert.deepEqual(timingSummary([null, undefined, NaN, -1, Infinity]), { n: 0, p50: null, p95: null });
  assert.deepEqual(timingSummary([null, 0, -1]), { n: 1, p50: 0, p95: 0 });
  assert.deepEqual(timingSummary(Array.from({ length: 20 }, (_, i) => i + 1)), { n: 20, p50: 10.5, p95: 19 });
});

test('analyzes an external state without modifying it and writes Markdown even when location lookup fails', async (t) => {
  const f = await multipleRounds(t);
  const app = await fixture(t);
  const snapshot = async () => Promise.all((await readdir(f.path, { recursive: true })).filter((file) => file.endsWith('.json')).sort()
    .map(async (file) => [file, await readFile(join(f.path, file))]));
  const original = await snapshot();
  const source = fileURLToPath(new URL('../', import.meta.url));
  for (const file of (await readdir(source)).filter((file) => file.endsWith('.mjs'))) await cp(join(source, file), join(app.path, file));
  const rawLocations = JSON.stringify({ components });
  const mock = join(app.path, 'mock-fetch.mjs');
  await writeFile(mock, `globalThis.fetch = async (url) => {
    if (url !== 'https://www.cloudflarestatus.com/api/v2/components.json') throw new Error('Unexpected request');
    return new Response(${JSON.stringify(rawLocations)});
  };`);
  const command = ['--import', mock, join(app.path, 'summarize-probe-results.mjs'), f.path];
  execFileSync(process.execPath, command, { stdio: 'pipe' });
  assert.equal(await readFile(join(app.path, 'resources/cloudflare-components.json'), 'utf8'), rawLocations);
  const full = await readFile(join(app.path, 'summary/probe-summary.md'), 'utf8');
  assert.match(full, /7\/15 \(46\.67%\)/);
  const cityTable = full.indexOf('## MISS by city');
  const resourceTable = full.indexOf('## MISS by resource');
  assert.ok(cityTable >= 0 && resourceTable > cityTable);
  await writeFile(mock, 'globalThis.fetch = async () => { throw new Error("Offline"); };');
  execFileSync(process.execPath, command, { stdio: 'pipe' });
  const colos = await readFile(join(app.path, 'summary/colos.md'), 'utf8');
  assert.match(colos, /NRT/);
  assert.match(colos, /location lookup failed: Offline/);
  assert.deepEqual(await snapshot(), original);
});

test('attributes current-format records to runners and respects per-resource target cities', async (t) => {
  const f = await fixture(t);
  await f.targets([A], [SH]);
  await f.plan(1, [A], [SH], [[A]]);
  await f.stats(1, 1, 1, 1, 1);
  // A's response comes from a city targeted only for other resources.
  await f.result(1, 1, 'outside-city', A, [record(TK, 2, 200, 'HIT', 'NRT')]);
  const targets = [{ url: A, cities: [SH] }, { url: B, cities: [TK] }, { url: C, cities: [TK, SG] }];
  await f.save('targets.json', targets);
  await writeTaskPlan(f.path, { round: 2,
    strategy: 'pending-pairs', targets, tasks: targets });
  await f.save('collected-results/round-2/probe-results-1/probe-stats.json', {
    public_ip: '203.0.113.20', available_quota: 250, assigned_resources: 3,
    attempted_resources: 3, attempted_records: 4,
  });
  await f.result(2, 1, 'a', A, [record(SH, 1, 200, 'HIT', 'NRT')]);
  await f.result(2, 1, 'b', B, [record(TK, 2, 404, 'HIT', 'NRT')]);
  // C returns no JSON; both of its attempts still count.
  await f.save('rounds/metadata.json', { additional: 'not a task plan' });
  const report = await analyzeProbeResults(f.path);
  assert.equal(report.overview.hitRecords, 2);
  assert.equal(report.overview.attemptedRecords, 5);
  assert.equal(report.overview.totalCityPairs, 4);
  assert.equal(report.overview.hitCityPairs, 1);
  assert.deepEqual(report.runners.map((runner) => [runner.id, runner.attemptedRecords, runner.hitRecords]),
    [['1/1', 1, 1], ['2/1', 4, 1]]);
  assert.deepEqual(report.rounds.map((round) => [round.newCityPairs, round.cumulativeCityPairs]), [[0, 0], [1, 1]]);
  assert.deepEqual(report.resources.map((resource) => [resource.url, resource.cityCount, resource.misses]),
    [[C, 2, [TK, SG]], [A, 1, []], [B, 1, [TK]]]);
  assert.deepEqual(report.cities.map((city) => [city.city, city.resourceCount, city.misses.length]),
    [[SH, 1, 0], [TK, 2, 2], [SG, 1, 1]]);
  const sections = renderProbeSummary(report, components);
  assert.match(sections.overview, /1\/4 \(25\.00%\)/);
  assert.match(sections.overview, /\| Rounds \| 2 \|/);
  assert.match(sections['missing-cities'], /\| JP\+Tokyo \| 2\/2 \|/);
  assert.match(sections['missing-resources'], /<code>https:\/\/example\.com\/failed\.js<\/code> \| 2\/2 \|/);
  assert.equal(report.sources.find((source) => source.city === TK).hits, 1);
  assert.equal(report.colos[0].hits, 1);
});

test('preserves table columns and resource link destinations containing delimiters', async (t) => {
  const f = await fixture(t);
  const url = 'https://example.com/a|b.js?x=1&y=2';
  await f.targets([url], [SH]);
  await f.plan(1, [url], [SH], [[url]]);
  await f.stats(1, 1, 1, 1, 1);
  const result = record(SH, 1, 200, 'MISS', 'NRT');
  result.probe.network = 'Network A | B';
  await f.result(1, 1, 'delimiters', url, [result]);
  const sections = renderProbeSummary(await analyzeProbeResults(f.directory), components);
  for (const section of [sections.sources, sections['missing-resources']]) {
    const rows = section.split('\n').filter((line) => line.startsWith('|'));
    const columns = (row) => row.split(/(?<!\\)\|/).length;
    assert.ok(rows.length >= 3, 'Expected a table with a data row');
    for (const row of rows.slice(2)) assert.equal(columns(row), columns(rows[0]), 'Cell content must not create extra columns');
  }
  const link = /^\[R\d+\]:\s*<?([^>\s]+)>?$/m.exec(sections['missing-cities']);
  assert.ok(link, 'Missing resource URL link');
  assert.equal(decodeURI(link[1]), url);
});

test('coverage follows current targets while probe-record statistics retain the full history', async (t) => {
  const f = await multipleRounds(t);
  await f.save('targets.json', [{ url: A, cities: [SH] }, { url: D, cities: [TK] }]);
  const report = await analyzeProbeResults(f.directory);
  assert.equal(report.overview.totalCityPairs, 2);
  assert.equal(report.overview.hitCityPairs, 1);
  assert.equal(report.overview.attemptedResources, 1);
  assert.equal(report.overview.attemptedRecords, 15);
  assert.equal(report.overview.hitRecords, 7);
  assert.deepEqual(report.resources.map(({ url, misses }) => [url, misses]), [[D, [TK]], [A, []]]);
  const summary = renderProbeSummary(report);
  assert.match(summary.overview, /Probe record statistics include all saved rounds/);
  assert.doesNotMatch(summary['missing-resources'], /failed\.js|shared\.css/);
});

test('initialized targets can be analyzed before any probe round exists', async (t) => {
  const f = await fixture(t);
  await f.save('targets.json', [{ url: A, cities: [SH, TK] }]);
  const report = await analyzeProbeResults(f.directory);
  assert.equal(report.overview.roundCount, 0);
  assert.equal(report.overview.attemptedRecords, 0);
  assert.equal(report.overview.totalCityPairs, 2);
  assert.deepEqual(report.resources[0].misses, [SH, TK]);
});
