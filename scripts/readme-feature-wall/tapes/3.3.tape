# 3.3 Full-screen TUI tool
# The shipped question.ts example is already in .atomic/extensions (see
# 3.3.prepare.sh). Beats: the model calls it, the extension takes over the
# whole screen with its own keyboard-driven component, the operator picks.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 28ms
Type "Use the question tool to ask me which database we should use for the demo app. Offer Postgres, SQLite, and Redis with one-line descriptions each."
Sleep 1s
Enter
Sleep 30s
Down
Sleep 2.5s
Down
Sleep 2.5s
Up
Sleep 2s
Enter
Sleep 22s
