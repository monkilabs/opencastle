---
name: seo-patterns
description: "Technical SEO patterns for meta tags, structured data, sitemaps, URL strategy, and rendering. Use when optimizing pages for search engines or implementing SEO features."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# SEO Patterns

## Core Principles

- Every public page MUST have a unique `<title>` and `<meta name="description">`.
- Structured data MUST validate against Google's Rich Results Test before shipping.
- Server-render all content critical for indexing — never rely on client-side JS for primary content.
- Canonical URLs are mandatory on every page to prevent duplicate content issues.

## Meta Tags & Open Graph

```tsx
// Next.js App Router — layout or page metadata
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
  twitter: {
    card: 'summary_large_image',
    title: 'Product Name — Short Descriptor',
    images: ['https://example.com/og-image.jpg'],
  },
  robots: { index: true, follow: true },
};
```

### Meta Tag Checklist

- [ ] `<title>` is unique, 50-60 chars, includes primary keyword
- [ ] `<meta name="description">` is unique, 150-160 chars, includes CTA
- [ ] `<link rel="canonical">` points to the single authoritative URL
- [ ] `og:title`, `og:description`, `og:image` (1200×630 px min), `og:type` are set
- [ ] `twitter:card`, `twitter:title`, `twitter:image` are set
- [ ] `robots` directives are correct (`noindex` on admin/draft pages only)

## Structured Data (JSON-LD)

Use JSON-LD `<script>` blocks — never microdata or RDFa. Choose schema types based on page purpose:

| Page Type | Schema Type(s) | Required Properties |
|-----------|----------------|---------------------|
| Homepage | `WebSite`, `Organization` | `name`, `url`, `searchAction`, `logo` |
| Detail page | `Product`, `Article`, or domain-specific type | `name`, `description`, `image` |
| Listing / category page | `ItemList` + `ListItem` | `itemListElement`, `position`, `url` |
| Breadcrumb navigation | `BreadcrumbList` | `itemListElement`, `position`, `name` |
| Blog post | `Article` or `BlogPosting` | `headline`, `datePublished`, `author` |
| FAQ page | `FAQPage` | `mainEntity` with `Question` + `Answer` |

### Example: Breadcrumb + Article

```tsx
function StructuredData({ breadcrumbs, article }: Props) {
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbs.map((crumb, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: crumb.label,
      item: crumb.url,
    })),
  };

  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.summary,
    image: article.imageUrl,
    datePublished: article.publishedAt,
    dateModified: article.updatedAt,
    author: { '@type': 'Person', name: article.author },
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(articleLd) }} />
    </>
  );
}
```

### Validation

- Validate every JSON-LD block via [Google's Rich Results Test](https://search.google.com/test/rich-results) and [schema.org](https://schema.org) definitions before merging.
- Check Search Console **Enhancements** report after deployment.

## Sitemap & Crawlability

- Generate an XML sitemap dynamically from your data source (CMS, database, filesystem).
- Use a **sitemap index** when page count exceeds 50,000 URLs or file size exceeds 50 MB.
- Include `<lastmod>` timestamps — omit if you can't guarantee accuracy.
- Submit sitemaps via Google Search Console and reference them in `robots.txt`.

### Example: robots.txt

```txt
User-agent: *
Allow: /
Disallow: /admin/
Disallow: /api/
Disallow: /preview/

Sitemap: https://example.com/sitemap.xml
```

### Crawlability Checklist

- [ ] `robots.txt` allows crawling of all public pages
- [ ] `robots.txt` blocks admin, API, and preview routes
- [ ] XML sitemap is auto-generated and up to date
- [ ] Sitemap is referenced in `robots.txt`
- [ ] Internal links connect all public pages (no orphan pages)
- [ ] Page load time < 3s (crawl budget efficiency)

## URL Strategy

| Pattern | Good | Bad |
|---------|------|-----|
| Slug format | `/products/blue-widget` | `/products/Blue_Widget` |
| Hierarchy | `/blog/2026/seo-tips` | `/blog?id=42` |
| Consistency | Always `/path/` or `/path` | Mixed trailing slashes |
| Parameters | `/products?sort=price` | `/products/sort/price/asc` |

### Redirect Example (Next.js)

```ts
// next.config.ts
const nextConfig = {
  async redirects() {
    return [
      { source: '/old-page', destination: '/new-page', permanent: true },
      { source: '/blog/:slug/amp', destination: '/blog/:slug', permanent: true },
    ];
  },
};
```

## Rendering & Indexability

- **Server-render** all indexed content — titles, descriptions, body text, structured data. Client-hydrated interactive elements are fine.
- Use semantic HTML (`<h1>`–`<h6>`, `<article>`, `<nav>`, `<main>`) for crawler structure.

### Image SEO

| Attribute | Purpose | Example |
|-----------|---------|---------|
| `alt` | Describes image for screen readers + crawlers | `alt="Blue widget on white background"` |
| `loading` | Lazy-load below-fold images | `loading="lazy"` |
| `width` / `height` | Prevents layout shift (CLS) | `width={800} height={600}` |
| File name | Keyword signal | `blue-widget-front.webp` |
| Format | Performance + quality | Use WebP/AVIF with JPEG fallback |

### Indexability Checklist

- [ ] Primary content renders in initial HTML (view source, not inspect)
- [ ] `<h1>` is unique per page and contains the primary keyword
- [ ] Structured data is present in the server-rendered HTML
- [ ] Images have descriptive `alt` text
- [ ] No `noindex` on pages that should be indexed
- [ ] Hydration does not remove or rewrite structured data scripts

## Anti-Patterns

| Anti-Pattern | Why It's Bad | Correct Approach |
|---|---|---|
| Duplicate `<title>` across pages | Dilutes ranking signals; confuses crawlers | Unique, keyword-specific title per page |
| Missing canonical URL | Causes duplicate content penalties | Add `<link rel="canonical">` to every page |
| Client-only rendered content | Googlebot may not execute JS reliably | Server-render all indexable content |
| Hardcoded sitemap file | Goes stale as pages are added/removed | Generate sitemap dynamically from data source |
| Using `noindex` as a "temporary" fix | Often forgotten; pages stay de-indexed | Fix the underlying issue instead |
| Stuffing keywords in meta tags | Penalized by search engines | Write natural, user-focused descriptions |
| Missing `alt` text on images | Lost image search traffic + accessibility failure | Descriptive alt text on every meaningful image |
| Structured data without validation | Silent errors cause rich result loss | Validate with Google Rich Results Test before merge |
| Blocking CSS/JS in `robots.txt` | Prevents Googlebot from rendering the page | Only block admin/API routes |
| Mixed trailing slash URLs | Splits link equity between two URLs | Pick one convention, 301-redirect the other |
