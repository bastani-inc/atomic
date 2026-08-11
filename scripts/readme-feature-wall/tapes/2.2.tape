# 2.2 Verbatim compaction
# Beats: fill the transcript, pin a rule inside <keepContext>, run /compact,
# then prove the pinned rule survived byte-exact.
#
# The proof is the last beat and it is the point of the row, so the waits after
# /compact and after the question are generous. An earlier take stopped inside
# the compaction spinner and shipped a clip that never showed the answer.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 30ms
Type "Read greeter.ts, AGENTS.md, notes.md and plan.md, and summarize each."
Sleep 1s
Enter
Sleep 45s
Set TypingSpeed 26ms
Type "<keepContext>"
Shift+Enter
Type "Repo rule: never rename exported functions in this repo."
Shift+Enter
Type "</keepContext>"
Shift+Enter
Type "Acknowledge the rule above."
Sleep 1s
Enter
Sleep 22s
Type "/compact"
Sleep 1.5s
Enter
Sleep 55s
Set TypingSpeed 30ms
Type "What is the repo rule? Quote it exactly."
Sleep 1s
Enter
Sleep 40s
