import { config } from '../config.js';
import type { BookmarkInput } from './types.js';
import { getLogger } from '../utils/logger.js';
import fs from 'node:fs';

const logger = getLogger('collector:twitter');

// Public bearer token used by the Twitter web app
const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// GraphQL query hash for bookmarks endpoint (may need updating if Twitter changes it)
const BOOKMARKS_QUERY_ID = 'YCrjINs3IPbkSl5FQf_tpA';

const FEATURES = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

interface RawCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expirationDate?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/**
 * Extract auth_token and ct0 (CSRF token) from the cookies file.
 */
function extractAuthFromCookies(cookiePath: string): { authToken: string; csrfToken: string } | null {
  const raw = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
  const cookies: RawCookie[] = Array.isArray(raw) ? raw : [];

  const xCookies = cookies.filter(c =>
    c.domain.includes('twitter.com') || c.domain.includes('x.com')
  );

  const authToken = xCookies.find(c => c.name === 'auth_token')?.value;
  const csrfToken = xCookies.find(c => c.name === 'ct0')?.value;

  if (!authToken || !csrfToken) {
    logger.warn('Missing auth_token or ct0 in cookies file');
    return null;
  }

  return { authToken, csrfToken };
}

/**
 * Fetch a page of bookmarks from the Twitter GraphQL API.
 */
async function fetchBookmarksPage(
  auth: { authToken: string; csrfToken: string },
  cursor?: string,
): Promise<{ entries: unknown[]; bottomCursor: string | null }> {
  const variables: Record<string, unknown> = {
    count: 20,
    includePromotedContent: true,
  };
  if (cursor) {
    variables.cursor = cursor;
  }

  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(FEATURES),
  });

  const url = `https://x.com/i/api/graphql/${BOOKMARKS_QUERY_ID}/Bookmarks?${params}`;

  const response = await fetch(url, {
    headers: {
      'accept': '*/*',
      'authorization': `Bearer ${BEARER_TOKEN}`,
      'content-type': 'application/json',
      'cookie': `auth_token=${auth.authToken}; ct0=${auth.csrfToken}`,
      'x-csrf-token': auth.csrfToken,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': 'en',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    const waitSecs = retryAfter ? parseInt(retryAfter, 10) : 60;
    logger.warn({ waitSecs }, 'Rate limited by Twitter, waiting');
    await new Promise(r => setTimeout(r, waitSecs * 1000));
    return fetchBookmarksPage(auth, cursor); // retry after wait
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twitter API error (${response.status}): ${text.slice(0, 200)}`);
  }

  const data = await response.json() as Record<string, unknown>;

  // Navigate the nested response structure
  const timeline = (data?.data as Record<string, unknown>)
    ?.bookmark_timeline_v2 as Record<string, unknown>;
  const instructions = ((timeline?.timeline as Record<string, unknown>)
    ?.instructions as unknown[]) || [];

  let entries: unknown[] = [];
  for (const instruction of instructions) {
    const inst = instruction as Record<string, unknown>;
    if (inst.type === 'TimelineAddEntries' || inst.entries) {
      entries = (inst.entries as unknown[]) || [];
      break;
    }
  }

  // Find the bottom cursor for pagination
  let bottomCursor: string | null = null;
  for (const entry of entries) {
    const e = entry as Record<string, unknown>;
    const entryId = e.entryId as string || '';
    if (entryId.startsWith('cursor-bottom')) {
      const content = e.content as Record<string, unknown>;
      bottomCursor = content?.value as string || null;
    }
  }

  return { entries, bottomCursor };
}

/**
 * Extract a BookmarkInput from a tweet entry in the API response.
 */
function parseTweetEntry(entry: Record<string, unknown>): BookmarkInput | null {
  const entryId = entry.entryId as string || '';
  if (entryId.startsWith('cursor-')) return null;

  const content = entry.content as Record<string, unknown>;
  const itemContent = content?.itemContent as Record<string, unknown>;
  const tweetResults = itemContent?.tweet_results as Record<string, unknown>;

  let result = tweetResults?.result as Record<string, unknown>;
  if (!result) return null;

  // Handle TweetWithVisibilityResults wrapper
  if (result.__typename === 'TweetWithVisibilityResults') {
    result = result.tweet as Record<string, unknown>;
    if (!result) return null;
  }

  // Skip non-tweet types (e.g., TweetTombstone)
  if (result.__typename !== 'Tweet') return null;

  const legacy = result.legacy as Record<string, unknown>;
  if (!legacy) return null;

  const tweetId = legacy.id_str as string || '';
  if (!tweetId) return null;

  // Extract user info
  const core = result.core as Record<string, unknown>;
  const userResults = core?.user_results as Record<string, unknown>;
  const userResult = userResults?.result as Record<string, unknown>;
  const userCore = userResult?.core as Record<string, unknown>;
  const userLegacy = userResult?.legacy as Record<string, unknown>;
  const screenName = (userCore?.screen_name as string) || '';
  const displayName = (userCore?.name as string) || '';

  // Extract tweet text
  const fullText = (legacy.full_text as string) || '';

  // Extract timestamp
  const createdAt = legacy.created_at as string || '';

  // Extract shared URLs (expanded URLs from t.co links)
  const entities = legacy.entities as Record<string, unknown> || {};
  const urlEntities = (entities.urls as Record<string, unknown>[]) || [];
  const sharedUrls = urlEntities
    .map(u => u.expanded_url as string)
    .filter(u => u && (
      // Allow x.com/i/article URLs (X Articles / long-form blog posts)
      u.includes('x.com/i/article') ||
      // Filter out other twitter/x.com self-references
      (!u.includes('twitter.com') && !u.includes('x.com'))
    ));

  // Extract media
  const extEntities = (legacy.extended_entities as Record<string, unknown>) || entities;
  const mediaEntities = (extEntities.media as Record<string, unknown>[]) || [];
  const mediaTypes = mediaEntities.map(m => m.type as string);
  const mediaUrls = mediaEntities.map(m => ({
    type: m.type as string,
    url: (m.media_url_https as string) || (m.media_url as string) || '',
    videoUrl: ((m.video_info as Record<string, unknown>)?.variants as Record<string, unknown>[])
      ?.filter(v => (v.content_type as string)?.includes('video/mp4'))
      ?.sort((a, b) => ((b.bitrate as number) || 0) - ((a.bitrate as number) || 0))
      ?.[0]?.url as string | undefined,
  }));

  // Engagement metrics
  const metrics = {
    retweets: legacy.retweet_count as number || 0,
    likes: legacy.favorite_count as number || 0,
    replies: legacy.reply_count as number || 0,
    quotes: legacy.quote_count as number || 0,
    bookmarks: legacy.bookmark_count as number || 0,
    views: (result.views as Record<string, unknown>)?.count as string || '0',
  };

  // Quoted tweet info
  const quotedResult = result.quoted_status_result as Record<string, unknown>;
  let quotedInfo: Record<string, unknown> | undefined;
  if (quotedResult?.result) {
    const qr = quotedResult.result as Record<string, unknown>;
    const ql = qr.legacy as Record<string, unknown>;
    const qCore = (qr.core as Record<string, unknown>)?.user_results as Record<string, unknown>;
    const qUser = (qCore?.result as Record<string, unknown>)?.core as Record<string, unknown>;
    quotedInfo = {
      text: ql?.full_text || '',
      author: qUser?.screen_name || '',
      id: ql?.id_str || '',
    };
  }

  // X Article detection (long-form blog posts embedded in tweets)
  const articleData = result.article as Record<string, unknown> | undefined;
  let articleInfo: Record<string, unknown> | undefined;
  if (articleData) {
    const articleResults = (articleData.article_results as Record<string, unknown>)?.result as Record<string, unknown>;
    if (articleResults) {
      articleInfo = {
        articleId: articleResults.rest_id as string || '',
        title: articleResults.title as string || '',
        previewText: articleResults.preview_text as string || '',
        articleUrl: `https://x.com/i/article/${articleResults.rest_id as string || ''}`,
      };
    }
  }

  // Conversation/thread detection
  const isReply = !!(legacy.in_reply_to_status_id_str as string);
  const replyToUser = legacy.in_reply_to_screen_name as string || undefined;

  const tweetUrl = `https://x.com/${screenName}/status/${tweetId}`;

  // Determine bookmark URL:
  // - If tweet has an X article, use the article URL
  // - If tweet shares an external URL, use that
  // - Otherwise use the tweet URL
  const primaryUrl = articleInfo?.articleUrl as string || sharedUrls[0] || tweetUrl;

  const timestamp = createdAt ? new Date(createdAt) : new Date();

  return {
    url: primaryUrl,
    title: articleInfo ? articleInfo.title as string : fullText.slice(0, 100),
    source: 'twitter',
    sourceId: tweetId,
    mediaType: articleInfo ? 'x-article' : sharedUrls.length > 0 ? 'article' : 'tweet',
    sourceMetadata: {
      tweetUrl,
      tweetText: fullText,
      authorHandle: screenName,
      authorName: displayName,
      authorFollowers: (userLegacy?.followers_count as number) || 0,
      timestamp: createdAt,
      sharedUrl: sharedUrls[0] || null,
      sharedUrls: sharedUrls.length > 1 ? sharedUrls : undefined,
      media: mediaUrls.length > 0 ? mediaUrls : undefined,
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
      metrics,
      quotedTweet: quotedInfo,
      article: articleInfo,
      isReply,
      replyToUser,
      isThread: isReply && replyToUser === screenName,
    },
    collectedAt: timestamp,
  };
}

