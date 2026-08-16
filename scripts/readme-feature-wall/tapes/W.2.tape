# W.2 Run a workflow with typed inputs
# Inspect the TypeBox-derived input contract, then launch with validated static
# string and integer values in key=value syntax.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 35ms
Type "/workflow inputs typed-input-demo"
Sleep 1s
Enter
Sleep 7s
Type "/workflow typed-input-demo path=src-client.ts depth=2"
Sleep 1s
Enter
Sleep 16s
Type "/workflow status"
Sleep 1s
Enter
Sleep 12s
