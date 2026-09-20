import { appendFile, readFile, writeFile } from 'node:fs/promises';

async function main() {
  const inputs = JSON.parse(process.env.PROBE_INPUTS);
  const maxParallel = Number(inputs.max_parallel);
  if (!Number.isSafeInteger(maxParallel) || maxParallel < 1) {
    throw new Error('max_parallel must be a positive integer.');
  }

  const cities = new Set();
  for (const group of ['CN-main', 'CN-aroung', 'global-main']) {
    if (inputs[group] !== true) continue;
    const values = JSON.parse(await readFile(new URL(`../cities/${group}.json`, import.meta.url), 'utf8'));
    if (
      !Array.isArray(values) || values.length === 0 ||
      values.some((city) => typeof city !== 'string' || !/^[A-Z]{2}\+[^,\r\n\0]+$/.test(city))
    ) {
      throw new Error(`Invalid city list: ${group}.json`);
    }
    for (const city of values) cities.add(city);
  }
  if (cities.size === 0) throw new Error('Select at least one city group.');

  const resourcesPerBatch = Math.floor(200 / cities.size);
  if (resourcesPerBatch === 0) throw new Error('The selected groups exceed the 200-city budget.');
  const urls = JSON.parse(await readFile(new URL('./resources/urls.json', import.meta.url), 'utf8'));
  if (!Array.isArray(urls) || urls.length === 0) throw new Error('The resource URL list must not be empty.');
  if (Math.ceil(urls.length / resourcesPerBatch) > 256) {
    throw new Error('The resource batches exceed the GitHub Actions matrix limit of 256 jobs.');
  }

  const batches = [];
  for (let start = 0; start < urls.length; start += resourcesPerBatch) {
    batches.push({ id: batches.length + 1, urls: urls.slice(start, start + resourcesPerBatch) });
  }
  await writeFile(
    new URL('./resources/probe-batches.json', import.meta.url),
    JSON.stringify({ cities: [...cities], batches }, null, 2) + '\n',
  );
  if (process.env.GITHUB_OUTPUT) {
    const matrix = { batch: batches.map((batch) => batch.id) };
    await appendFile(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\nmax_parallel=${maxParallel}\n`);
  }
  console.log(`${urls.length} resources, ${cities.size} cities, ${resourcesPerBatch} resources per runner, ${batches.length} batches.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
