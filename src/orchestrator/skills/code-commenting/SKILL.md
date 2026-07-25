---
name: code-commenting
description: "Guidelines for writing self-explanatory code with minimal comments. Covers when to comment (WHY not WHAT), anti-patterns to avoid, annotation tags, public API documentation. Use when writing or reviewing code comments, docstrings, TODO/FIXME tags, code readability, or inline comments."
---

# Code Commenting

Comment WHY, not WHAT. When a bad name is the real problem, rename instead of commenting. Do comment: non-obvious algorithm choices, regexes, external API constraints, and the rationale behind every magic number or config constant. JSDoc every public API function.

## Annotation Tags

`TODO` planned work · `FIXME` known bug · `HACK` workaround (say why and when it can go) · `NOTE` non-obvious constraint · `WARNING` side effect / mutation risk · `PERF` hot path · `SECURITY` security-sensitive · `DEPRECATED` (name the replacement and removal version).

## Never

- Leave commented-out code — delete it; git has the history.
- Keep a changelog in comments — that is `git log`.
- Add decorative divider comments.
