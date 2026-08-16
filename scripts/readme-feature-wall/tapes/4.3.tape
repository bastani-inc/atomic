# 4.3 Embed the agent with the SDK
# Beats: a small TypeScript program drives the same agent loop and streams the
# same events, run straight from the shell.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 26ms
Type "Create sdk-demo/agent.ts: import createAgentSession, ModelRuntime and SessionManager from @bastani/atomic, create a ModelRuntime, create a session with SessionManager.inMemory(), subscribe and write text_delta chunks to stdout, then prompt it with 'What files are in the current directory?'. Write the file, nothing else."
Sleep 1s
Enter
Sleep 50s
Type "!!cat sdk-demo/agent.ts"
Sleep 800ms
Enter
Sleep 8s
