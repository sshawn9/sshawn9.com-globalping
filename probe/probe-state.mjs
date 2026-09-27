import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from './read-probe-results.mjs';

export const saveJson = (file, value, options) => writeFile(file, JSON.stringify(value, null, 2) + '\n', options);

export async function readTaskPlans(directory) {
  const folder = join(directory, 'rounds');
  const files = await readdir(folder).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  const plans = await Promise.all(files.filter((file) => /^round-\d+\.json$/.test(file)).map((file) => readJson(join(folder, file))));
  for (const plan of plans) {
    if (!Number.isSafeInteger(plan.round) || plan.round < 1) throw new Error('Invalid round number in probe state.');
  }
  return plans.sort((a, b) => a.round - b.round);
}

export async function writeTaskPlan(directory, { round, strategy, targets, tasks }) {
  const batches = [];
  let used = 250;
  for (const task of tasks) {
    if (task.cities.length === 0 || task.cities.length > 250) throw new Error('Each task must contain between 1 and 250 cities.');
    if (used + task.cities.length > 250) {
      batches.push([]);
      used = 0;
    }
    batches.at(-1).push(task);
    used += task.cities.length;
  }
  if (batches.length > 256) throw new Error('The resource batches exceed the GitHub Actions matrix limit of 256 jobs.');
  const folder = join('tasks', `round-${round}`);
  await mkdir(join(directory, folder), { recursive: true });
  await mkdir(join(directory, 'rounds'), { recursive: true });
  const plan = {
    round, strategy, targets,
    batches: batches.map((tasks, index) => ({
      id: index + 1, urls: tasks.map(({ url }) => url), tasks_file: `${folder}/batch-${index + 1}.json`,
    })),
  };
  for (const batch of plan.batches) {
    await saveJson(join(directory, batch.tasks_file), batches[batch.id - 1], { flag: 'wx' });
  }
  await saveJson(join(directory, 'rounds', `round-${round}.json`), plan, { flag: 'wx' });
  return plan;
}

export async function collectProbeResults(stateDirectory, plan, resultsDirectory) {
  const directory = join(stateDirectory, 'collected-results', `round-${plan.round}`);
  await mkdir(directory, { recursive: true });
  for (const { id } of plan.batches) {
    // download-artifact extracts a single matching artifact directly into its destination.
    const source = plan.batches.length === 1 ? resultsDirectory : join(resultsDirectory, `probe-results-${id}`);
    await cp(source, join(directory, `probe-results-${id}`), { recursive: true, force: false, errorOnExist: true });
  }
}
