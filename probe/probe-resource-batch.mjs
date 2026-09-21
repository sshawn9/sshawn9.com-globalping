import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { probeResource } from './probe-resource.mjs';

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node probe/probe-resource-batch.mjs <batch-id>');
  const plan = JSON.parse(await readFile(new URL('./resources/probe-batches.json', import.meta.url), 'utf8'));
  const batch = plan.batches.find((batch) => batch.id === Number(process.argv[2]));
  if (!batch) throw new Error('Batch not found.');

  const stats = {
    round: plan.round,
    batch_id: batch.id,
    public_ip: null,
    available_quota: null,
    assigned_resources: batch.urls.length,
    attempted_resources: 0,
    attempted_records: 0,
  };
  const directory = new URL('./results/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const saveStats = () => writeFile(new URL('probe-stats.json', directory), JSON.stringify(stats, null, 2) + '\n');
  await saveStats();

  const response = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Failed to obtain public IP: HTTP ${response.status}`);
  const { ip } = await response.json();
  if (typeof ip !== 'string' || !isIP(ip)) throw new Error('Invalid public IP response.');
  stats.public_ip = ip;
  await saveStats();

  const { stdout, stderr } = await promisify(execFile)('globalping-cli', ['limits', '--ci'], { timeout: 30_000 });
  if (stderr) process.stderr.write(stderr);
  const remaining = /^\s*-\s+\d+ consumed,\s+(\d+) remaining\s*$/m.exec(stdout);
  if (!remaining || !Number.isSafeInteger(Number(remaining[1]))) {
    throw new Error('Could not read the remaining quota from Globalping CLI limits.');
  }
  stats.available_quota = Number(remaining[1]);
  await saveStats();

  const resourceLimit = Math.floor(stats.available_quota / plan.cities.length);
  for (const url of batch.urls.slice(0, resourceLimit)) {
    stats.attempted_resources += 1;
    for (let start = 0; start < plan.cities.length; start += 5) {
      const cities = plan.cities.slice(start, start + 5);
      stats.attempted_records += cities.length;
      await saveStats();
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
