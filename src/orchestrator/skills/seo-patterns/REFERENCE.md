> Parent: [SKILL.md](./SKILL.md)

# SEO Reference: Structured Data & Anti-Patterns

## Structured Data Examples (JSON-LD)

### Breadcrumb + Article example

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

### FAQPage example (minimal)

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    { "@type": "Question", "name": "Q?", "acceptedAnswer": { "@type": "Answer", "text": "A." } }
  ]
}
```

## Validation

- Validate with Google's Rich Results Test: https://search.google.com/test/rich-results
- CLI quick-check: `curl -s https://example.com/page | pup 'script[type=application/ld+json] text{}'` then `jq .`

## Anti-Patterns (trimmed)

- Duplicate titles across pages — produce unique, descriptive titles.
- Missing canonical URLs — add `<link rel="canonical">` to avoid duplicate content.
- Client-only rendered primary content — server-render or prerender indexable content.
- Unvalidated structured data — validate before merge and include tests in PRs.

Last Updated: 2026-03-31
