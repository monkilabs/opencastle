#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────
# OpenCastle demo video — narration first, then terminal recordings
# timed to it, then one MP4.
#
#   ./build.sh check     # verify the tools
#   ./build.sh tts       # narration per scene (audio/)
#   ./build.sh tapes     # VHS tapes timed to the narration (tapes/)
#   ./build.sh titles    # intro and closing cards (clips/)
#   ./build.sh vhs       # a fresh demo project, then record every tape (clips/)
#   ./build.sh compose   # scenes + narration + music → output/opencastle-demo.mp4
#   ./build.sh publish   # copy it to website/public/
#   ./build.sh all       # everything but publish
#
# The narration below is the only copy of it. Every command the video runs
# is the repository's own CLI (bin/cli.mjs, which loads dist/ — build first),
# reached through an `npx` shim, so what is on screen is what this source
# tree does.
# ─────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$SCRIPT_DIR"

export PATH="$PATH:$HOME/Library/Python/3.9/bin"

mkdir -p clips audio assets output tapes

# ── Video ─────────────────────────────────────────────────────
WIDTH=1280
HEIGHT=720
BG_COLOR="0x0a0a0f"
LOGO_PATH="$REPO_ROOT/website/src/images/opencastle-logo.png"
TTS_VOICE="${TTS_VOICE:-en-US-AvaNeural}"

# ── Demo project ──────────────────────────────────────────────
# Its own HOME, so nothing of the person recording is read or shown.
DEMO_ROOT="${DEMO_ROOT:-/tmp/opencastle-demo}"
DEMO_PROJECT="$DEMO_ROOT/acme-shop"
DEMO_HOME="$DEMO_ROOT/home"
DEMO_BIN="$DEMO_ROOT/bin"

# ── Scenes ────────────────────────────────────────────────────
# Title cards for the first and last; a terminal recording for the rest.
# The narration is spoken text, so names are spelled the way they sound.
SCENE_KEYS=(
  01-intro
  02-status
  03-init
  04-add
  05-explain
  06-drift
  07-thanks
)

SCENE_TEXTS=(
  "OpenCastle compiles one AI config for every assistant your team uses, and tells you when they drift apart. Here it is in a real project."
  "This Next.js app already has a Claude dot M D and a Cursor rules file, written by different people, saying almost the same thing. Running N P X OpenCastle tells you what it found, and what to do next."
  "OpenCastle init reads the repository. It finds both assistants, Next.js, Supabase and Vitest, shows the plan, and asks once. Your own lines stay at the top of Claude dot M D, above a managed block."
  "Adding a tool later is one command. Linear signs in through your browser. Slack needs a bot token, so OpenCastle names the variable to set."
  "OpenCastle explain shows what every assistant here is given: twelve agents, thirty-seven skills that load only when a task needs them, five MCP servers, and what is still left to set up."
  "Commit everything, like a lockfile. When someone edits a generated file by hand, sync check fails and names the file, and sync puts it back. OpenCastle C I adds that check to every pull request."
  "Run N P X OpenCastle init in your own project. The docs are at opencastle dot dev. Thanks for watching."
)

TITLE_SCENES=" 01-intro 07-thanks "

# ── Helpers ───────────────────────────────────────────────────
duration() {
  ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$1"
}

# What is left of a scene's narration after `used` seconds, as a VHS sleep;
# at least a second, so the last output stays on screen.
rest_of() {
  local audio="$1" used="$2"
  local left
  left=$(echo "$(duration "$audio") - $used + 0.8" | bc)
  if (( $(echo "$left < 1" | bc) )); then left=1; fi
  echo "$(echo "$left * 1000" | bc | cut -d. -f1)ms"
}

# Seconds VHS takes to type a string at TYPING_MS per character.
TYPING_MS=35
typed() {
  echo "${#1} * $TYPING_MS / 1000" | bc -l
}

check_tools() {
  local missing=0
  for cmd in vhs ffmpeg ffprobe node bc git edge-tts; do
    if command -v "$cmd" &>/dev/null; then echo "✅ $cmd"; else echo "❌ Missing: $cmd"; missing=1; fi
  done
  if [[ ! -f "$REPO_ROOT/dist/cli/init.js" ]]; then
    echo "❌ dist/ is not built — run npm run cli:build in the repository"
    missing=1
  fi
  [[ $missing -eq 1 ]] && exit 1
  echo -e "\nAll tools ready."
}

