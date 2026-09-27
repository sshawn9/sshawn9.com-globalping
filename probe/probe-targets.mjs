import { readJson } from './read-probe-results.mjs';

export async function buildProbeTargets(inputs) {
  const cities = new Set();
  for (const group of ['CN-main', 'CN-aroung', 'global-main']) {
    if (inputs[group] !== true) continue;
    const values = await readJson(new URL(`../cities/${group}.json`, import.meta.url));
    if (!Array.isArray(values) || values.length === 0 ||
      values.some((city) => typeof city !== 'string' || !/^[A-Z]{2}\+[^,\r\n\0]+$/.test(city))) {
      throw new Error(`Invalid city list: ${group}.json`);
    }
    for (const city of values) cities.add(city);
  }
  if (cities.size === 0) throw new Error('Select at least one city group.');
  if (cities.size > 250) throw new Error('The selected groups exceed the 250-city budget.');
  const urls = await readJson(new URL('./resources/urls.json', import.meta.url));
  if (!Array.isArray(urls) || urls.length === 0) throw new Error('The resource URL list must not be empty.');
  return [...new Set(urls.map((url) => new URL(url).href))].map((url) => ({ url, cities: [...cities] }));
}

export function selectPendingPairs(targets, hits) {
  const pending = new Map();
  for (const target of targets) {
    const url = new URL(target.url).href;
    for (const city of target.cities) {
      if (hits.get(url)?.has(city)) continue;
      if (!pending.has(url)) pending.set(url, new Set());
      pending.get(url).add(city);
    }
  }
  const tasks = [...pending].map(([url, cities]) => ({ url, cities: [...cities] }));
  return { tasks, remainingPairs: tasks.reduce((total, task) => total + task.cities.length, 0) };
}
