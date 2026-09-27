import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { probeResource } from './probe-resource.mjs';

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node probe/execute-probe-tasks.mjs <tasks.json>');
  const tasks = JSON.parse(await readFile(process.argv[2], 'utf8'));
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('The task file must contain a non-empty array.');
  for (const { url, cities } of tasks) {
    if (typeof url !== 'string' || !['http:', 'https:'].includes(new URL(url).protocol)) {
      throw new Error('Each task must have an HTTP or HTTPS URL.');
    }
    if (!Array.isArray(cities) || cities.length === 0 ||
      cities.some((city) => typeof city !== 'string' || !/^[A-Z]{2}\+[^,\r\n\0]+$/.test(city))) {
      throw new Error('Each task must have a non-empty cities array, e.g. ["CN+Shanghai"].');
    }
  }

  const stats = {
    public_ip: null,
    available_quota: null,
    assigned_resources: tasks.length,
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

  for (const { url, cities } of tasks) {
    const probeCities = cities.slice(0, stats.available_quota - stats.attempted_records);
    if (probeCities.length === 0) break;
    stats.attempted_resources += 1;
    for (let start = 0; start < probeCities.length; start += 5) {
      const group = probeCities.slice(start, start + 5);
      stats.attempted_records += group.length;
      await saveStats();
      try {
        await probeResource(url, group);
      } catch (error) {
        console.error(`${url} [${group.join(',')}]: ${error.message}`);
        process.exitCode = 1;
      }
    }
  }
  console.log(`Attempted ${stats.attempted_resources}/${stats.assigned_resources} tasks, ${stats.attempted_records} probe records.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
