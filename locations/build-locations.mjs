import { readFile, writeFile } from 'node:fs/promises';

const source = new URL('./globalping-probes.json', import.meta.url);
const output = new URL('./region-country-city.json', import.meta.url);
let probes;
let downloaded;

try {
  probes = JSON.parse(await readFile(source, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  const response = await fetch('https://api.globalping.io/v1/probes', {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'sshawn9.com-globalping',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Failed to download probes: HTTP ${response.status}`);
  downloaded = await response.text();
  probes = JSON.parse(downloaded);
}

if (!Array.isArray(probes)) throw new Error('Probe JSON must be an array.');
const regions = Object.create(null);
for (const probe of probes) {
  const { region, country, city } = probe?.location ?? {};
  if ([region, country, city].some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('Each probe location must contain non-empty region, country, and city strings.');
  }
  const countries = (regions[region] ??= Object.create(null));
  (countries[country] ??= new Set()).add(city);
}

const locations = Object.fromEntries(
  Object.keys(regions).sort().map((region) => [
    region,
    Object.fromEntries(
      Object.keys(regions[region]).sort().map((country) => [
        country,
        [...regions[region][country]].sort(),
      ]),
    ),
  ]),
);

if (downloaded !== undefined) await writeFile(source, downloaded);
await writeFile(output, JSON.stringify(locations, null, 2) + '\n');
console.log(`${downloaded === undefined ? 'Reusing existing' : 'Downloaded'} locations/globalping-probes.json`);
console.log('Generated locations/region-country-city.json');
