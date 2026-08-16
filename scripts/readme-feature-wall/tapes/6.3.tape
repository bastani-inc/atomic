# 6.3 Writing your own workflow
# Show the valid project-local TypeScript, reload it in-process, and launch it
# with a typed path input so a tracked explain stage starts successfully.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 35ms
Type "!!sed -n '1,120p' .atomic/workflows/explain-file.ts"
Sleep 1s
Enter
Sleep 8s
Type "/workflow reload"
Sleep 1s
Enter
Sleep 7s
Type "/workflow explain-file path=src-client.ts"
Sleep 1s
Enter
Sleep 80s
