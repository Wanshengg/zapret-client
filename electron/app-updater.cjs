const API_URL = 'https://api.github.com/repos/Wanshengg/zapret-client/releases/latest';
const RELEASES_URL = 'https://github.com/Wanshengg/zapret-client/releases/latest';

function parseVersion(value) {
  const match = String(value ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;
    const leftNumber = /^\d+$/.test(left[index]);
    const rightNumber = /^\d+$/.test(right[index]);
    if (leftNumber && rightNumber) return Number(left[index]) - Number(right[index]);
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    return left[index].localeCompare(right[index]);
  }
  return 0;
}

function isNewerVersion(latest, current) {
  const left = parseVersion(latest);
  const right = parseVersion(current);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] > right.numbers[index];
  }
  return comparePrerelease(left.prerelease, right.prerelease) > 0;
}

async function githubLatestApp(currentVersion, fetchImpl = fetch) {
  const response = await fetchImpl(API_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Zapret-Client', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`GitHub вернул HTTP ${response.status}`);
  const release = await response.json();
  if (!parseVersion(release.tag_name)) throw new Error('В релизе клиента указана некорректная версия');
  const installer = release.assets?.find((item) => /\.exe$/i.test(item.name));
  return {
    version: release.tag_name.replace(/^v/i, ''),
    url: release.html_url || RELEASES_URL,
    downloadUrl: installer?.browser_download_url || release.html_url || RELEASES_URL,
    notes: release.body || '',
    publishedAt: release.published_at || null,
    available: isNewerVersion(release.tag_name, currentVersion),
  };
}

module.exports = { githubLatestApp, isNewerVersion, parseVersion };
