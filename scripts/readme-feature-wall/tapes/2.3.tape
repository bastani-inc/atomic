# 2.3 Sessions are just JSONL
# Beats: name the session, read its own record through $ATOMIC_SESSION_FILE,
# then walk the id -> parentId chain that makes the session a tree.
#
# The closing beat is the course's chain walk rather than a raw byte dump. A
# raw dump prints the session header, which carries the operator's provider
# label; the chain walk prints one event per line as type, id, parent, which is
# what the row actually promises.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 30ms
Type "Explain @greeter.ts in one sentence."
Sleep 1s
Enter
Sleep 26s
Type "/name Atomic crash course"
Sleep 1.5s
Enter
Sleep 4s
Type "/session"
Sleep 1.5s
Enter
Sleep 7s
Set TypingSpeed 22ms
Type '!!jq -r "[.type,.id,.parentId]|@tsv" $ATOMIC_SESSION_FILE | head -18'
Sleep 800ms
Enter
Sleep 12s
