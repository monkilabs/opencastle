# OpenCastle Demo Video — Narration Script

> **Approach:** Audio-first. Generate narration per scene, measure duration,
> then create VHS tapes and Playwright recordings whose timing matches the audio.
> This keeps voice and visuals perfectly synced.

## Voice

- **Voice:** `en-US-AvaNeural` (edge-tts) — conversational, friendly, clear
- **Tone:** Friendly tutorial guide. Not salesy, not too formal.
- **Pace:** Natural — pauses between sentences so viewers can follow the terminal output.

---

## Scene 1 — Intro (title card + narration)

**Visual:** Dark background. OpenCastle logo fades in center. Tagline below.

**Narration:**
> "Hi! In this tutorial, I'll show you how to set up OpenCastle in your project, configure it for your stack, and start working on your first feature."

---

## Scene 2 — Install (terminal)

**Visual:** Terminal. Empty project directory. Type and run `npx opencastle init`.

**Narration:**
> "Let's start in a fresh project. Run npx opencastle init. The CLI will ask you a few questions about your IDE, your database, project management, and notifications. I'll pick VS Code, Supabase, Linear, and Slack."

**What happens on screen:** The init command runs, user selects options, output scrolls showing "Created 92 files", env var warnings, and next steps.

---

## Scene 3 — Explore the generated files (terminal)

**Visual:** Terminal. `tree .github/` and `ls` commands showing the generated structure.

**Narration:**
> "That one command created everything you need. Eighteen agents — a developer, database engineer, security expert, and more. Many skills loaded on demand. Eight workflow templates. And your MCP servers are pre-configured for Supabase, Linear, and Slack."

---

## Scene 4 — Dashboard (terminal + browser)

**Visual:** Run `npx opencastle convoy dashboard` in terminal, then browser opens showing the dashboard UI with session data, charts, and delegation timeline.

**Narration:**
> "OpenCastle includes an observability dashboard. Run opencastle convoy dashboard to see your agent sessions, delegation success rates, and model usage. It reads from the same logs your agents write — no extra setup needed."

---

## Scene 5 — Wrap up (terminal)

**Visual:** Terminal. Show `npx opencastle init` one more time. Fade to logo + URL.

**Narration:**
> "That's the basics! One command to install, a dashboard to track your agents, and a team of specialists ready to work. Visit opencastle.dev to learn more, or just run npx opencastle init to get started."

---

## Timing Summary

| Scene | Visual | Est. Duration |
|-------|--------|---------------|
| 1. Intro | Title card | ~8s |
| 2. Install | VHS terminal | ~18s |
| 3. Explore files | VHS terminal | ~16s |
| 4. Dashboard | VHS terminal + Playwright browser | ~14s |
| 5. Wrap up | VHS terminal + title card | ~12s |
| **Total** | | **~68s** |

Actual durations are set by the generated audio — VHS tape sleeps are calibrated to match.

---

## Background Music (Suno Prompt)

See bottom of this file for the Suno style prompt.

### Suno Style Prompt

```
Style: lo-fi ambient electronic, soft synth pads, gentle pulse,
minimal percussion, warm and modern. Think background music for a
developer tutorial or tech product walkthrough. Calm but not sleepy —
subtle forward momentum. No vocals. 70 BPM. 90 seconds. Fade out
at the end.
```

**Tags:** `lo-fi, ambient, electronic, tutorial, background, instrumental`

Export as MP3/WAV at 44.1kHz. Place the file at `demo-video/assets/bg-music.mp3`.
