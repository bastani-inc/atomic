# 5.2 Worktree-isolated parallel work
# Beats: two editing children run at once with worktree isolation, so each gets
# its own git worktree and its own diff instead of clobbering the other.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 26ms
Type "Run two implementation subagents in parallel with worktree isolation: one adds a null guard to fetchUser in src-client.ts, the other adds a doc comment to every exported function in greeter.ts. Show me the per-worktree diffs."
Sleep 1s
Enter
Sleep 120s
