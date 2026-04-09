# Cloudflare Storage

## Storage Decision Guide

| Need | Use |
|------|-----|
| Config, feature flags, sessions, cache | KV (eventually consistent) |
| Relational SQL data, strong consistency | D1 (SQLite) |
| Files, images, large blobs | R2 (S3-compatible) |
| Stateful coordination, locks, real-time sync | Durable Objects |
| Background job queues | Queues |

---

## KV (Key-Value)

```typescript
// Read
const value = await env.MY_KV.get('key');
const json = await env.MY_KV.get<MyType>('key', { type: 'json' });
const buffer = await env.MY_KV.get('key', { type: 'arrayBuffer' });

// Write
await env.MY_KV.put('key', 'value');
await env.MY_KV.put('key', JSON.stringify(data));
await env.MY_KV.put('key', 'value', {
  expirationTtl: 3600,          // expire in 1 hour
  metadata: { userId: '123' },  // up to 1024 bytes of metadata
});

// Delete
await env.MY_KV.delete('key');

// List keys
const { keys, list_complete, cursor } = await env.MY_KV.list({ prefix: 'user:' });
for (const key of keys) {
  console.log(key.name, key.metadata);
}
```

**KV limits:** Reads are eventually consistent (up to 60s lag). Max value size: 25MB. Max key size: 512 bytes.

---

## D1 (SQLite at Edge)

```typescript
// Single query
const stmt = env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId);
const { results } = await stmt.all<User>();
const user = await stmt.first<User>();

// Insert / update
const result = await env.DB
  .prepare('INSERT INTO posts (id, title, author_id) VALUES (?, ?, ?)')
  .bind(id, title, authorId)
  .run();
console.log(result.meta.changes); // rows affected

// Batch (multiple queries in one round trip)
const results = await env.DB.batch([
  env.DB.prepare('INSERT INTO logs (event) VALUES (?)').bind('login'),
  env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(now, userId),
]);

// Dump (returns all results)
const { results: allUsers } = await env.DB.prepare('SELECT * FROM users').all<User>();
```

**Always use parameterized queries** — never interpolate user input into SQL strings.

### D1 Migrations

```bash
# Create migration file
wrangler d1 migrations create my-db add-users-table

# Apply migrations (local)
wrangler d1 migrations apply my-db --local

# Apply migrations (remote/production)
wrangler d1 migrations apply my-db --remote
```

---

## R2 (Object Storage)

```typescript
// Upload
await env.MY_BUCKET.put('images/photo.jpg', imageBuffer, {
  httpMetadata: { contentType: 'image/jpeg' },
  customMetadata: { uploadedBy: userId },
});

// Download
const object = await env.MY_BUCKET.get('images/photo.jpg');
if (!object) return new Response('Not found', { status: 404 });

// Stream the body directly to the response
return new Response(object.body, {
  headers: { 'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream' },
});

// Delete
await env.MY_BUCKET.delete('images/photo.jpg');

// List
const { objects, truncated, cursor } = await env.MY_BUCKET.list({ prefix: 'images/' });

// Multipart upload (large files >100MB)
const upload = await env.MY_BUCKET.createMultipartUpload('large-file.zip');
const part1 = await upload.uploadPart(1, chunk1);
const part2 = await upload.uploadPart(2, chunk2);
await upload.complete([part1, part2]);
```

**R2 is S3-compatible** — existing S3 SDKs work with R2 by pointing to the R2 endpoint URL.
