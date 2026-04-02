# Sanity CMS Configuration

<!-- Populated by `opencastle init` based on detected Sanity project. -->

Project-specific Sanity CMS details referenced by the `sanity-cms` skill.

## Configuration

<!-- Sanity project ID, dataset, API version, studio location. -->

| Setting | Value |
|---------|-------|
| Project ID | |
| Dataset | |
| API Version | |
| Studio Path | |

## Plugins

<!-- List Sanity plugins and their purpose. -->

## Document Types

<!-- List document types with key fields. -->

| Document Type | Key Fields | Description |
|--------------|------------|-------------|
| | | |

## GROQ Examples

<!-- Provide representative GROQ query examples. -->

```groq
// Example: fetch all published documents of a type
*[_type == "page" && !(_id in path("drafts.**"))]{
  _id, title, slug
}
```

## Key Files

<!-- List key schema, config, and query files. -->
