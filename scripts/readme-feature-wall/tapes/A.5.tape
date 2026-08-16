# A.5 Parallel review composition
# Plant a visible diff, then ask Atomic to compose three fresh-context review
# roles in one real parallel subagent call without editing the checkout.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 38ms
Type "!!git diff -- src-client.ts"
Sleep 1s
Enter
Sleep 7s
Set TypingSpeed 24ms
Type "Review the current diff now with one subagent parallel call: use codebase-analyzer for correctness, debugger in inspect-only mode for failure modes, and codebase-pattern-finder for existing patterns. Do not edit. Synthesize only issues worth fixing."
Sleep 1s
Enter
Sleep 80s
