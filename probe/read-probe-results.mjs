import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

export async function jsonFiles(directory) {
  const path = directory instanceof URL ? fileURLToPath(directory) : directory;
  const files = await readdir(path, { recursive: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return files.filter((file) => file.endsWith('.json')).sort().map((file) => join(path, file));
}

function header(headers, name) {
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
  return String(Array.isArray(value) ? value[0] ?? '' : value ?? '').trim();
}

function resourceUrl(measurement) {
  const options = measurement.measurementOptions ?? {};
  const url = new URL(`${options.protocol === 'HTTP' ? 'http' : 'https'}://${measurement.target}`);
  url.port = options.port ? String(options.port) : '';
  url.pathname = options.request?.path ?? '/';
  url.search = options.request?.query ?? '';
  return url.href;
}

export async function* readMeasurements(directory = new URL('./collected-results/', import.meta.url)) {
  for (const file of await jsonFiles(directory)) {
    if (basename(file) === 'probe-stats.json') continue;
    const measurement = await readJson(file);
    // Error payloads have no probe results; their attempts remain in runner stats.
    if (!Array.isArray(measurement.results)) continue;
    yield {
      file,
      url: resourceUrl(measurement),
      records: measurement.results.map(({ probe = {}, result = {} }) => ({
        city: probe.country && probe.city ? `${probe.country}+${probe.city}` : null,
        asn: probe.asn ?? null,
        network: probe.network ?? '',
        hit: result.statusCode === 200 && header(result.headers, 'cf-cache-status').toUpperCase() === 'HIT',
        colo: /-([A-Z]{3})$/.exec(header(result.headers, 'cf-ray').toUpperCase())?.[1] ?? null,
        total: result.timings?.total,
        firstByte: result.timings?.firstByte,
      })),
    };
  }
}