# ── Narration ─────────────────────────────────────────────────
generate_tts() {
  echo "🎙  Generating narration..."
  local i
  for (( i=0; i<${#SCENE_KEYS[@]}; i++ )); do
    local key="${SCENE_KEYS[$i]}"
    local out="audio/${key}.mp3"
    # Regenerated when the text changes, not only when the file is missing:
    # a stale take is how the last video kept narrating removed features.
    local stamp="audio/${key}.txt"
    if [[ -f "$out" && -f "$stamp" && "$(cat "$stamp")" == "${SCENE_TEXTS[$i]}" ]]; then
      echo "  ⏭  ${key} ($(duration "$out")s)"
      continue
    fi
    edge-tts --voice "$TTS_VOICE" --text "${SCENE_TEXTS[$i]}" --write-media "$out" 2>/dev/null
    printf '%s' "${SCENE_TEXTS[$i]}" > "$stamp"
    echo "  🔊 ${key} ($(duration "$out")s)"
  done
}

# ── The demo project, as the video starts it ──────────────────
setup_demo_project() {
  rm -rf "$DEMO_ROOT"
  mkdir -p "$DEMO_PROJECT" "$DEMO_HOME" "$DEMO_BIN"

  # `npx opencastle …` runs this repository's CLI; anything else is real npx.
  local real_npx
  real_npx="$(command -v npx)"
  cat > "$DEMO_BIN/npx" << SHIM
#!/usr/bin/env bash
if [[ "\${1:-}" == "opencastle" ]]; then
  shift
  exec node "$REPO_ROOT/bin/cli.mjs" "\$@"
fi
exec "$real_npx" "\$@"
SHIM
  chmod +x "$DEMO_BIN/npx"

  printf '[user]\n\tname = Acme Dev\n\temail = dev@acme.example\n[init]\n\tdefaultBranch = main\n' > "$DEMO_HOME/.gitconfig"

  cd "$DEMO_PROJECT"
  cat > package.json << 'JSON'
{
  "name": "acme-shop",
  "private": true,
  "scripts": { "dev": "next dev", "build": "next build", "test": "vitest run" },
  "dependencies": { "next": "15.5.0", "react": "19.1.0", "@supabase/supabase-js": "2.57.0" },
  "devDependencies": { "vitest": "3.2.0", "typescript": "5.9.0" }
}
JSON
  printf '# Acme Shop\n\n- Use pnpm, never npm.\n- Money is integer cents.\n' > CLAUDE.md
  printf 'Use pnpm. Money is integer cents.\n' > .cursorrules
  HOME="$DEMO_HOME" git init -q
  HOME="$DEMO_HOME" git add -A
  HOME="$DEMO_HOME" git commit -qm "Acme Shop"
  cd "$SCRIPT_DIR"
}

# ── Tapes ─────────────────────────────────────────────────────
generate_tapes() {
  echo "📝 Generating tapes timed to the narration..."

  local header="Set FontSize 16
Set Width ${WIDTH}
Set Height ${HEIGHT}
Set Theme \"Catppuccin Mocha\"
Set TypingSpeed ${TYPING_MS}ms
Set Padding 16
Set Framerate 30
Set Shell \"bash\"
Set WindowBar Colorful"

  # Every scene starts in the project, with the demo's HOME and npx shim, at a
  # bare prompt. Hidden, so the video starts on an empty terminal.
  local prelude="Hide
Type \"export HOME=${DEMO_HOME} PATH=${DEMO_BIN}:\$PATH PS1='\$ ' && cd ${DEMO_PROJECT} && clear\"
Enter
Sleep 600ms
Show"

  local cmd1 cmd2 cmd3 cmd4 cmd5 used

  # 02 — what is there, and the front door
  cmd1="cat CLAUDE.md .cursorrules"
  cmd2="npx opencastle"
  used=$(echo "0.5 + $(typed "$cmd1") + 2.8 + $(typed "$cmd2")" | bc -l)
  cat > tapes/02-status.tape << TAPE
Output clips/02-status.mp4
${header}

${prelude}

Sleep 500ms
Type "${cmd1}"
Enter
Sleep 2800ms
Type "${cmd2}"
Enter
Sleep $(rest_of audio/02-status.mp3 "$used")
TAPE

  # 03 — init, answering its one question
  cmd1="npx opencastle init"
  used=$(echo "0.5 + $(typed "$cmd1") + 5.5" | bc -l)
  cat > tapes/03-init.tape << TAPE
Output clips/03-init.mp4
${header}

${prelude}

Sleep 500ms
Type "${cmd1}"
Enter
# The plan, then "Set this up? [Y/n]"
Sleep 5500ms
Enter
Sleep $(rest_of audio/03-init.mp3 "$used")
TAPE

  # 04 — one more tool
  cmd1="npx opencastle add linear slack"
  used=$(echo "0.5 + $(typed "$cmd1")" | bc -l)
  cat > tapes/04-add.tape << TAPE
Output clips/04-add.mp4
${header}

${prelude}

Sleep 500ms
Type "${cmd1}"
Enter
Sleep $(rest_of audio/04-add.mp3 "$used")
TAPE

  # 05 — what every assistant is given
  cmd1="npx opencastle explain"
  used=$(echo "0.5 + $(typed "$cmd1")" | bc -l)
  cat > tapes/05-explain.tape << TAPE
Output clips/05-explain.mp4
${header}
Set FontSize 14

${prelude}

Sleep 500ms
Type "${cmd1}"
Enter
Sleep $(rest_of audio/05-explain.mp3 "$used")
TAPE

  # 06 — commit, a hand edit, caught, put back
  cmd1="git add -A && git commit -qm 'Add OpenCastle'"
  cmd2="echo 'Push straight to main.' >> .claude/skills/git-workflow/SKILL.md"
  cmd3="npx opencastle sync --check"
  cmd4="clear && npx opencastle sync --yes"
  cmd5="npx opencastle sync --check"
  used=$(echo "0.5 + $(typed "$cmd1") + 1.0 + $(typed "$cmd2") + 0.6 + $(typed "$cmd3") + 4.5 + $(typed "$cmd4") + 2.5 + $(typed "$cmd5")" | bc -l)
  cat > tapes/06-drift.tape << TAPE
Output clips/06-drift.mp4
${header}

${prelude}

Sleep 500ms
Type "${cmd1}"
Enter
Sleep 1000ms
Type "${cmd2}"
Enter
Sleep 600ms
Type "${cmd3}"
Enter
Sleep 4500ms
Type "${cmd4}"
Enter
Sleep 2500ms
Type "${cmd5}"
Enter
Sleep $(rest_of audio/06-drift.mp3 "$used")
TAPE

  echo "✅ Tapes in tapes/"
}

# ── Title cards ───────────────────────────────────────────────
generate_title_cards() {
  echo "🎨 Title cards..."
  local d
  d=$(echo "$(duration audio/01-intro.mp3) + 1" | bc)
  ffmpeg -y -loglevel error \
    -f lavfi -i "color=c=${BG_COLOR}:s=${WIDTH}x${HEIGHT}:d=${d}:r=30" -i "$LOGO_PATH" \
    -filter_complex "[1:v]scale=400:-1[logo];[0:v][logo]overlay=(W-w)/2:(H-h)/2:format=auto,fade=t=in:st=0:d=0.6,format=yuv420p" \
    -c:v libx264 -preset fast -crf 18 -t "$d" clips/01-intro.mp4

  d=$(echo "$(duration audio/07-thanks.mp3) + 5" | bc)
  ffmpeg -y -loglevel error \
    -f lavfi -i "color=c=${BG_COLOR}:s=${WIDTH}x${HEIGHT}:d=${d}:r=30" -i "$LOGO_PATH" \
    -filter_complex "[1:v]scale=320:-1[logo];[0:v][logo]overlay=(W-w)/2:(H-h)/2:format=auto,fade=t=in:st=0:d=1,fade=t=out:st=$(echo "$d - 2" | bc):d=2,format=yuv420p" \
    -c:v libx264 -preset fast -crf 18 -t "$d" clips/07-thanks.mp4
  echo "✅ Title cards in clips/"
}

# ── Record ────────────────────────────────────────────────────
record_vhs() {
  echo "🎥 Recording..."
  # In order, on one project: each scene starts where the last one ended.
  setup_demo_project
  local key
  for key in "${SCENE_KEYS[@]}"; do
    [[ "$TITLE_SCENES" == *" $key "* ]] && continue
    echo "  📹 ${key}"
    vhs "tapes/${key}.tape" 2>&1 | grep -v '^$' | sed 's/^/     /'
  done
  echo "✅ Recordings in clips/"
}

# ── Compose ───────────────────────────────────────────────────
compose_video() {
  echo "🎬 Composing..."

  ffmpeg -y -loglevel error \
    -f lavfi -i "color=c=${BG_COLOR}:s=${WIDTH}x${HEIGHT}:d=1:r=30" \
    -f lavfi -i "anullsrc=r=44100:cl=stereo" \
    -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 128k -t 1 -shortest clips/_pause.mp4

  # Each scene runs as long as the longer of its picture and its narration:
  # the last frame holds, or the narration is padded with silence. Cutting to
  # the shorter one clipped the end of a command's output, or of a sentence.
  local inputs=() filter="" n=0 key
  for key in "${SCENE_KEYS[@]}"; do
    local video="clips/${key}.mp4" audio="audio/${key}.mp3" out="clips/_scene-${key}.mp4"
    if [[ ! -f "$video" || ! -f "$audio" ]]; then
      echo "  ❌ Missing $video or $audio"
      exit 1
    fi
    local len
    len=$(printf '%s\n%s\n' "$(duration "$video")" "$(duration "$audio")" | sort -g | tail -1)
    echo "  🎞  ${key} (${len}s)"
    ffmpeg -y -loglevel error -i "$video" -i "$audio" \
      -filter_complex "[0:v]tpad=stop_mode=clone:stop_duration=60,scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${BG_COLOR},fps=30,format=yuv420p[v];[1:a]aresample=44100,apad[a]" \
      -map "[v]" -map "[a]" -t "$len" \
      -c:v libx264 -preset fast -crf 20 -c:a aac -b:a 160k -ac 2 "$out"
    if (( n > 0 )); then
      inputs+=(-i clips/_pause.mp4)
      filter+="[$((${#inputs[@]} / 2 - 1)):v:0][$((${#inputs[@]} / 2 - 1)):a:0]"
    fi
    inputs+=(-i "$out")
    filter+="[$((${#inputs[@]} / 2 - 1)):v:0][$((${#inputs[@]} / 2 - 1)):a:0]"
    n=$((n + 1))
  done
  local parts=$((${#inputs[@]} / 2))

  ffmpeg -y -loglevel error "${inputs[@]}" \
    -filter_complex "${filter}concat=n=${parts}:v=1:a=1[v][a]" \
    -map "[v]" -map "[a]" -c:v libx264 -preset slow -crf 18 -c:a aac -b:a 192k \
    -movflags +faststart output/_no-music.mp4

  local total
  total=$(duration output/_no-music.mp4)
  if [[ -f assets/bg-music.mp3 ]]; then
    echo "  🎵 Mixing assets/bg-music.mp3 at 12%"
    ffmpeg -y -loglevel error -i output/_no-music.mp4 -i assets/bg-music.mp3 \
      -filter_complex "[1:a]volume=0.12,afade=t=out:st=$(echo "$total - 4" | bc):d=4[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=3:normalize=0[a]" \
      -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -movflags +faststart output/opencastle-demo.mp4
  else
    cp output/_no-music.mp4 output/opencastle-demo.mp4
    echo "  ℹ️  No assets/bg-music.mp3 — composed without music"
  fi

  echo ""
  echo "✅ output/opencastle-demo.mp4 — ${WIDTH}×${HEIGHT}, $(duration output/opencastle-demo.mp4)s, $(du -h output/opencastle-demo.mp4 | cut -f1)"
}

publish_video() {
  cp output/opencastle-demo.mp4 "$REPO_ROOT/website/public/opencastle-demo.mp4"
  echo "✅ Copied to website/public/opencastle-demo.mp4"
}

case "${1:-help}" in
  check)   check_tools ;;
  tts)     generate_tts ;;
  tapes)   generate_tapes ;;
  titles)  generate_title_cards ;;
  vhs)     record_vhs ;;
  compose) compose_video ;;
  publish) publish_video ;;
  all)
    check_tools
    generate_tts
    generate_tapes
    generate_title_cards
    record_vhs
    compose_video
    ;;
  *)
    sed -n '4,15p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
