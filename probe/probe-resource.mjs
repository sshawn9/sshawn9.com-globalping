import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function probeResource(url, cities) {
  if (!['http:', 'https:'].includes(new URL(url).protocol)) {
    throw new Error('Resource URL must use HTTP or HTTPS.');
  }
  if (
    !Array.isArray(cities) || cities.length === 0 ||
    cities.some((city) => typeof city !== 'string' || !/^[A-Z]{2}\+[^,\r\n\0]+$/.test(city))
  ) {
    throw new Error('Cities must be a non-empty array of strings, e.g. ["CN+Beijing", "CN+Shanghai"].');
  }

  const directory = new URL('./results/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const child = spawn(
    'globalping-cli',
    [
      'http', url,
      '--from', cities.join(','),
      '--limit', String(cities.length),
      '--method', 'GET',
      '--json', '--ci',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  const [code, signal] = await once(child, 'close');
  const json = Buffer.concat(chunks);
  if (json.length === 0) {
    throw new Error(`Globalping CLI returned no JSON: ${signal ?? `exit code ${code}`}.`);
  }
  JSON.parse(json.toString('utf8'));
  // Keep filenames below 255 bytes, including long URLs and large city lists.
  const label = (value) => value.replace(/[^a-zA-Z0-9._+-]/g, '_').slice(0, 100);
  const filename = `${label(url)}__${label(cities.join('_'))}__${randomUUID()}.json`;
  const output = new URL(filename, directory);
  await writeFile(output, json, { flag: 'wx' });
  console.log(fileURLToPath(output));
  if (code !== 0) throw new Error(`Globalping CLI failed: ${signal ?? `exit code ${code}`}.`);
}

async function main() {
  const usage = 'Usage: node probe/probe-resource.mjs <resource-url> <cities.json>';
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return;
  }
  if (args.length !== 2) throw new Error(usage);
  const [url, citiesFile] = args;
  await probeResource(url, JSON.parse(await readFile(citiesFile, 'utf8')));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
