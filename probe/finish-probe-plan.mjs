import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nextTask, validateFlow } from './probe-flow.mjs';
import { collectProbeResults, saveJson } from './probe-state.mjs';
import { readJson, readProbeHits } from './read-probe-results.mjs';
import { selectPendingPairs } from './probe-targets.mjs';
import { summarizeProbeResults } from './summarize-probe-results.mjs';

const output = async (text) => {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, text + '\n');
};

async function main() {
  const [directory, results, report] = process.argv.slice(2);
  if (process.argv.length !== 5) throw new Error('Usage: node probe/finish-probe-plan.mjs <state-directory> <results-directory> <report-directory>');
  const flow = await readJson(join(directory, 'flow.json'));
  validateFlow(flow);
  const round = Number(process.env.PROBE_ROUND);
  if (!/^\d+$/.test(process.env.PROBE_ROUND ?? '') || !Number.isSafeInteger(round)) throw new Error('Missing or invalid prepared round.');
  if (round) {
    const plan = await readJson(join(directory, 'rounds', `round-${round}.json`));
    if (plan.strategy !== flow.steps[flow.position]) throw new Error('Prepared task does not match the flow position.');
    await collectProbeResults(directory, plan, results);
    flow.position += 1;
  }
  const targets = await readJson(join(directory, 'targets.json'));
  const hits = await readProbeHits(join(directory, 'collected-results'));
  const next = nextTask(flow, targets, hits);
  await saveJson(join(directory, 'flow.json'), flow);
  await output('state_ready=true');
  if (next.type === 'analyze') {
    await summarizeProbeResults(directory, report);
    flow.position += 1;
    nextTask(flow, targets, hits);
    await saveJson(join(directory, 'flow.json'), flow);
    await output('analyzed=true');
  }
  await output(`continue=${flow.position < flow.steps.length}`);
  const { remainingPairs } = selectPendingPairs(targets, hits);
  const message = `${flow.position}/${flow.steps.length} plan steps complete; ${remainingPairs} target pairs pending.`;
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, message + '\n\n');
  console.log(message);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
