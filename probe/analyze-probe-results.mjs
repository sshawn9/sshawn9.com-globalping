import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, readMeasurements } from './read-probe-results.mjs';
import { readTaskPlans } from './probe-state.mjs';

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
  const statePath = directory instanceof URL ? fileURLToPath(directory) : directory;
  const plans = await readTaskPlans(statePath);
  const currentTargets = await readJson(join(statePath, 'targets.json'));
  if (!Array.isArray(currentTargets)) throw new Error('targets.json must contain a target array.');

  const targets = new Map();
  const cities = new Set();
  for (const target of currentTargets) {
    const url = new URL(target.url).href;
    if (!targets.has(url)) targets.set(url, new Set());
    for (const city of target.cities) {
      targets.get(url).add(city);
      cities.add(city);
    }
  }
  const runners = new Map();
  const rounds = new Map();
  const resultsDirectory = join(statePath, 'collected-results');
  const runnerDirectories = new Map();
  for (const plan of plans) {
    if (rounds.has(plan.round)) throw new Error(`Duplicate round plan: ${plan.round}`);
    const round = { round: plan.round, runners: [], cityPairs: new Set(), coloPairs: new Set() };
    rounds.set(plan.round, round);
    for (const batch of plan.batches) {
      const directory = join(resultsDirectory, `round-${plan.round}`, `probe-results-${batch.id}`);
      const statsFile = join(directory, 'probe-stats.json');
      const stats = await readJson(statsFile);
      if (!Number.isSafeInteger(stats.attempted_records) || stats.attempted_records < 0 ||
        !Number.isSafeInteger(stats.attempted_resources) || stats.attempted_resources < 0 ||
        stats.attempted_resources > batch.urls.length) throw new Error(`Invalid probe counters: ${statsFile}`);
      const runner = { id: `${plan.round}/${batch.id}`, round: plan.round, batch: batch.id, urls: batch.urls,
        stats, hitRecords: 0 };
      runners.set(runner.id, runner);
      round.runners.push(runner);
      runnerDirectories.set(directory, runner);
    }
  }

  const resourceHits = new Map();
  const sources = new Map();
  const colos = new Map();
  let hitRecords = 0;
  for await (const { file, url, records } of readMeasurements(resultsDirectory)) {
    const runner = runnerDirectories.get(dirname(file));
    if (!runner) throw new Error(`Results do not match a planned runner: ${file}`);
    const round = rounds.get(runner.round);
    for (const record of records) {
      if (record.hit) {
        hitRecords += 1;
        runner.hitRecords += 1;
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
        if (record.hit && targets.get(url)?.has(record.city)) {
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
    const attemptedUrls = new Set();
    for (const runner of round.runners) {
      for (const url of runner.urls.slice(0, runner.stats.attempted_resources)) attemptedUrls.add(new URL(url).href);
    }
    for (const url of attemptedUrls) if (targets.has(url)) allAttemptedUrls.add(url);
    roundRows.push({
      round: round.round,
      attemptedResources: attemptedUrls.size,
      attemptedRecords: sum(round.runners.map((runner) => runner.stats), 'attempted_records'),
      newCityPairs: addPairs(seenCityPairs, round.cityPairs),
      newColoPairs: addPairs(seenColoPairs, round.coloPairs),
      cumulativeCityPairs: seenCityPairs.size,
    });
  }

  const cityList = sorted(cities);
  const resources = sorted(targets.keys()).map((url, index) => ({
    id: `R${index + 1}`, url, cityCount: targets.get(url).size,
    misses: sorted(targets.get(url)).filter((city) => !resourceHits.get(url)?.has(city)),
  }));
  const sourceRows = [...sources.values()].sort((a, b) => b.records - a.records || a.key.localeCompare(b.key))
    .map((source, index) => ({ id: `S${index + 1}`, key: source.key, city: source.city, asn: source.asn,
      networks: sorted(source.networks), records: source.records, hits: source.hits, colos: sorted(source.colos),
      total: timingSummary(source.total), firstByte: timingSummary(source.firstByte) }));
  const sourceIds = new Map(sourceRows.map((source) => [source.key, source.id]));
  return {
    overview: {
      resourceCount: resources.length, cityCount: cityList.length,
      roundCount: plans.length, runnerCount: runners.size,
      coloCount: colos.size, hitRecords, hitCityPairs: seenCityPairs.size, totalCityPairs: sum(resources, 'cityCount'),
      attemptedRecords: sum(roundRows, 'attemptedRecords'),
      attemptedResources: allAttemptedUrls.size,
    },
    rounds: roundRows,
    resources,
    cities: cityList.map((city) => ({ city,
      resourceCount: resources.filter(({ url }) => targets.get(url).has(city)).length,
      misses: resources.filter((resource) => resource.misses.includes(city)).map(({ id }) => id),
    })),
    sources: sourceRows,
    colos: [...colos.values()].sort((a, b) => b.urls.size - a.urls.size || a.code.localeCompare(b.code))
      .map((colo) => ({ code: colo.code, resources: colo.urls.size, hits: colo.hits.size,
        cities: sorted(colo.cities), sources: sorted([...colo.sources].map((key) => sourceIds.get(key))) })),
    runners: [...runners.values()].map((runner) => ({
      id: runner.id, round: runner.round, batch: runner.batch,
      publicIP: runner.stats.public_ip, availableQuota: runner.stats.available_quota,
      attemptedRecords: runner.stats.attempted_records, hitRecords: runner.hitRecords,
    })),
  };
}
