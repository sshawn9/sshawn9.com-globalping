import { readMeasurements } from './read-probe-results.mjs';

export async function readResourceHits(urls, cities) {
  const citySet = new Set(cities);
  const resources = [...new Set(urls.map((url) => new URL(url).href))].map((url, index) => ({
    id: `R${index + 1}`, url, hits: new Set(),
  }));
  const byUrl = new Map(resources.map((resource) => [resource.url, resource]));
  for await (const { url, records } of readMeasurements()) {
    const resource = byUrl.get(url);
    if (!resource) continue;
    for (const record of records) {
      if (record.hit && citySet.has(record.city)) resource.hits.add(record.city);
    }
  }
  return resources;
}
