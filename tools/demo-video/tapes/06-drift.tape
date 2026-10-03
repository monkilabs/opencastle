Output clips/06-drift.mp4
Set FontSize 16
Set Width 1280
Set Height 720
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set Padding 16
Set Framerate 30
Set Shell "bash"
Set WindowBar Colorful

Hide
Type "export HOME=/tmp/opencastle-demo/home PATH=/tmp/opencastle-demo/bin:$PATH PS1='$ ' && cd /tmp/opencastle-demo/acme-shop && clear"
Enter
Sleep 600ms
Show

Sleep 500ms
Type "git add -A && git commit -qm 'Add OpenCastle'"
Enter
Sleep 1000ms
Type "echo 'Push straight to main.' >> .claude/skills/git-workflow/SKILL.md"
Enter
Sleep 600ms
Type "npx opencastle sync --check"
Enter
Sleep 4500ms
Type "clear && npx opencastle sync --yes"
Enter
Sleep 2500ms
Type "npx opencastle sync --check"
Enter
Sleep 1000ms
