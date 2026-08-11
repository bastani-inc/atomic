# A.10 Autonomous implementation loops
# Inspect ralph's typed contract, launch its bounded implementation loop against
# a planted demo flaw, and connect to its live research-first graph.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 36ms
Type "/workflow inputs ralph"
Sleep 1s
Enter
Sleep 10s
Set TypingSpeed 28ms
Type "/workflow ralph prompt='Add input validation to demo-app/server.js and prove it with a test' max_loops=1"
Sleep 1s
Enter
Sleep 18s
Type "/workflow connect"
Sleep 1s
Enter
Sleep 4s
Enter
Sleep 100s
