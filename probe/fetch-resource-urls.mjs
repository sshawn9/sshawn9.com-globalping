import { writeFile } from 'node:fs/promises';

async function main() {
  const response = await fetch('https://sshawn9.com/resource-inventory.json', {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'sshawn9.com-globalping',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Failed to download resource inventory: HTTP ${response.status}`);

  const raw = await response.text();
  const inventory = JSON.parse(raw);
  if (
    !Array.isArray(inventory?.resources) || inventory.resources.length === 0 ||
    inventory.resources.some((resource) => typeof resource?.url !== 'string' || !resource.url.trim())
  ) {
    throw new Error('Resource inventory must contain a non-empty resources array with a URL for each resource.');
  }

  const urls = inventory.resources.map((resource) => resource.url);
  await writeFile(new URL('./resources/resource-inventory.json', import.meta.url), raw);
  await writeFile(new URL('./resources/urls.json', import.meta.url), JSON.stringify(urls, null, 2) + '\n');
  console.log(`Saved resource inventory and ${urls.length} resource URLs to probe/resources/`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
