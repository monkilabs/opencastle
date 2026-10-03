# OpenCastle demo video

The video on the website (`website/public/opencastle-demo.mp4`): about 100
seconds, 1280×720, narrated. Every command in it is this repository's CLI run
against a fresh demo project, so re-recording it is how it stays true.

## Build

```bash
npm run cli:build          # in the repository root — the video runs dist/
cd tools/demo-video
./build.sh check           # vhs, ffmpeg, ffprobe, node, bc, git, edge-tts
./build.sh all             # narration → tapes → title cards → recording → compose
./build.sh publish         # copy output/opencastle-demo.mp4 to website/public/
```

Each step can be run on its own: `tts`, `tapes`, `titles`, `vhs`, `compose`.

| Step | Tool | What it does |
|------|------|--------------|
| `tts` | edge-tts (`en-US-AvaNeural`) | One narration file per scene in `audio/`, regenerated when its text changes |
| `tapes` | — | VHS tapes in `tapes/`, each timed to its scene's narration |
| `titles` | FFmpeg | Logo cards for the first and last scene |
| `vhs` | VHS | Creates the demo project, then records the tapes in order on it |
| `compose` | FFmpeg | Each scene as long as the longer of picture and narration, joined with short pauses; `assets/bg-music.mp3`, if present, mixed in at 12% |

The demo project is created under `$DEMO_ROOT` (default `/tmp/opencastle-demo`)
with its own `HOME`, so nothing of the person recording is read or shown. An
`npx` shim there sends `npx opencastle …` to `bin/cli.mjs`.

VHS drives a terminal through a local `ttyd` server; a sandbox that blocks
localhost connections makes `vhs` fail with `could not open ttyd`.

## What is on screen

The narration is in `build.sh` (`SCENE_TEXTS`) and nowhere else.

| Scene | On screen |
|-------|-----------|
| 01-intro | Logo card |
| 02-status | `cat CLAUDE.md .cursorrules`, then `npx opencastle` — not set up, found Claude Code and Cursor |
| 03-init | `npx opencastle init` — the plan, `Set this up? [Y/n]`, Enter, the result |
| 04-add | `npx opencastle add linear slack` — and the Slack token it still needs |
| 05-explain | `npx opencastle explain` — agents, skills, commands, MCP servers, what to set up |
| 06-drift | Commit; a hand edit to a generated skill; `sync --check` fails and names it; `sync --yes`; `sync --check` passes |
| 07-thanks | Logo card |

## Background music

Optional. Place an MP3 at `assets/bg-music.mp3` (gitignored) and run
`./build.sh compose` again. The last one was made in Suno with: "lo-fi ambient
electronic, soft synth pads, gentle pulse, minimal percussion, warm and modern;
calm but with subtle forward momentum; no vocals; 70 BPM; 100 seconds; fade out
at the end."
