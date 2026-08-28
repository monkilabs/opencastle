---
name: typescript-best-practices
description: "Type-level discipline for TypeScript: discriminated unions, branded types, constructive modeling, narrowing hierarchy, exhaustiveness checks, boundary validation. Use when reading or editing any .ts or .tsx file, modelling domain types, or refactoring an `as` cast out of existing code."
---

# TypeScript Best Practices

Make the illegal state unrepresentable, then let the compiler enforce it.

| Rule | Summary |
|------|---------|
| Discriminated unions | Model variants with a `kind` literal discriminant so impossible states cannot be represented. No optional-field bags. |
| Branded types | Brand primitives with `& { readonly __brand: 'X' }` so they cannot be mixed up. Validate once at creation. |
| Constructive modeling | Build the shape so the illegal value cannot be constructed. `[T, ...T[]]` for non-empty, `[T, T][]` for even length, `start` plus `duration` for a range. Not a runtime guard. |
| Simplest total type | Keep `T[]` while every operation on it stays total. Strengthen to `NonEmpty<T>` only where the loose type forces `!`, a cast, or a "should never happen" throw. |
| `unknown` over `any` | External data is `unknown`. `any` disables type checking everywhere it touches. |
| No `as` casts | Every `as` is a runtime crash waiting. Cast only after validation. |
| Narrowing hierarchy | Discriminant switch > `in` operator > `typeof`/`instanceof` > user-defined type guard > `as`. |
| Type guards | Must verify the claim. A lying guard is worse than `as`, because the bug hides behind a name that says it is safe. Name them `isX` or `hasX`. |
| Exhaustiveness | Inline `const _exhaustive: never = x` in default arms so the compiler errors when a variant is added. |
| `satisfies` over `as` | Validates the value without widening literal types. |
| Boundary validation | Parse where data crosses in, into a named domain type. `Record<string, unknown>` stops at that parse. Trust types inside; do not re-validate deep in call chains. |
| Schema-derived types | Reach for `Pick`/`Omit`/`Parameters`/`ReturnType`/`Awaited`/`typeof` before declaring a new interface. |
| Object args | Pass objects, not positional args, so argument order is self-documenting. Skip on hot paths: per-frame render, tokenizers, parsers. |
| Real tests | Do not mock what you can run. Prefer real test primitives and verify UI in a running build. Mock only what you cannot run locally. |
| Structured telemetry | Structured logger diagnostics with enough context to debug from an id. No `console.log` in shipped code. |

External data is anything from RPC payloads, `JSON.parse`, `postMessage`, IPC, file contents, environment variables, or database results.

## Patterns

**Discriminated union.** If a bug forces the question "can this combination actually happen?", the type is too loose.

```ts
// Don't. Boolean plus optionals lets contradictory states exist.
type DiffState = { loading: boolean; diff?: GitDiff; error?: string }

// Do. Only valid states exist.
type DiffState =
  | { kind: 'loading' }
  | { kind: 'ready'; diff: GitDiff }
  | { kind: 'error'; error: string }
```

**Branded type.** Validate once at creation; downstream code trusts the type.

```ts
type AgentId = string & { readonly __brand: 'AgentId' }

function parseAgentId(input: string): AgentId {
  if (!isUUID(input)) throw new Error(`Invalid agent id: ${input}`)
  return input as AgentId
}
```

**Constructive modeling.** Build from parts that are all legal instead of restricting a loose type with runtime checks. TypeScript has no refinement types, and you do not need one.

```ts
type NonEmpty<T> = [T, ...T[]]
type Pairs<T> = [T, T][]

const isNonEmpty = <T>(arr: T[]): arr is NonEmpty<T> => arr.length > 0

// Don't: a comment holds the invariant.
type TimeRange = { start: Date; end: Date } // start <= end
// Do: a negative range cannot be written. Derive end when needed.
type TimeRange = { start: Date; durationMs: number }
```

**Simplest total type.** Do not strengthen everything. `const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)` is fine, because `[]` is 0. Strengthen when the loose type forces a lie at a use site; the tells are `!`, `arr[0] as T`, and a "should never happen" throw.

```ts
// Don't: partiality smuggled past the compiler.
const newest = (sessions: Session[]): Session => sessions.at(0)!
// Do: strengthen the input, and the assertion disappears.
const newest = (sessions: NonEmpty<Session>): Session => sessions[0]
```

Weakening the result to `Session | undefined` is the other total signature. Either way the empty case lands at the call site, the one place that knows what empty means.

**Earned cast.** When refactoring an `as` out of existing code, identify why the compiler cannot infer: a missing discriminant (add one), an overly wide source type (narrow it), an untyped boundary (add a parse function or schema), or something genuinely inexpressible (use a brand or `satisfies`).

**Exhaustiveness.** Return-style in value-returning switches, void-style in statement switches.

```ts
default: {
  const _exhaustive: never = s
  return _exhaustive   // or: void _exhaustive
}
```

**`satisfies` over `as`.** `const config = { theme: 'dark', cols: 3 } satisfies Config` validates and keeps `config.theme` as the literal `'dark'`. The `as Config` form widens it to `string`.

Adapted from the `typescript-best-practices` skill in [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack), MIT, copyright 2026 Lauren Tan.
