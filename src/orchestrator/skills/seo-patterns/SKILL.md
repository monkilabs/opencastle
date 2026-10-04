---
name: seo-patterns
description: "Technical SEO: meta tags, Open Graph, canonical URLs, JSON-LD structured data, sitemaps and robots.txt. Use when adding or fixing any of these, or when pages are not being crawled or indexed."
---

# SEO Patterns

## Constraints

- Unique `<title>` (50–60 chars) and `<meta name="description">` (150–160 chars) on every public page — duplicates across pages are a defect.
- Canonical URL on every page. `noindex` only on admin/draft pages.
- Primary content must be server-rendered; client-only rendered content is not indexed.
- OG image 1200×630 px.
- Mobile page load under 3 s.

## Structured Data (JSON-LD)

Server-rendered, and it must return 0 errors from Google's Rich Results Test (https://search.google.com/test/rich-results) before shipping. Extract to inspect locally:

```bash
curl -s https://example.com/page | pup 'script[type=application/ld+json] text{}' | jq .
```

## Sitemap & robots.txt

Generate the XML sitemap dynamically from the data source (CMS, DB, filesystem) and reference it from `robots.txt` via `Sitemap: https://example.com/sitemap.xml`. Use a **sitemap index** above 50,000 URLs or 50 MB. Include `<lastmod>` only when it is accurate. `Disallow: /admin/`, `/api/`, `/preview/`.

Post-deploy: check Search Console for warnings; remove any accidental `Disallow:` entry and resubmit the sitemap.
