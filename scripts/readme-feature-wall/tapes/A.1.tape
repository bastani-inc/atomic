# A.1 Keybindings and hot reload
# Show the action registry, install a global-only override from the prepared
# lesson file, reload in place, and prove Ctrl+J now inserts a newline.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 38ms
Type "/hotkeys"
Sleep 1s
Enter
Sleep 7s
Escape
Type "!!mkdir -p ~/.atomic/agent && cp .capture/keybindings.json ~/.atomic/agent/keybindings.json"
Sleep 1s
Enter
Sleep 5s
Type "/reload"
Sleep 1s
Enter
Sleep 7s
Set TypingSpeed 55ms
Type "first line"
Sleep 2s
Ctrl+J
Sleep 2s
Type "second line"
Sleep 5s
Enter
Sleep 15s
