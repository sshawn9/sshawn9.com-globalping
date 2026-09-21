import { basename, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonFiles, readJson, readMeasurements } from './read-probe-results.mjs';

const sorted = (values) => [...values].sort((a, b) => a.localeCompare(b));
const pair = (left, right) => JSON.stringify([left, right]);
const sum = (values, key) => values.reduce((total, value) => total + value[key], 0);

export function timingSummary(values) {
  const samples = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const n = samples.length;
  if (!n) return { n: 0, p50: null, p95: null };
  return {
    n,
    p50: (samples[Math.floor((n - 1) / 2)] + samples[Math.floor(n / 2)]) / 2,
    p95: samples[Math.ceil(n * 0.95) - 1],
  };
}

function addPairs(seen, values) {
  const before = seen.size;
  for (const value of values) seen.add(value);
  return seen.size - before;
}

export async function analyzeProbeResults(directory = new URL('./', import.meta.url)) {
  const plans = [];
  for (const file of await jsonFiles(new URL('rounds/', directory))) plans.push(await readJson(file));
  plans.sort((a, b) => a.round - b.round);
  if (!plans.length) throw new Error('No saved round plans found.');

  const urls = new Set();
  const cities = new Set();
  const groups = new Set();
  const runners = new Map();
  const rounds = new Map();
  for (const plan of plans) {
    if (rounds.has(plan.round)) throw new Error(`Duplicate round plan: ${plan.round}`);
    for (const url of plan.urls) urls.add(new URL(url).href);
    for (const city of plan.cities) cities.add(city);
    for (const [name, enabled] of Object.entries(plan.inputs)) if (enabled === true) groups.add(name);
    const round = { round: plan.round, runners: [], cityPairs: new Set(), coloPairs: new Set(), observedUrls: new Set() };
    rounds.set(plan.round, round);
    for (const batch of plan.batches) {
      const runner = { id: `${plan.round}/${batch.id}`, round: plan.round, batch: batch.id, urls: batch.urls,
        stats: null, hitRecords: 0 };
      runners.set(runner.id, runner);
      round.runners.push(runner);
    }
  }

  const resultsDirectory = new URL('collected-results/', directory);
  const resultPath = fileURLToPath(resultsDirectory);
  const roundOf = (file) => {
    const number = Number(/^round-(\d+)$/.exec(relative(resultPath, file).split(sep)[0])?.[1]);
    const round = rounds.get(number);
    if (!round) throw new Error(`No round plan for results: ${file}`);
    return round;
  };
  const runnerDirectories = new Map();
  for (const file of await jsonFiles(resultsDirectory)) {
    if (basename(file) !== 'probe-stats.json') continue;
    const stats = await readJson(file);
    const runner = runners.get(`${stats.round}/${stats.batch_id}`);
    if (!runner || runner.round !== roundOf(file).round) throw new Error(`Stats do not match a planned runner: ${file}`);
    if (runner.stats) throw new Error(`Duplicate runner stats: ${runner.id}`);
    if (!Number.isSafeInteger(stats.attempted_records) || stats.attempted_records < 0 ||
      !Number.isSafeInteger(stats.attempted_resources) || stats.attempted_resources < 0 ||
      stats.attempted_resources > runner.urls.length) throw new Error(`Invalid probe counters: ${file}`);
    runner.stats = stats;
    runnerDirectories.set(dirname(file), runner);
  }

  const resourceHits = new Map();
  const sources = new Map();
  const colos = new Map();
  let hitRecords = 0;
  for await (const { file, url, records } of readMeasurements(resultsDirectory)) {
    const round = roundOf(file);
    const runner = runnerDirectories.get(dirname(file));
    round.observedUrls.add(url);
    for (const record of records) {
      if (record.hit) {
        hitRecords += 1;
        if (runner) runner.hitRecords += 1;
      }
      let source;
      if (record.city) {
        const key = pair(record.city, record.asn);
        if (!sources.has(key)) sources.set(key, { key, city: record.city, asn: record.asn,
          networks: new Set(), records: 0, hits: 0, colos: new Set(), total: [], firstByte: [] });
        source = sources.get(key);
        if (record.network) source.networks.add(record.network);
        source.records += 1;
        source.hits += Number(record.hit);
        source.total.push(record.total);
        source.firstByte.push(record.firstByte);
        if (record.hit && urls.has(url) && cities.has(record.city)) {
          if (!resourceHits.has(url)) resourceHits.set(url, new Set());
          resourceHits.get(url).add(record.city);
          round.cityPairs.add(pair(url, record.city));
        }
      }
      if (record.colo) {
        if (!colos.has(record.colo)) colos.set(record.colo, { code: record.colo, urls: new Set(), hits: new Set(),
          cities: new Set(), sources: new Set() });
        const colo = colos.get(record.colo);
        colo.urls.add(url);
        if (record.city) colo.cities.add(record.city);
        if (source) {
          source.colos.add(record.colo);
          colo.sources.add(source.key);
        }
        if (record.hit) {
          colo.hits.add(url);
          round.coloPairs.add(pair(url, record.colo));
        }
      }
    }
  }

  const allAttemptedUrls = new Set();
  const seenCityPairs = new Set();
  const seenColoPairs = new Set();
  const roundRows = [];
  for (const round of rounds.values()) {
    const attemptedUrls = new Set(round.observedUrls);
    const knownStats = round.runners.flatMap((runner) => runner.stats ? [runner.stats] : []);
    for (const runner of round.runners) {
      if (!runner.stats) continue;
      for (const url of runner.urls.slice(0, runner.stats.attempted_resources)) attemptedUrls.add(new URL(url).href);
    }
    for (const url of attemptedUrls) allAttemptedUrls.add(url);
    const incomplete = knownStats.length !== round.runners.length;
    roundRows.push({
      round: round.round,
      attemptedResources: incomplete ? null : attemptedUrls.size,
      knownAttemptedResources: attemptedUrls.size,
      attemptedRecords: incomplete ? null : sum(knownStats, 'attempted_records'),
      knownAttemptedRecords: sum(knownStats, 'attempted_records'),
      newCityPairs: addPairs(seenCityPairs, round.cityPairs),
      newColoPairs: addPairs(seenColoPairs, round.coloPairs),
      cumulativeCityPairs: seenCityPairs.size,
    });
  }

  const cityList = sorted(cities);
  const resources = sorted(urls).map((url, index) => ({
    id: `R${index + 1}`, url, misses: cityList.filter((city) => !resourceHits.get(url)?.has(city)),
  }));
  const sourceRows = [...sources.values()].sort((a, b) => b.records - a.records || a.key.localeCompare(b.key))
    .map((source, index) => ({ id: `S${index + 1}`, key: source.key, city: source.city, asn: source.asn,
      networks: sorted(source.networks), records: source.records, hits: source.hits, colos: sorted(source.colos),
      total: timingSummary(source.total), firstByte: timingSummary(source.firstByte) }));
  const sourceIds = new Map(sourceRows.map((source) => [source.key, source.id]));
  const missingRunnerStats = [...runners.values()].filter((runner) => !runner.stats).map((runner) => runner.id);
  return {
    overview: {
      resourceCount: resources.length, cityCount: cityList.length, groups: sorted(groups),
      roundCount: plans.length, maxRounds: plans[0].inputs.max_rounds, runnerCount: runners.size,
      coloCount: colos.size, hitRecords, hitCityPairs: seenCityPairs.size, totalCityPairs: resources.length * cityList.length,
      attemptedRecords: missingRunnerStats.length ? null : sum(roundRows, 'knownAttemptedRecords'),
      knownAttemptedRecords: sum(roundRows, 'knownAttemptedRecords'),
      attemptedResources: missingRunnerStats.length ? null : allAttemptedUrls.size,
      knownAttemptedResources: allAttemptedUrls.size,
      missingRunnerStats,
    },
    rounds: roundRows,
    resources,
    cities: cityList.map((city) => ({ city, misses: resources.filter((resource) => resource.misses.includes(city)).map(({ id }) => id) })),
    sources: sourceRows,
    colos: [...colos.values()].sort((a, b) => b.urls.size - a.urls.size || a.code.localeCompare(b.code))
      .map((colo) => ({ code: colo.code, resources: colo.urls.size, hits: colo.hits.size,
        cities: sorted(colo.cities), sources: sorted([...colo.sources].map((key) => sourceIds.get(key))) })),
    runners: [...runners.values()].map((runner) => ({
      id: runner.id, round: runner.round, batch: runner.batch,
      publicIP: runner.stats?.public_ip ?? null, availableQuota: runner.stats?.available_quota ?? null,
      attemptedRecords: runner.stats?.attempted_records ?? null, hitRecords: runner.stats ? runner.hitRecords : null,
    })),
  };
}
