import { selectPendingPairs } from './probe-targets.mjs';

export function positiveInteger(value, name) {
  const number = Number(value);
  if (!['number', 'string'].includes(typeof value) || !Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
}

export function validateFlow(flow) {
  if (!Array.isArray(flow.steps) || flow.steps.some((step) => !['pending-pairs', 'analyze'].includes(step)) ||
    !Number.isSafeInteger(flow.position) || flow.position < 0 || flow.position > flow.steps.length) {
    throw new Error('Invalid probe flow.');
  }
  flow.max_parallel = positiveInteger(flow.max_parallel, 'max_parallel');
}

export function nextTask(flow, targets, hits) {
  while (flow.position < flow.steps.length) {
    const type = flow.steps[flow.position];
    if (type === 'analyze') return { type, tasks: [] };
    const tasks = selectPendingPairs(targets, hits).tasks;
    if (tasks.length) return { type, tasks };
    flow.position += 1;
  }
  return { type: 'done', tasks: [] };
}
