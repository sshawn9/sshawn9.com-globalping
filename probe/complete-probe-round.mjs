import { appendFile, readFile } from 'node:fs/promises';
import { readResourceHits } from './read-resource-hits.mjs';

async function main() {
  const plan = JSON.parse(await readFile(new URL('./resources/probe-batches.json', import.meta.url), 'utf8'));
  const resources = await readResourceHits(plan.urls, plan.cities);
  const pending = resources.filter((resource) => resource.hits.size < plan.cities.length);
  const continueRounds = pending.length > 0 && plan.round < plan.inputs.max_rounds;
  let output = `continue=${continueRounds}\n`;
  if (continueRounds) {
    const nextRound = {
      ref: process.env.GITHUB_REF_NAME,
      inputs: { ...plan.inputs, previous_run_id: process.env.GITHUB_RUN_ID },
    };
    output += `next_round=${JSON.stringify(nextRound)}\n`;
  }
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output);
  console.log(`Round ${plan.round}/${plan.inputs.max_rounds}: ${pending.length} resources pending; ${continueRounds ? 'continue' : 'finish'}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
