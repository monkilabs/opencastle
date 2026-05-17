---
name: seo-patterns
description: "Implements technical SEO: meta tags, JSON-LD structured data, sitemaps, crawlability fixes. Use when adding schema markup, JSON-LD, robots.txt updates, canonical URLs, Open Graph tags, or improving crawlability."
---

# SEO Patterns

## Core Principles

- Every public page MUST have unique `<title>`, `<meta name="description">`.
- Structured data MUST validate against Google's Rich Results Test before shipping.
- Server-render all content critical for indexing.
- Canonical URLs mandatory on every page.

## Implementation Workflow

1. Add meta tags, canonical URLs in server-rendered HTML.
  - Checkpoint: every page has unique `<title>`, `<meta name="description">`.
2. Add structured data (JSON-LD) for page type; keep blocks server-rendered.
  - Checkpoint: Rich Results Test passes with zero errors.
3. Generate / update sitemap; reference from `robots.txt`.
  - Checkpoint: sitemap URL present in `robots.txt`, accessible.
4. Verify robots.txt rules; ensure public pages allowed.
  - Recovery: remove accidental `Disallow:` entries; re-submit sitemap.
5. Monitor Search Console for warnings, enhancement reports post-deploy.

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

## Structured Data & Crawlability
For structured data reference examples, detailed anti-patterns see [REFERENCE.md](./REFERENCE.md).

- Generate XML sitemap dynamically from your data source (CMS, DB, filesystem).
- Use **sitemap index** when >50,000 URLs or >50 MB.
- Include `<lastmod>` only if accurate; submit via Google Search Console; reference in `robots.txt`.

```txt
User-agent: *
Allow: /
Disallow: /admin/
Disallow: /api/
Disallow: /preview/
Sitemap: https://example.com/sitemap.xml
```

**Crawlability checklist:** robots.txt allows public pages · blocks admin/API/preview · XML sitemap auto-generated · referenced in robots.txt · no orphan pages · primary content in initial HTML · unique `<h1>` with keyword · structured data in SSR HTML · descriptive `alt` on images · no stray `noindex` · page load < 3s.

## Anti-Patterns & Structured Data Reference
See `REFERENCE.md` for detailed structured data examples, validation commands, trimmed anti-pattern checklist.
