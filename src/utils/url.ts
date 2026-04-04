const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'ref', 'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'msclkid', 'twclid',
  'igshid', 'si', 'feature', 's', 'src',
]);

export function normalizeUrl(raw: string): string {
  const url = new URL(raw);

  // Lowercase hostname and remove www.
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');

  // Remove tracking params
  const params = new URLSearchParams(url.searchParams);
  for (const key of [...params.keys()]) {
    if (TRACKING_PARAMS.has(key) || key.startsWith('utm_')) {
      params.delete(key);
    }
  }

  // Sort remaining params alphabetically
  const sortedParams = new URLSearchParams([...params.entries()].sort());
  url.search = sortedParams.toString();

  // Remove hash fragment (except for known SPA patterns)
  const keepHash = url.hostname === 'github.com' && url.hash.startsWith('#');
  if (!keepHash) {
    url.hash = '';
  }

  // Remove trailing slash (but not for root path)
  let href = url.href;
  if (href.endsWith('/') && url.pathname !== '/') {
    href = href.slice(0, -1);
  }

  return href;
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
