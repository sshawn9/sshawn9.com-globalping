import { readFile } from 'node:fs/promises';
import { probeResource } from './probe-resource.mjs';

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node probe/probe-resource-batch.mjs <batch-id>');
  const plan = JSON.parse(await readFile(new URL('./resources/probe-batches.json', import.meta.url), 'utf8'));
  const batch = plan.batches.find((batch) => batch.id === Number(process.argv[2]));
  if (!batch) throw new Error('Batch not found.');

  for (const url of batch.urls) {
    for (let start = 0; start < plan.cities.length; start += 5) {
      const cities = plan.cities.slice(start, start + 5);
      try {
        await probeResource(url, cities);
      } catch (error) {
        console.error(`${url} [${cities.join(',')}]: ${error.message}`);
        process.exitCode = 1;
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
