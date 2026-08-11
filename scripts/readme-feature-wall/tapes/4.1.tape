# 4.1 Headless print and JSON mode
# Shell-first lesson: the CLI itself is the subject. No TUI, so no statusline.
# VHS strings cannot nest both quote kinds, so the jq filter stays quote-free.
Set TypingSpeed 32ms
Type "cat AGENTS.md | atomic -p 'Summarize this text in one sentence'"
Sleep 800ms
Enter
Sleep 22s
Type "atomic --tools read,search,find -p 'Name the exported functions in greeter.ts'"
Sleep 800ms
Enter
Sleep 26s
Type "atomic --mode json 'List the files here' 2>/dev/null | jq -c .type | head -14"
Sleep 800ms
Enter
Sleep 28s
