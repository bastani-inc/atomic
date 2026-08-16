# 3.5 Custom theme
# Beats: the agent writes a project-local theme file, then /theme switches the
# whole TUI to it live.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 26ms
Type "Create .atomic/themes/my-theme.json: a complete Atomic theme named my-theme, with a vars block defining primary #00aaff and secondary 242, and a colors block that defines every one of the 51 required theme tokens. Write the file, nothing else."
Sleep 1s
Enter
Sleep 65s
Type "/theme"
Sleep 2s
Enter
Sleep 3s
Type "my-theme"
Sleep 2s
Enter
Sleep 10s
