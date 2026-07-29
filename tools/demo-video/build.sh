#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────
# OpenCastle Demo Video — Audio-First Build Script
#
# Approach: Generate audio per scene → measure durations →
#           generate VHS tapes calibrated to audio → compose.
#
# Usage:
#   ./build.sh all          # Full pipeline
#   ./build.sh tts          # Generate audio only
#   ./build.sh tapes        # Generate VHS tape files (needs audio first)
#   ./build.sh vhs          # Record terminal segments
#   ./build.sh browser      # Record dashboard browser via Playwright
#   ./build.sh compose      # Compose final video
#   ./build.sh check        # Verify tools
# ─────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export PATH="$PATH:$HOME/Library/Python/3.9/bin"

mkdir -p clips audio assets output tapes

# ── Video dimensions (YouTube 720p) ───────────────────────────
WIDTH=1280
HEIGHT=720

# ── TTS configuration ─────────────────────────────────────────
TTS_VOICE="${TTS_VOICE:-en-US-AvaNeural}"

# ── Demo project location ─────────────────────────────────────
DEMO_PROJECT="/tmp/opencastle-demo"
# Path to opencastle CLI (used inside VHS so no /Users/... leaks)
OPENCASTLE_CLI="$SCRIPT_DIR/../bin/cli.mjs"

# ── Narration segments (parallel arrays) ──────────────────────
SCENE_KEYS=(
  01-intro
  02-install
  03-explore
  04-dashboard
  05-wrapup
  06-thanks
)

SCENE_TEXTS=(
  "Hi! In this tutorial, I'll show you how to set up OpenCastle in your project, configure it for your stack, and start working on your first feature."
  "Let's start in a fresh project. Run npx opencastle init. The CLI will ask you a few questions about your IDE, your database, project management, and notifications. I'll pick VS Code, Supabase, Linear, and Slack."
  "That one command created everything you need. Eighteen agents, a developer, database engineer, security expert, and more. Twenty seven skills loaded on demand. Eight workflow templates. And your MCP servers are pre-configured for Supabase, Linear, and Slack."
  "OpenCastle includes an observability dashboard. Run opencastle convoy dashboard to see your agent sessions, delegation success rates, and model usage. It reads from the same logs your agents write, no extra setup needed."
  "That's the basics. One command to install, a dashboard to track your agents, and a team of specialists ready to work. Visit opencastle.dev to learn more, or just run npx opencastle init to get started."
  "Thanks for watching! Happy building."
)

# ── Dashboard background color (dark gray, matches dashboard UI) ──
BG_COLOR="0x0a0a0f"

# ── Logo for intro/outro title cards ──────────────────────────
LOGO_PATH="$SCRIPT_DIR/../website/src/images/opencastle-logo.png"

# ── Helper: get audio duration in seconds ──────────────────────
audio_duration() {
  ffprobe -v error -show_entries format=duration \
    -of default=noprint_wrappers=1:nokey=1 "$1"
}

# ── Helper: seconds to VHS Sleep format ────────────────────────
to_vhs_sleep() {
  # Input: float seconds, Output: e.g. "14500ms"
  local ms
  ms=$(echo "$1 * 1000" | bc | cut -d. -f1)
  echo "${ms}ms"
}

# ── Check tools ───────────────────────────────────────────────
check_tools() {
  local missing=0
  for cmd in vhs ffmpeg ffprobe node bc; do
    if ! command -v "$cmd" &>/dev/null; then
      echo "❌ Missing: $cmd"
      missing=1
    else
      echo "✅ $cmd"
    fi
  done

  if ! command -v edge-tts &>/dev/null; then
    echo "❌ Missing: edge-tts (pip install edge-tts)"
    missing=1
  else
    echo "✅ edge-tts"
  fi

  if ! node -e "require('playwright')" 2>/dev/null; then
    echo "❌ Missing: playwright (npm install playwright in demo-video/)"
    missing=1
  else
    echo "✅ playwright"
  fi

  [[ $missing -eq 1 ]] && exit 1
  echo -e "\nAll tools ready."
}

