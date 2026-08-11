# A.2 Permission gate extension
# Reload the real tool_call policy, ask the agent to invoke dangerous bash, and
# reject it in the extension's live select dialog before execution.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 38ms
Type "/reload"
Sleep 1s
Enter
Sleep 7s
Set TypingSpeed 30ms
Type "Run this exact command with bash: sudo echo hi"
Sleep 1s
Enter
Sleep 30s
Down
Sleep 3s
Enter
Sleep 18s
