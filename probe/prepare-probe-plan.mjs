import { execFileSync } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchResourceUrls } from './fetch-resource-urls.mjs';
import { initializeProbeTargets } from './initialize-probe-targets.mjs';
import { readJson, readProbeHits } from './read-probe-results.mjs';
import { readTaskPlans, saveJson, writeTaskPlan } from './probe-state.mjs';
import { nextTask, validateFlow } from './probe-flow.mjs';

async function main() {
  const [directory] = process.argv.slice(2);
  if (process.argv.length !== 3) throw new Error('Usage: node probe/prepare-probe-plan.mjs <state-directory>');
  const request = JSON.parse(process.env.PROBE_REQUEST);
  const runId = String(request.state_run_id ?? '');
  if (runId && !/^\d+$/.test(runId)) throw new Error('state_run_id must contain only Run ID digits.');
  if (!request.definition && !runId) throw new Error('Continuation requires state_run_id.');
  await mkdir(directory, { recursive: true });
  if (runId) execFileSync('gh', ['run', 'download', runId, '--name', 'probe-state', '--dir', directory], { stdio: 'inherit' });
  let flow;
  if (request.definition) {
    const { default: define } = await import(pathToFileURL(resolve(request.definition)));
    const settings = await define(JSON.parse(request.settings), process.env.GITHUB_EVENT_NAME === 'schedule');
    await fetchResourceUrls();
    await initializeProbeTargets(directory, settings);
    flow = { steps: settings.steps, position: 0, max_parallel: settings.max_parallel };
  } else flow = await readJson(join(directory, 'flow.json'));
  validateFlow(flow);
  const targets = await readJson(join(directory, 'targets.json'));
  const { type, tasks } = nextTask(flow, targets, await readProbeHits(join(directory, 'collected-results')));
  let plan = { round: 0, batches: [] };
  if (tasks.length) {
    const plans = await readTaskPlans(directory);
    plan = await writeTaskPlan(directory, { round: (plans.at(-1)?.round ?? 0) + 1, strategy: type, targets, tasks });
  }
  await saveJson(join(directory, 'flow.json'), flow);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    `matrix=${JSON.stringify({ batch: plan.batches.map(({ id }) => id) })}\nround=${plan.round}\nmax_parallel=${flow.max_parallel}\nhas_work=${tasks.length > 0}\n`);
  console.log(`Plan step ${flow.position + 1}: ${type}; ${tasks.length} resources, ${plan.batches.length} batches.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
