import { positiveInteger } from '../probe-flow.mjs';

export default function defineGlobalping(inputs, scheduled = false) {
  const settings = {
    max_rounds: positiveInteger(scheduled ? 5 : inputs.max_rounds ?? 5, 'max_rounds'),
    max_parallel: positiveInteger(scheduled ? 12 : inputs.max_parallel ?? 12, 'max_parallel'),
  };
  for (const name of ['CN-main', 'CN-aroung', 'global-main']) {
    const value = scheduled ? true : inputs[name] ?? (name === 'CN-main');
    if (![true, false, 'true', 'false'].includes(value)) throw new Error(`${name} must be a boolean.`);
    settings[name] = value === true || value === 'true';
  }
  return { ...settings, steps: [...Array(settings.max_rounds).fill('pending-pairs'), 'analyze'] };
}
