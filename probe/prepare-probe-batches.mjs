import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { readResourceHits } from './read-resource-hits.mjs';

async function main() {
  const request = JSON.parse(process.env.PROBE_INPUTS);
  const planFile = new URL('./resources/probe-batches.json', import.meta.url);
  const previous = request.previous_run_id ? JSON.parse(await readFile(planFile, 'utf8')) : null;
  const inputs = previous ? previous.inputs : request;
  const maxParallel = Number(inputs.max_parallel);
  if (!Number.isSafeInteger(maxParallel) || maxParallel < 1) {
    throw new Error('max_parallel must be a positive integer.');
  }
  const maxRounds = Number(inputs.max_rounds);
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    throw new Error('max_rounds must be a positive integer.');
  }
  const round = previous ? previous.round + 1 : 1;
  if (round > maxRounds) throw new Error('The maximum number of rounds has already been reached.');

  const cities = new Set(previous?.cities);
  for (const group of ['CN-main', 'CN-aroung', 'global-main']) {
    if (previous || inputs[group] !== true) continue;
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

  const resourcesPerBatch = Math.floor(250 / cities.size);
  if (resourcesPerBatch === 0) throw new Error('The selected groups exceed the 250-city budget.');
  const urls = JSON.parse(await readFile(new URL('./resources/urls.json', import.meta.url), 'utf8'));
  if (!Array.isArray(urls) || urls.length === 0) throw new Error('The resource URL list must not be empty.');
  const resources = await readResourceHits(urls, [...cities]);
  const pending = resources.filter((resource) => resource.hits.size < cities.size).map((resource) => resource.url);
  if (Math.ceil(pending.length / resourcesPerBatch) > 256) {
    throw new Error('The resource batches exceed the GitHub Actions matrix limit of 256 jobs.');
  }

  const batches = [];
  for (let start = 0; start < pending.length; start += resourcesPerBatch) {
    batches.push({ id: batches.length + 1, urls: pending.slice(start, start + resourcesPerBatch) });
  }
  const savedInputs = {
    'CN-main': inputs['CN-main'] === true,
    'CN-aroung': inputs['CN-aroung'] === true,
    'global-main': inputs['global-main'] === true,
    max_parallel: maxParallel,
    max_rounds: maxRounds,
  };
  await writeFile(
    planFile,
    JSON.stringify({ inputs: savedInputs, round, urls, cities: [...cities], batches }, null, 2) + '\n',
  );
  if (process.env.GITHUB_OUTPUT) {
    const matrix = { batch: batches.map((batch) => batch.id) };
    await appendFile(process.env.GITHUB_OUTPUT,
      `matrix=${JSON.stringify(matrix)}\nmax_parallel=${maxParallel}\nround=${round}\nhas_work=${batches.length > 0}\n`);
  }
  console.log(`Round ${round}/${maxRounds}: ${pending.length}/${urls.length} resources pending, ${cities.size} cities, ${batches.length} batches.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
