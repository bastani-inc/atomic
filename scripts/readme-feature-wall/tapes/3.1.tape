# 3.1 Build an extension
# Beats: the agent writes a project-local extension that registers a tool and a
# command, /reload picks it up live, then the model calls the new tool.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 26ms
Type "Create .atomic/extensions/my-extension.ts. It must import ExtensionAPI from @bastani/atomic and Type from typebox, default-export a function taking pi: ExtensionAPI, register a tool named greet with a name parameter that returns 'Hello, <name>!', and register a command hello that notifies. Write the file, nothing else."
Sleep 1s
Enter
Sleep 55s
Type "/reload"
Sleep 1.5s
Enter
Sleep 6s
Type "/hello world"
Sleep 1s
Enter
Sleep 5s
Set TypingSpeed 30ms
Type "Use the greet tool to greet someone named Ada."
Sleep 1s
Enter
Sleep 26s
