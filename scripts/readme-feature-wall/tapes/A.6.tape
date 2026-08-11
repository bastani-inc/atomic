# A.6 Background subagent runs
# Ask Atomic to launch a detached child through the real subagent tool, then
# request status while the child continues independently.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 28ms
Type "Call subagent with agent codebase-analyzer, task 'Trace src-client.ts behavior and its failure paths with file references.', and async true. Launch it and end the turn without polling."
Sleep 1s
Enter
Sleep 45s
Set TypingSpeed 34ms
Type "Show me the current async subagent runs and their status."
Sleep 1s
Enter
Sleep 45s
