---
name: code-commenting
description: "When and how to comment code: the why over the what, annotation tags, public API docs and anti-patterns. Use when writing or reviewing comments, docstrings or TODO/FIXME tags."
---

# Code Commenting

Comment WHY, not WHAT. When a bad name is the real problem, rename instead of commenting. Do comment: non-obvious algorithm choices, regexes, external API constraints, and the rationale behind every magic number or config constant. JSDoc every public API function.

## Annotation Tags

`TODO` planned work · `FIXME` known bug · `HACK` workaround (say why and when it can go) · `NOTE` non-obvious constraint · `WARNING` side effect / mutation risk · `PERF` hot path · `SECURITY` security-sensitive · `DEPRECATED` (name the replacement and removal version).

## Never

- Leave commented-out code — delete it; git has the history.
- Keep a changelog in comments — that is `git log`.
- Add decorative divider comments.
