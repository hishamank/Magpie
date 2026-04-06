/**
 * Extract OpenGraph and standard meta tags from HTML.
 */
export interface PageMeta {
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogType?: string;
  ogSiteName?: string;
  twitterCard?: string;
  twitterImage?: string;
  metaDescription?: string;
  metaKeywords?: string[];
  metaAuthor?: string;
  canonical?: string;
}

export function extractMeta(html: string): PageMeta {
  const meta: PageMeta = {};

  const getContent = (pattern: RegExp): string | undefined => {
    const match = html.match(pattern);
    return match?.[1]?.trim() || undefined;
  };

  // OpenGraph
  meta.ogTitle = getContent(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || getContent(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);

  meta.ogDescription = getContent(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
    || getContent(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);

  meta.ogImage = getContent(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || getContent(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

  meta.ogType = getContent(/<meta[^>]+property=["']og:type["'][^>]+content=["']([^"']+)["']/i)
    || getContent(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:type["']/i);

  meta.ogSiteName = getContent(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)
    || getContent(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);

  // Twitter card
  meta.twitterCard = getContent(/<meta[^>]+name=["']twitter:card["'][^>]+content=["']([^"']+)["']/i);
  meta.twitterImage = getContent(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
    || getContent(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);

  // Standard meta tags
  meta.metaDescription = getContent(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    || getContent(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);

  const rawKeywords = getContent(/<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']+)["']/i)
    || getContent(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']keywords["']/i);
  if (rawKeywords) {
    meta.metaKeywords = rawKeywords.split(',').map(k => k.trim()).filter(Boolean);
  }

  meta.metaAuthor = getContent(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i)
    || getContent(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']author["']/i);

  meta.canonical = getContent(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);

  return meta;
}
