# 3.2 Block a dangerous command
# Beats: the agent writes a tool_call hook that blocks rm -rf, /reload loads it,
# then a request to run that command is rejected before the shell sees it.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 26ms
Type "Create .atomic/extensions/safe-bash.ts. Default-export a function taking pi: ExtensionAPI that registers pi.on('tool_call', ...): when event.toolName is bash and the command contains 'rm -rf', return { block: true, reason: 'Blocked by safe-bash policy' }. Write the file, nothing else."
Sleep 1s
Enter
Sleep 50s
Type "/reload"
Sleep 1.5s
Enter
Sleep 6s
Set TypingSpeed 30ms
Type "Run this exact shell command: rm -rf ./demo-app"
Sleep 1s
Enter
Sleep 30s