# ── Generate TTS audio ────────────────────────────────────────
generate_tts() {
  echo "🎙  Generating voiceover..."

  local i
  for (( i=0; i<${#SCENE_KEYS[@]}; i++ )); do
    local key="${SCENE_KEYS[$i]}"
    local text="${SCENE_TEXTS[$i]}"
    local outfile="audio/${key}.mp3"

    if [[ -f "$outfile" ]]; then
      local dur
      dur=$(audio_duration "$outfile")
      echo "  ⏭  ${key}.mp3 (${dur}s) — exists"
      continue
    fi

    echo "  🔊 ${key}.mp3"
    edge-tts --voice "$TTS_VOICE" --text "$text" --write-media "$outfile" 2>/dev/null

    local dur
    dur=$(audio_duration "$outfile")
    echo "     → ${dur}s"
  done

  echo -e "\n✅ Audio done."
}

# ── Generate VHS tape files calibrated to audio ───────────────
generate_tapes() {
  echo "📝 Generating VHS tapes synced to audio..."

  # Get audio durations
  local dur_intro dur_install dur_explore dur_dashboard dur_wrapup dur_thanks
  dur_intro=$(audio_duration audio/01-intro.mp3)
  dur_install=$(audio_duration audio/02-install.mp3)
  dur_explore=$(audio_duration audio/03-explore.mp3)
  dur_dashboard=$(audio_duration audio/04-dashboard.mp3)
  dur_wrapup=$(audio_duration audio/05-wrapup.mp3)
  dur_thanks=$(audio_duration audio/06-thanks.mp3)

  echo "  Durations: intro=${dur_intro}s install=${dur_install}s explore=${dur_explore}s dashboard=${dur_dashboard}s wrapup=${dur_wrapup}s thanks=${dur_thanks}s"

  local vhs_header="Set FontSize 16
Set Width ${WIDTH}
Set Height ${HEIGHT}
Set Theme \"Catppuccin Mocha\"
Set TypingSpeed 40ms
Set Padding 16
Set Framerate 30
Set Shell \"bash\"
Set WindowBar Colorful"

  # ── Scene 1: Intro — generated as a title card with logo (not VHS)
  echo "  Intro will be generated as a title card with FFmpeg (not VHS)"

  # ── Scene 2: Install
  # We need time for: typing + init prompts + output scroll
  # Audio fills naturally — just make sure total VHS time >= audio
  # Fixed sleeps in tape ≈ 12.6s (including typing). Subtract 13 from audio.
  local sleep_install_end
  sleep_install_end=$(to_vhs_sleep "$(echo "$dur_install - 13" | bc)")
  cat > tapes/02-install.tape << TAPE
# Scene 2: Install
Output clips/02-install.mp4
${vhs_header}

Hide
Type "cd ${DEMO_PROJECT} && rm -rf .github .vscode .gitignore .opencastle.json 2>/dev/null; export PS1='$ ' && clear"
Enter
Sleep 500ms
Show

Sleep 500ms
Type "npx opencastle init"
Enter
Sleep 2200ms

# Wait for repo scanning and IDE question to appear
Sleep 1500ms

# ── IDEs (multiselect: ↑/↓ navigate, Space toggle, Enter confirm) ──
# Cursor starts on VS Code — toggle it on
Space
Sleep 600ms
Enter
Sleep 1200ms

# ── Tech Tools (multiselect) ─────────────────────────────────────────
# Chrome DevTools is pre-selected. Navigate to Supabase (4th item).
Sleep 800ms
Down
Sleep 300ms
Down
Sleep 300ms
Down
Sleep 300ms
Space
Sleep 600ms
Enter
Sleep 1200ms

# ── Team Tools (multiselect) ─────────────────────────────────────────
# Toggle Linear (1st item, cursor already there)
Sleep 800ms
Space
Sleep 300ms
# Navigate down to Slack (3rd item)
Down
Sleep 300ms
Down
Sleep 300ms
# Toggle Slack
Space
Sleep 600ms
Enter

# Wait for output to finish and fill remaining audio time
Sleep ${sleep_install_end}
TAPE

  # ── Scene 3: Explore files — only .github structure
  local sleep_explore_end
  sleep_explore_end=$(to_vhs_sleep "$(echo "$dur_explore - 2" | bc)")
  cat > tapes/03-explore.tape << TAPE
# Scene 3: Explore generated files
Output clips/03-explore.mp4
${vhs_header}
Set FontSize 14

Hide
Type "cd ${DEMO_PROJECT} && export PS1='$ ' && clear"
Enter
Sleep 500ms
Show

Sleep 500ms
Type "find .github -maxdepth 2 -type d ! -path '.github/skills/*' ! -path '.github/plugins/*' | sort"
Enter

Sleep ${sleep_explore_end}
TAPE

  # ── Scene 4: Dashboard (browser only — captured via Playwright)
  echo "  Dashboard scene uses Playwright browser recording only"

  # ── Scene 5: Wrap up
  local sleep_wrapup_end
  sleep_wrapup_end=$(to_vhs_sleep "$(echo "$dur_wrapup - 3" | bc)")
  cat > tapes/05-wrapup.tape << TAPE
# Scene 5: Wrap up
Output clips/05-wrapup.mp4
${vhs_header}

Hide
Type "cd ${DEMO_PROJECT} && export PS1='$ ' && clear"
Enter
Sleep 500ms
Show

Sleep 500ms
Type "npx opencastle init"
Sleep 2s

# Hold — let the audio finish
Sleep ${sleep_wrapup_end}
TAPE

  # ── Scene 6: Thanks — generated as a title card with logo (not VHS)
  echo "  Thanks will be generated as a title card with FFmpeg (not VHS)"

  echo "✅ Tapes generated in tapes/"
}

# ── Record VHS tapes ──────────────────────────────────────────
record_vhs() {
  echo "🎥 Recording VHS tapes..."

  # The init tape needs the opencastle CLI accessible via a symlink
  # so it shows "npx opencastle init" but actually runs locally
  mkdir -p "${DEMO_PROJECT}/node_modules/.bin"
  ln -sf "$SCRIPT_DIR/../bin/cli.mjs" "${DEMO_PROJECT}/node_modules/.bin/opencastle" 2>/dev/null || true

  # Create a fake npx wrapper so "npx opencastle" works without download
  cat > "${DEMO_PROJECT}/.npx-shim" << 'SHIM'
#!/usr/bin/env bash
# Shim: redirect "npx opencastle" to local CLI
if [[ "$1" == "opencastle" ]]; then
  shift
  exec node "$HOME/.opencastle-cli/cli.mjs" "$@"
else
  exec /usr/bin/env npx "$@"
fi
SHIM
  chmod +x "${DEMO_PROJECT}/.npx-shim"

  # Place CLI where the shim expects it
  mkdir -p "$HOME/.opencastle-cli"
  cp "$SCRIPT_DIR/../bin/cli.mjs" "$HOME/.opencastle-cli/cli.mjs"

  # Only record tape-based scenes (skip 01-intro and 04-dashboard)
  for tape in tapes/02-install.tape tapes/03-explore.tape tapes/05-wrapup.tape; do
    if [[ ! -f "$tape" ]]; then
      echo "  ⚠️  Missing tape: $tape"
      continue
    fi
    local name
    name=$(basename "$tape" .tape)
    echo "  📹 ${name}"
    vhs "$tape" 2>&1 | grep -v "^$" | sed 's/^/     /'
  done

  echo "✅ VHS recordings done."
}

# ── Generate title cards (intro + thanks) with FFmpeg ─────────
generate_title_cards() {
  echo "🎨 Generating title cards..."

  local dur_intro dur_thanks
  dur_intro=$(audio_duration audio/01-intro.mp3)
  dur_thanks=$(audio_duration audio/06-thanks.mp3)

  # Extra padding for the thanks card (let music breathe)
  local thanks_total
  thanks_total=$(echo "$dur_thanks + 6" | bc)

  # Intro title card: logo centered on dark background
  local intro_dur
  intro_dur=$(echo "$dur_intro + 1" | bc)
  echo "  🎬 01-intro (${intro_dur}s) — logo on dark bg"
  ffmpeg -y \
    -f lavfi -i "color=c=0x0a0a0f:s=${WIDTH}x${HEIGHT}:d=${intro_dur}:r=30" \
    -i "$LOGO_PATH" \
    -filter_complex "[1:v]scale=400:-1[logo];[0:v][logo]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p" \
    -c:v libx264 -preset fast -crf 18 \
    -t "$intro_dur" \
    "clips/01-intro.mp4" 2>/dev/null

  # Thanks title card: logo centered, with fade in/out
  echo "  🎬 06-thanks (${thanks_total}s) — logo on dark bg with fade"
  ffmpeg -y \
    -f lavfi -i "color=c=0x0a0a0f:s=${WIDTH}x${HEIGHT}:d=${thanks_total}:r=30" \
    -i "$LOGO_PATH" \
    -filter_complex " \
      [1:v]scale=320:-1[logo]; \
      [0:v][logo]overlay=(W-w)/2:(H-h)/2:format=auto, \
      fade=t=in:st=0:d=1,fade=t=out:st=$(echo "$thanks_total - 2" | bc):d=2, \
      format=yuv420p \
    " \
    -c:v libx264 -preset fast -crf 18 \
    -t "$thanks_total" \
    "clips/06-thanks.mp4" 2>/dev/null

  echo "✅ Title cards done."
}

# ── Record dashboard browser via Playwright ───────────────────
record_browser() {
  echo "🌐 Recording dashboard browser..."

  # Start the dashboard in background
  node "$SCRIPT_DIR/../bin/cli.mjs" dashboard --seed --no-open &
  local dash_pid=$!
  sleep 8

  # Run Playwright recording script
  node scripts/record-dashboard.mjs

  # Stop dashboard
  kill "$dash_pid" 2>/dev/null || true
  wait "$dash_pid" 2>/dev/null || true

  echo "✅ Browser recording done: clips/04-dashboard-browser.mp4"
}

# ── Compose final video ───────────────────────────────────────
compose_video() {
  echo "🎬 Composing final video..."

  # Generate 1-second dark pause clip for between scenes
  local pause_clip="clips/_pause.mp4"
  ffmpeg -y \
    -f lavfi -i "color=c=${BG_COLOR}:s=${WIDTH}x${HEIGHT}:d=1.5:r=30" \
    -f lavfi -i "anullsrc=r=44100:cl=stereo" \
    -c:v libx264 -preset fast -crf 18 \
    -c:a aac -b:a 128k \
    -t 1.5 \
    -shortest \
    "$pause_clip" 2>/dev/null

  # ── Step 1: Build per-scene videos (video + audio) ──────────
  echo "  📎 Merging scenes..."

  local scenes=()
  local i
  for (( i=0; i<${#SCENE_KEYS[@]}; i++ )); do
    local key="${SCENE_KEYS[$i]}"
    local audio_file="audio/${key}.mp3"
    local video_file
    local video_offset="0"

    # Scene 4 uses browser recording
    if [[ "$key" == "04-dashboard" ]]; then
      if [[ -f "clips/04-dashboard-browser.mp4" ]]; then
        video_file="clips/04-dashboard-browser.mp4"
        video_offset="0.12"
      else
        echo "  ⚠️  Missing: clips/04-dashboard-browser.mp4 — skipping"
        continue
      fi
    else
      video_file="clips/${key}.mp4"
    fi

    if [[ ! -f "$video_file" ]]; then
      echo "  ⚠️  Missing: $video_file — skipping"
      continue
    fi

    local scene_out="clips/_scene-${key}.mp4"
    echo "  🎞  ${key}: $(basename "$video_file") + $(basename "$audio_file")"

    ffmpeg -y \
      -ss "$video_offset" -i "$video_file" \
      -i "$audio_file" \
      -c:v libx264 -preset fast -crf 20 \
      -vf "scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${BG_COLOR}" \
      -c:a aac -b:a 160k \
      -shortest \
      -movflags +faststart \
      "$scene_out" 2>/dev/null

    scenes+=("$scene_out")
  done

  # ── Step 2: Concatenate all scenes with pauses (filter concat) ─
  echo "  📎 Concatenating scenes with pauses..."
  local final_no_music="output/_no-music.mp4"

  if [[ ${#scenes[@]} -ne 6 ]]; then
    echo "  ❌ Expected 6 scenes, got ${#scenes[@]}"
    exit 1
  fi

  ffmpeg -y \
    -i "${scenes[0]}" \
    -i "$pause_clip" \
    -i "${scenes[1]}" \
    -i "$pause_clip" \
    -i "${scenes[2]}" \
    -i "$pause_clip" \
    -i "${scenes[3]}" \
    -i "$pause_clip" \
    -i "${scenes[4]}" \
    -i "$pause_clip" \
    -i "${scenes[5]}" \
    -filter_complex "[0:v:0][0:a:0][1:v:0][1:a:0][2:v:0][2:a:0][3:v:0][3:a:0][4:v:0][4:a:0][5:v:0][5:a:0][6:v:0][6:a:0][7:v:0][7:a:0][8:v:0][8:a:0][9:v:0][9:a:0][10:v:0][10:a:0]concat=n=11:v=1:a=1[v][a]" \
    -map "[v]" -map "[a]" \
    -c:v libx264 -preset slow -crf 18 \
    -c:a aac -b:a 192k \
    -movflags +faststart \
    "$final_no_music" 2>/dev/null

  local video_dur
  video_dur=$(audio_duration "$final_no_music")
  echo "  📏 Video duration (no music): ${video_dur}s"

  # ── Step 3: Mix in background music with fade-out ───────────
  if [[ -f "assets/bg-music.mp3" ]]; then
    echo "  🎵 Mixing background music with fade-out..."

    # Calculate fade-out start: 4 seconds before end
    local fade_start
    fade_start=$(echo "$video_dur - 4" | bc)

    ffmpeg -y \
      -i "$final_no_music" \
      -i "assets/bg-music.mp3" \
      -filter_complex " \
        [1:a]volume=0.12,afade=t=out:st=${fade_start}:d=4[bg]; \
        [0:a][bg]amix=inputs=2:duration=first:dropout_transition=3[a] \
      " \
      -map 0:v -map "[a]" \
      -c:v copy -c:a aac -b:a 192k \
      -movflags +faststart \
      "output/opencastle-demo.mp4" 2>/dev/null
  else
    cp "$final_no_music" "output/opencastle-demo.mp4"
    echo "  ℹ️  No bg music (place assets/bg-music.mp3 and re-run compose)"
  fi

  local final_dur
  final_dur=$(audio_duration "output/opencastle-demo.mp4")

  echo ""
  echo "✅ Final video: output/opencastle-demo.mp4"
  echo "   Resolution: ${WIDTH}×${HEIGHT}"
  echo "   Duration: ${final_dur}s"
  echo "   Size: $(du -h output/opencastle-demo.mp4 | cut -f1)"
}

# ── Main ──────────────────────────────────────────────────────

case "${1:-help}" in
  check)    check_tools ;;
  tts)      generate_tts ;;
  tapes)    generate_tapes ;;
  titles)   generate_title_cards ;;
  vhs)      record_vhs ;;
  browser)  record_browser ;;
  compose)  compose_video ;;
  all)
    check_tools
    generate_tts
    generate_tapes
    generate_title_cards
    record_vhs
    record_browser
    compose_video
    ;;
  help|*)
    echo "Usage: ./build.sh <command>"
    echo ""
    echo "Commands:"
    echo "  check    — Verify all tools"
    echo "  tts      — Generate voiceover audio"
    echo "  tapes    — Generate VHS tape files (synced to audio)"
    echo "  titles   — Generate intro/thanks title cards"
    echo "  vhs      — Record terminal segments"
    echo "  browser  — Record dashboard browser via Playwright"
    echo "  compose  — Combine everything into final video"
    echo "  all      — Full pipeline"
    echo ""
    echo "Environment:"
    echo "  TTS_VOICE  — edge-tts voice (default: en-US-AvaNeural)"
    ;;
esac
