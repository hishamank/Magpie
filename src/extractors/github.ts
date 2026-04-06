import type { ExtractedContent } from './types.js';
import { config } from '../config.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('extractor:github');

export async function extractGitHub(url: string, sourceMetadata?: Record<string, unknown>): Promise<ExtractedContent> {
  logger.info({ url }, 'Extracting GitHub repo');

  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) {
    throw new Error(`Could not parse GitHub URL: ${url}`);
  }

  const [, owner, repo] = match;
  const repoName = repo.replace(/\.git$/, '');

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'bookmark-kb',
  };
  if (config.github.token) {
    headers['Authorization'] = `Bearer ${config.github.token}`;
  }

  // Fetch repo metadata
  const repoResp = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (!repoResp.ok) {
    throw new Error(`GitHub API error: ${repoResp.status}`);
  }

  const repoData = await repoResp.json() as Record<string, unknown>;

  // Fetch README (keep full markdown for LLM consumption)
  let readmeMarkdown = '';
  let readmePlain = '';
  try {
    const readmeResp = await fetch(`https://api.github.com/repos/${owner}/${repoName}/readme`, {
      headers: { ...headers, 'Accept': 'application/vnd.github.v3.raw' },
      signal: AbortSignal.timeout(15_000),
    });
    if (readmeResp.ok) {
      readmeMarkdown = await readmeResp.text();
      readmeMarkdown = readmeMarkdown.replace(/\n{3,}/g, '\n\n').trim();
      // Plain text version for simhash compatibility
      readmePlain = readmeMarkdown
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/#{1,6}\s+/g, '')
        .replace(/[*_`~]+/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
  } catch {
    logger.warn({ owner, repo: repoName }, 'Failed to fetch README');
  }

  const description = repoData.description as string || '';
  const topics = repoData.topics as string[] || [];
  const language = repoData.language as string || '';
  const stars = repoData.stargazers_count as number || 0;
  const forks = repoData.forks_count as number || 0;

  const metaBlock = [
    description,
    `Language: ${language}`,
    `Stars: ${stars} | Forks: ${forks}`,
    topics.length > 0 ? `Topics: ${topics.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  // Markdown version preserves README formatting
  const markdownMeta = [
    `**${owner}/${repoName}** — ${description || 'GitHub Repository'}`,
    '',
    `**Language:** ${language} | **Stars:** ${stars.toLocaleString()} | **Forks:** ${forks.toLocaleString()}`,
    topics.length > 0 ? `**Topics:** ${topics.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  const markdown = markdownMeta + (readmeMarkdown ? '\n\n---\n\n' + readmeMarkdown : '');

  return {
    title: `${owner}/${repoName}: ${description || 'GitHub Repository'}`,
    text: metaBlock + (readmePlain ? '\n\n' + readmePlain : ''),
    markdown,
    author: owner,
    metadata: {
      ...sourceMetadata,
      owner,
      repo: repoName,
      description,
      topics,
      language,
      stars,
      forks,
      archived: repoData.archived,
      license: (repoData.license as Record<string, unknown>)?.spdx_id,
    },
  };
}
