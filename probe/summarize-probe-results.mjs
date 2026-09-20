import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function resourceUrl(measurement) {
  const options = measurement.measurementOptions ?? {};
  const url = new URL(`${options.protocol === 'HTTP' ? 'http' : 'https'}://${measurement.target}`);
  url.port = options.port ? String(options.port) : '';
  url.pathname = options.request?.path ?? '/';
  url.search = options.request?.query ?? '';
  return url.href;
}

const escape = (value) => value.replace(/[&<>|\r\n]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '\r': ' ', '\n': ' ',
})[char]);

function table(title, columns, rows) {
  if (rows.length === 0) return `## ${title}\n\nNone.\n`;
  return [
    `## ${title}\n`,
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
  ].join('\n');
}

async function main() {
  const plan = JSON.parse(await readFile(new URL('./resources/probe-batches.json', import.meta.url), 'utf8'));
  const cities = [...new Set(plan.cities)];
  const citySet = new Set(cities);
  const resources = [...new Set(plan.batches.flatMap((batch) => batch.urls))].map((url, index) => ({
    id: `R${index + 1}`, url, hits: new Set(),
  }));
  const byUrl = new Map(resources.map((resource) => [new URL(resource.url).href, resource]));
  const directory = fileURLToPath(new URL('./collected-results/', import.meta.url));
  const files = await readdir(directory, { recursive: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });

  for (const file of files.filter((file) => file.endsWith('.json'))) {
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

  const resourceMisses = resources.map((resource) => ({
    ...resource, misses: cities.filter((city) => !resource.hits.has(city)),
  }));
  const cityResults = cities.map((city) => ({
    city, misses: resources.filter((resource) => !resource.hits.has(city)),
  }));
  const totalPairs = resources.length * cities.length;
  const hitPairs = resources.reduce((total, resource) => total + resource.hits.size, 0);
  const summary = [
    '# Globalping probe results\n',
    `${resources.length} resources × ${cities.length} cities.\n`,
    `**HIT / total:** ${hitPairs}/${totalPairs} (${(hitPairs / totalPairs * 100).toFixed(2)}%) · **MISS:** ${totalPairs - hitPairs}\n`,
    'HIT requires HTTP **200** and **CF-Cache-Status: HIT**. Each resource/city pair counts once; any qualifying result makes it a HIT.\n',
    'MISS means no qualifying HIT, including HTTP errors, other cache statuses, failed probes, and missing results. Denominators use the complete planned lists.\n',
    'Resource IDs link to the URLs listed below.\n',
    table('MISS by city', ['City', 'MISS resources / total resources', 'Resources'], cityResults
      .filter(({ misses }) => misses.length > 0)
      .map(({ city, misses }) => [escape(city), `${misses.length}/${resources.length}`, misses.map(({ id }) => `[${id}]`).join(', ')])),
    table('MISS by resource', ['ID', 'Resource URL', 'MISS cities / total cities', 'Cities'], resourceMisses
      .filter(({ misses }) => misses.length > 0)
      .map(({ id, url, misses }) => [`[${id}]`, `<code>${escape(url)}</code>`, `${misses.length}/${cities.length}`, misses.map(escape).join(', ')])),
    ...resources.map(({ id, url }) => `[${id}]: <${new URL(url).href}>`),
    '',
  ].join('\n');
  const output = process.env.GITHUB_STEP_SUMMARY ?? new URL('./probe-summary.md', import.meta.url);
  await writeFile(output, summary);
  console.log(`Summarized ${resources.length} resources across ${cities.length} cities.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
