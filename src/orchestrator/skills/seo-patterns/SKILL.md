---
name: seo-patterns
description: "Implements technical SEO: meta tags, JSON-LD structured data, sitemaps, crawlability fixes. Use when adding schema markup, JSON-LD, robots.txt updates, canonical URLs, Open Graph tags, or improving crawlability."
---

# SEO Patterns

## Core Principles

- Unique `<title>` + `<meta name="description">` per public page
- Structured data MUST pass Google's Rich Results Test before shipping
- Server-render indexable content; canonical URL on every page

## Implementation Workflow

1. Add meta tags + canonical URLs in server-rendered HTML.
   - Checkpoint: every page has unique `<title>` + description.
2. Add JSON-LD for page type (server-rendered).
   - Checkpoint: Rich Results Test → 0 errors.
3. Generate sitemap + reference from `robots.txt`.
   - Checkpoint: sitemap URL accessible, listed in `robots.txt`.
4. Verify `robots.txt` allows public pages.
   - Recovery: remove accidental `Disallow:` entries; resubmit sitemap.
5. Monitor Search Console for warnings post-deploy.

## Meta Tags & Open Graph

```tsx
export const metadata: Metadata = {
  title: 'Product Name — Short Descriptor',
  description: 'Concise 150-160 char description with primary keyword.',
  alternates: { canonical: 'https://example.com/page-slug' },
  openGraph: {
    title: 'Product Name — Short Descriptor',
    description: 'Concise description for social sharing.',
    url: 'https://example.com/page-slug',
    type: 'website',
    images: [{ url: 'https://example.com/og-image.jpg', width: 1200, height: 630 }],
  },
  twitter: { card: 'summary_large_image', title: 'Product Name — Short Descriptor', images: ['https://example.com/og-image.jpg'] },
  robots: { index: true, follow: true },
};
```

**Constraints:** title 50–60 chars · description 150–160 chars · OG image 1200×630 px · `noindex` only on admin/draft pages.

## Structured Data (JSON-LD)

```tsx
function StructuredData({ breadcrumbs, article }: Props) {
  const breadcrumbLd = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: breadcrumbs.map((crumb, i) => ({ '@type': 'ListItem', position: i + 1, name: crumb.label, item: crumb.url })),
  };
  const articleLd = {
    '@context': 'https://schema.org', '@type': 'Article',
    headline: article.title, description: article.summary,
    image: article.imageUrl, datePublished: article.publishedAt,
    dateModified: article.updatedAt, author: { '@type': 'Person', name: article.author },
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(articleLd) }} />
    </>
  );
}
```

**Validate:** `curl -s https://example.com/page | pup 'script[type=application/ld+json] text{}' | jq .` then run Google's Rich Results Test (https://search.google.com/test/rich-results).

## Sitemap & robots.txt

- Generate XML sitemap dynamically from your data source (CMS, DB, filesystem)
- Use **sitemap index** when >50,000 URLs or >50 MB
- Include `<lastmod>` only if accurate

```txt
User-agent: *
Allow: /
Disallow: /admin/
Disallow: /api/
Disallow: /preview/
Sitemap: https://example.com/sitemap.xml
```

## Anti-Patterns

- Duplicate titles across pages
- Missing canonical URL → duplicate content
- Client-only rendered primary content → not indexed
- Unvalidated structured data shipped to prod
- Page load >3s on mobile
