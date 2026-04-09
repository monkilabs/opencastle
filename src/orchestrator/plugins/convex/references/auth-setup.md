# Convex Authentication Setup

Implement secure authentication in Convex with user management and access control.

## Step 1: Choose the Auth Provider

Do not assume a provider. Before writing setup code:
1. Ask the user which auth solution they want, unless the repository already makes it obvious
2. If the repo already uses a provider, continue with that provider unless the user wants to switch

Check for signals: dependencies like `@clerk/*`, `@workos-inc/*`, `@auth0/*`, or Convex Auth packages; files like `convex/auth.config.ts`; environment variables pointing at a provider.

| Provider | Use when |
|----------|----------|
| Convex Auth | Good default when the user wants auth handled directly in Convex |
| Clerk | App already uses Clerk or user wants Clerk's hosted auth features |
| WorkOS AuthKit | App already uses WorkOS or user wants AuthKit specifically |
| Auth0 | App already uses Auth0 |
| Custom JWT | Integrating an existing auth system not covered above |

## Provider References

- Convex Auth: [official docs](https://docs.convex.dev/auth/convex-auth) + `references/auth-convex-auth.md`
- Clerk: [official docs](https://docs.convex.dev/auth/clerk) + `references/auth-clerk.md`
- WorkOS AuthKit: [official docs](https://docs.convex.dev/auth/authkit/) + `references/auth-workos.md`
- Auth0: [official docs](https://docs.convex.dev/auth/auth0) + `references/auth-auth0.md`

## Core Pattern: Protecting Backend Functions

```ts
// Bad: trusting a client-provided userId
export const getMyProfile = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.userId);
  },
});
```

```ts
// Good: verifying identity server-side
export const getMyProfile = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    return await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier)
      )
      .unique();
  },
});
```

## Workflow

1. Determine the provider (ask or infer from repo)
2. Read the matching provider reference file
3. Follow the official provider docs for current setup details
4. Follow the official Convex docs for shared backend auth behavior:
   - [Auth in Functions](https://docs.convex.dev/auth/functions-auth) — `ctx.auth.getUserIdentity()`
   - [Storing Users](https://docs.convex.dev/auth/database-auth) — optional app-level user storage
5. Only add a `users` table and `storeUser` flow if the app actually needs user documents in Convex
6. Add authorization checks for ownership, roles, or team access only where the app needs them
7. Verify login state, protected queries, environment variables, and production configuration

## Key Rules

- For Convex Auth, follow built-in auth tables — don't add a parallel `users` table + `storeUser` flow
- For third-party providers, only add app-level user storage if the app needs user documents in Convex
- After running provider initialization commands, verify generated files and complete post-init wiring
- Prefer `useConvexAuth()` over raw provider auth state when deciding whether Convex-authenticated UI can render

## Checklist

- [ ] Chosen auth provider
- [ ] Read the matching provider reference file
- [ ] Used official provider docs for provider-specific wiring
- [ ] Used official Convex docs for shared auth behavior
- [ ] Only added app-level user storage if the app needs it
- [ ] Added `ctx.auth.getUserIdentity()` checks in protected backend functions
- [ ] Clear error messages ("Not authenticated", "Unauthorized")
- [ ] Client auth provider configured
- [ ] Production auth setup covered if requested
