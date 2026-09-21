import { mkdir, writeFile } from 'node:fs/promises';
import { analyzeProbeResults } from './analyze-probe-results.mjs';

const escape = (value) => String(value ?? '—').replace(/[&<>|\r\n`*_[\]\\]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '\r': ' ', '\n': ' ',
  '`': '&#96;', '*': '&#42;', '_': '&#95;', '[': '&#91;', ']': '&#93;', '\\': '&#92;',
})[char]);
const list = (values) => values.length ? values.map(escape).join(', ') : '—';
const percent = (hits, total) => hits !== null && total > 0 ? `${(hits / total * 100).toFixed(2)}%` : '—';
const ratio = (hits, total) => `${hits ?? '—'}/${total ?? '—'} (${percent(hits, total)})`;
const count = (value, known) => value ?? `≥ ${known} (incomplete)`;
const gain = (value, attempts) => attempts > 0 ? (value / attempts * 100).toFixed(2) : '—';
const timing = ({ n, p50, p95 }) => n ? `${p50.toFixed(1)} / ${p95.toFixed(1)} (n=${n})` : '—';

function table(title, columns, rows, { empty = 'No records.', folded = false } = {}) {
  if (!rows.length) return `## ${title}\n\n${empty}\n`;
  const body = [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
  return `## ${title}\n\n${folded ? `<details><summary>${rows.length} rows</summary>\n\n${body}\n\n</details>` : body}\n`;
}

export function renderProbeSummary(report, components = []) {
  const groups = new Map(components.filter((item) => item.group).map((item) => [item.id, item.name]));
  const locations = new Map();
  for (const item of components) {
    const match = /-\s*\(([A-Z]{3})\)$/.exec(item.name);
    if (match) locations.set(match[1], { place: item.name.slice(0, match.index).trim(), region: groups.get(item.group_id) });
  }
  const { overview: o } = report;
  const cityMisses = report.cities.filter((city) => city.misses.length)
    .sort((a, b) => b.misses.length - a.misses.length || a.city.localeCompare(b.city));
  const resourceMisses = report.resources.filter((resource) => resource.misses.length)
    .sort((a, b) => b.misses.length - a.misses.length || a.url.localeCompare(b.url));
  return {
    overview: '# Globalping probe results\n\n' + table('Overview', ['Metric', 'Value'], [
      ['Resources: attempted / total', `${count(o.attemptedResources, o.knownAttemptedResources)} / ${o.resourceCount}`],
      ['Cities / selected groups', `${o.cityCount} / ${list(o.groups)}`],
      ['Rounds / limit', `${o.roundCount} / ${o.maxRounds}`],
      ['Probe runners / reached colos', `${o.runnerCount} / ${o.coloCount}`],
      ['HIT records / attempts', ratio(o.hitRecords, o.attemptedRecords)],
      ['HIT resource × city pairs / total', ratio(o.hitCityPairs, o.totalCityPairs)],
    ]) + (o.missingRunnerStats.length
      ? `\n**Incomplete runner statistics:** ${list(o.missingRunnerStats)}. Known attempts: ${o.knownAttemptedRecords}.\n`
      : ''),
    rounds: table('Rounds', ['Round', 'Resources attempted', 'Attempts', 'New city pairs', 'New colo pairs',
      'Cumulative city coverage', 'New pairs per 100 attempts: city / colo'], report.rounds.map((round) => [
      round.round, count(round.attemptedResources, round.knownAttemptedResources),
      count(round.attemptedRecords, round.knownAttemptedRecords), round.newCityPairs, round.newColoPairs,
      ratio(round.cumulativeCityPairs, o.totalCityPairs),
      `${gain(round.newCityPairs, round.attemptedRecords)} / ${gain(round.newColoPairs, round.attemptedRecords)}`,
    ])),
    'missing-cities': table('MISS by city', ['City', 'MISS resources / total', 'Resources'], cityMisses.map((city) => [
      escape(city.city), `${city.misses.length}/${o.resourceCount}`, city.misses.map((id) => `[${id}]`).join(', '),
    ]), { empty: 'All resources hit in every city.' }) + (resourceMisses.length
      ? '\n' + resourceMisses.map(({ id, url }) => `[${id}]: <${url.replace(/\|/g, '%7C')}>`).join('\n') + '\n'
      : ''),
    'missing-resources': table('MISS by resource', ['Resource', 'Resource URL', 'MISS cities / total', 'Cities'],
      resourceMisses.map((resource) => [resource.id, `<code>${escape(resource.url)}</code>`,
        `${resource.misses.length}/${o.cityCount}`, list(resource.misses)]), { empty: 'All cities hit for every resource.' }),
    colos: table('Cloudflare colos', ['Colo', 'Location / region', 'HIT resources / observed', 'Source cities', 'Sources'],
      report.colos.map((colo) => {
        const location = locations.get(colo.code);
        return [escape(colo.code), `${escape(location?.place)} / ${escape(location?.region)}`,
          ratio(colo.hits, colo.resources), list(colo.cities), list(colo.sources)];
      })),
    sources: table('Probe sources', ['Source', 'City', 'Network / ASN', 'HIT / returned records', 'Colos',
      'Total P50 / P95 (ms)', 'First byte P50 / P95 (ms)'], report.sources.map((source) => [
      source.id, escape(source.city), `${list(source.networks)} / ${source.asn === null ? '—' : `AS${source.asn}`}`,
      ratio(source.hits, source.records), list(source.colos), timing(source.total), timing(source.firstByte),
    ]), { folded: true }),
    runners: table('Probe runners', ['Round / batch', 'Public IP', 'Starting quota', 'HIT / attempts'],
      report.runners.map((runner) => [`${runner.round} / ${runner.batch}`, escape(runner.publicIP),
        runner.availableQuota ?? '—', ratio(runner.hitRecords, runner.attemptedRecords)]), { folded: true }),
  };
}

async function main() {
  const report = await analyzeProbeResults();
  let components = [];
  let locationError = '';
  if (report.colos.length) {
    try {
      const response = await fetch('https://www.cloudflarestatus.com/api/v2/components.json', {
        headers: { 'User-Agent': 'sshawn9.com-globalping (+https://github.com/sshawn9/sshawn9.com-globalping)' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw = await response.text();
      const data = JSON.parse(raw);
      if (!Array.isArray(data.components)) throw new Error('Invalid components response.');
      components = data.components;
      await writeFile(new URL('./resources/cloudflare-components.json', import.meta.url), raw);
    } catch (error) {
      locationError = `Cloudflare location lookup failed: ${error.message}. Colo codes are still included.`;
      console.error(locationError);
    }
  }
  const sections = renderProbeSummary(report, components);
  if (locationError) sections.colos += `\n${escape(locationError)}\n`;
  const directory = new URL('./summary/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('./probe-summary.md', import.meta.url), Object.values(sections).join('\n'));
  for (const [name, markdown] of Object.entries(sections)) {
    await writeFile(new URL(`${name}.md`, directory), markdown);
    if (Buffer.byteLength(markdown) > 1024 * 1024) {
      throw new Error(`Summary section ${name} exceeds GitHub's 1 MiB step limit. Full report saved to probe/probe-summary.md.`);
    }
  }
  console.log(`Summarized ${report.overview.roundCount} rounds, ${report.overview.resourceCount} resources and ${report.overview.cityCount} cities.`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
