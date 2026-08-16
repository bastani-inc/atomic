# 1.2 Hashline edits
# Beats: a surgical single edit anchored to a snapshot tag, then CTRL+O to
# expand the tool output and show the hashline script and its fresh tag.
# VHS strings are single-quoted here so the prompt can contain double quotes.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 30ms
Type 'Read greeter.ts, then change only the greeting punctuation from "!" to "?!" using a single edit.'
Sleep 1s
Enter
Sleep 40s
Ctrl+O
Sleep 8s
Set TypingSpeed 30ms
Type 'Now append "// reviewed" as the last line of greeter.ts.'
Sleep 1s
Enter
Sleep 32s
