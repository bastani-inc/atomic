# A.3 Runtime system-prompt mutation
# Toggle the shipped /pirate command, observe its live notice, then submit a
# normal prompt whose next turn receives the mutated system prompt.
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
Type "/pirate"
Sleep 1s
Enter
Sleep 5s
Set TypingSpeed 32ms
Type "Explain what a TypeScript generic is in two sentences."
Sleep 1s
Enter
Sleep 45s
