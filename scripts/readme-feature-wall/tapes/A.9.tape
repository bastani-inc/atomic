# A.9 Nesting builtin workflows
# Display the real ctx.workflow composition, reload it, start the parent with a
# typed topic, and connect to the graph where nested builtin stages materialize.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 38ms
Type "!!sed -n '1,160p' .atomic/workflows/research-and-verify.ts"
Sleep 1s
Enter
Sleep 10s
Type "/workflow reload"
Sleep 1s
Enter
Sleep 7s
Type "/workflow research-and-verify topic='how the session store works'"
Sleep 1s
Enter
Sleep 18s
Type "/workflow connect"
Sleep 1s
Enter
Sleep 4s
Enter
Sleep 90s
