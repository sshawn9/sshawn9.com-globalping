import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readResourceHits } from './read-resource-hits.mjs';

async function main() {
  const plan = JSON.parse(await readFile(new URL('./resources/probe-batches.json', import.meta.url), 'utf8'));
  const rounds = new URL('./rounds/', import.meta.url);
  await mkdir(rounds, { recursive: true });
  await writeFile(new URL(`round-${plan.round}.json`, rounds), JSON.stringify(plan, null, 2) + '\n');
  const resources = await readResourceHits(plan.urls, plan.cities);
  const pending = resources.filter((resource) => resource.hits.size < plan.cities.length);
  const continueRounds = pending.length > 0 && plan.round < plan.inputs.max_rounds;
  let output = `continue=${continueRounds}\n`;
  if (continueRounds) {
    const nextRound = {
      ref: process.env.GITHUB_REF_NAME,
      inputs: {
        ...plan.inputs,
        max_parallel: String(plan.inputs.max_parallel),
        max_rounds: String(plan.inputs.max_rounds),
        previous_run_id: process.env.GITHUB_RUN_ID,
      },
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
