import { config } from '../config.js';
import type { BookmarkInput } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('collector:github');

export async function collectGitHubStars(options?: { limit?: number }): Promise<BookmarkInput[]> {
  if (!config.github.token) {
    logger.warn('GITHUB_TOKEN not configured, skipping GitHub collection');
    return [];
  }

  const bookmarks: BookmarkInput[] = [];
  let page = 1;
  const perPage = 100;
  const limit = options?.limit ?? Infinity;

  logger.info('Collecting GitHub starred repos');

  while (bookmarks.length < limit) {
    const resp = await fetch(`https://api.github.com/user/starred?page=${page}&per_page=${perPage}`, {
      headers: {
        'Authorization': `Bearer ${config.github.token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'bookmark-kb',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      throw new Error(`GitHub API error: ${resp.status} ${await resp.text()}`);
    }

    const repos = await resp.json() as Record<string, unknown>[];
    if (repos.length === 0) break;

    for (const repo of repos) {
      if (bookmarks.length >= limit) break;

      bookmarks.push({
        url: repo.html_url as string,
        title: `${repo.full_name}: ${repo.description || ''}`,
        source: 'github',
        sourceId: repo.full_name as string,
        mediaType: 'repo',
        sourceMetadata: {
          description: repo.description,
          topics: repo.topics,
          language: repo.language,
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          updatedAt: repo.updated_at,
        },
        collectedAt: new Date(),
      });
    }

    // Check if there are more pages
    const linkHeader = resp.headers.get('Link') || '';
    if (!linkHeader.includes('rel="next"')) break;
    page++;

    // Rate limiting: small delay between pages
    await new Promise(r => setTimeout(r, 500));
  }

  logger.info({ count: bookmarks.length }, 'GitHub stars collected');
  return bookmarks;
}
