import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { buildProbeTargets } from './probe-targets.mjs';

export async function initializeProbeTargets(stateDirectory, inputs) {
  const targets = await buildProbeTargets(inputs);
  const resources = join(stateDirectory, 'resources');
  await mkdir(resources, { recursive: true });
  await copyFile(new URL('./resources/resource-inventory.json', import.meta.url),
    join(resources, `resource-inventory-${randomUUID()}.json`), constants.COPYFILE_EXCL);
  await writeFile(join(stateDirectory, 'targets.json'), JSON.stringify(targets, null, 2) + '\n');
  console.log(`Initialized ${targets.length} resources and ${targets.reduce((total, target) => total + target.cities.length, 0)} target pairs.`);
}
