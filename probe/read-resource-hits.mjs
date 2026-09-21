import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function resourceUrl(measurement) {
  const options = measurement.measurementOptions ?? {};
  const url = new URL(`${options.protocol === 'HTTP' ? 'http' : 'https'}://${measurement.target}`);
  url.port = options.port ? String(options.port) : '';
  url.pathname = options.request?.path ?? '/';
  url.search = options.request?.query ?? '';
  return url.href;
}

export async function readResourceHits(urls, cities) {
  const citySet = new Set(cities);
  const resources = [...new Set(urls)].map((url, index) => ({
    id: `R${index + 1}`, url, hits: new Set(),
  }));
  const byUrl = new Map(resources.map((resource) => [new URL(resource.url).href, resource]));
  const directory = fileURLToPath(new URL('./collected-results/', import.meta.url));
  const files = await readdir(directory, { recursive: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });

  for (const file of files.filter((file) => file.endsWith('.json') && basename(file) !== 'probe-stats.json')) {
    const measurement = JSON.parse(await readFile(join(directory, file), 'utf8'));
    const resource = byUrl.get(resourceUrl(measurement));
    if (!resource) continue;
    for (const { probe, result } of measurement.results ?? []) {
      const city = `${probe.country}+${probe.city}`;
      const cacheStatus = Object.entries(result.headers ?? {})
        .find(([name]) => name.toLowerCase() === 'cf-cache-status')?.[1];
      if (citySet.has(city) && result.statusCode === 200 && String(cacheStatus).trim().toUpperCase() === 'HIT') {
        resource.hits.add(city);
      }
    }
  }
  return resources;
}