export async function collectTwitterBookmarks(options?: { limit?: number }): Promise<BookmarkInput[]> {
  if (!fs.existsSync(config.twitter.cookiesPath)) {
    logger.warn({ path: config.twitter.cookiesPath }, 'Twitter cookies file not found, skipping');
    return [];
  }

  const auth = extractAuthFromCookies(config.twitter.cookiesPath);
  if (!auth) {
    logger.error('Could not extract auth credentials from cookies');
    return [];
  }

  const limit = options?.limit ?? Infinity;
  logger.info({ limit }, 'Collecting Twitter bookmarks via API');

  const bookmarks: BookmarkInput[] = [];
  const seenIds = new Set<string>();
  let cursor: string | undefined;
  let pageNum = 0;

  while (bookmarks.length < limit) {
    pageNum++;
    const { entries, bottomCursor } = await fetchBookmarksPage(auth, cursor);

    let newTweets = 0;
    for (const entry of entries) {
      if (bookmarks.length >= limit) break;

      const bookmark = parseTweetEntry(entry as Record<string, unknown>);
      if (!bookmark || seenIds.has(bookmark.sourceId!)) continue;

      seenIds.add(bookmark.sourceId!);
      bookmarks.push(bookmark);
      newTweets++;
    }

    logger.info({ page: pageNum, newTweets, total: bookmarks.length, hasMore: !!bottomCursor }, 'Twitter page fetched');

    // Stop if no more pages
    if (!bottomCursor || newTweets === 0) {
      logger.info({ total: bookmarks.length }, 'Reached end of Twitter bookmarks');
      break;
    }

    cursor = bottomCursor;

    // Polite delay between requests
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
  }

  logger.info({ count: bookmarks.length }, 'Twitter bookmarks collected');
  return bookmarks;
}
