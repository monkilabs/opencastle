---
name: seo-patterns
description: "Technical SEO patterns for meta tags, structured data, sitemaps, URL strategy, and rendering. Use when optimizing pages for search engines or implementing SEO features."
---

# SEO Patterns

## Core Principles

- Every public page MUST have a unique `<title>` and `<meta name="description">`.
- Structured data MUST validate against Google's Rich Results Test before shipping.
- Server-render all content critical for indexing — never rely on client-side JS for primary content.
- Canonical URLs are mandatory on every page to prevent duplicate content issues.

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

**Checklist:** unique title (50-60 chars) · unique description (150-160 chars) · canonical URL · `og:title/description/image` (1200×630 px) · `og:type` · `twitter:card/title/image` · `noindex` only on admin/draft pages.

## Structured Data (JSON-LD)

Use JSON-LD `<script>` blocks — never microdata or RDFa.

| Page Type | Schema Type(s) | Required Properties |
|-----------|----------------|---------------------|
| Homepage | `WebSite`, `Organization` | `name`, `url`, `searchAction`, `logo` |
| Detail page | `Product`, `Article`, or domain type | `name`, `description`, `image` |
| Listing page | `ItemList` + `ListItem` | `itemListElement`, `position`, `url` |
| Breadcrumbs | `BreadcrumbList` | `itemListElement`, `position`, `name` |
| Blog post | `Article` / `BlogPosting` | `headline`, `datePublished`, `author` |
| FAQ page | `FAQPage` | `mainEntity` with `Question` + `Answer` |

### Example: Breadcrumb + Article

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

Validate every block via [Google's Rich Results Test](https://search.google.com/test/rich-results) before merging. Check Search Console **Enhancements** after deployment.

## Sitemap & Crawlability

- Generate XML sitemap dynamically from your data source (CMS, DB, filesystem).
- Use a **sitemap index** when >50,000 URLs or >50 MB.
- Include `<lastmod>` only if accurate; submit via Google Search Console and reference in `robots.txt`.

```txt
User-agent: *
Allow: /
Disallow: /admin/
Disallow: /api/
Disallow: /preview/
Sitemap: https://example.com/sitemap.xml
```

**Checklist:** robots.txt allows all public pages · blocks admin/API/preview · XML sitemap auto-generated and current · referenced in robots.txt · no orphan pages · page load < 3s.

## URL Strategy

| Pattern | Good | Bad |
|---------|------|-----|
| Slug format | `/products/blue-widget` | `/products/Blue_Widget` |
| Hierarchy | `/blog/2026/seo-tips` | `/blog?id=42` |
| Consistency | Always `/path/` or `/path` | Mixed trailing slashes |
| Parameters | `/products?sort=price` | `/products/sort/price/asc` |

```ts
// next.config.ts
const redirects = [
  { source: '/old-page', destination: '/new-page', permanent: true },
  { source: '/blog/:slug/amp', destination: '/blog/:slug', permanent: true },
];
```

## Rendering & Indexability

Server-render all indexed content. Use semantic HTML (`<h1>`–`<h6>`, `<article>`, `<nav>`, `<main>`) for crawler structure.

| Image Attribute | Purpose | Example |
|-----------------|---------|---------|
| `alt` | Describes for crawlers + screen readers | `alt="Blue widget on white background"` |
| `loading` | Lazy-load below-fold | `loading="lazy"` |
| `width` / `height` | Prevents CLS | `width={800} height={600}` |
| File name | Keyword signal | `blue-widget-front.webp` |
| Format | Performance + quality | WebP/AVIF with JPEG fallback |

**Checklist:** primary content in initial HTML · unique `<h1>` with primary keyword · structured data in SSR HTML · descriptive `alt` on all images · no stray `noindex` · hydration preserves structured data scripts.

## Anti-Patterns

| Anti-Pattern | Why It's Bad | Correct Approach |
|---|---|---|
| Duplicate `<title>` | Dilutes ranking signals | Unique, keyword-specific title per page |
| Missing canonical URL | Duplicate content penalties | Add `<link rel="canonical">` to every page |
| Client-only rendered content | Googlebot may miss JS | Server-render all indexable content |
| Hardcoded sitemap | Goes stale | Generate sitemap dynamically |
| `noindex` as "temporary" fix | Often forgotten | Fix the underlying issue |
| Keyword stuffing in meta tags | Penalized by search engines | Natural, user-focused descriptions |
| Missing `alt` on images | Lost image traffic + a11y failure | Descriptive alt on every meaningful image |
| Unvalidated structured data | Silent errors = rich result loss | Validate with Rich Results Test before merge |
| Blocking CSS/JS in robots.txt | Prevents page rendering | Only block admin/API routes |
| Mixed trailing slash URLs | Splits link equity | Pick one convention, 301-redirect other |
