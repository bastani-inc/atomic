# A.4 Prompt templates with arguments
# Browse project prompt commands and run /component with three positional
# arguments; Atomic expands $1 and ${@:2} into the visible user prompt.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 42ms
Type "/"
Sleep 4s
Type "component"
Sleep 4s
Escape
Ctrl+U
Sleep 1s
Set TypingSpeed 30ms
Type "/component Button 'onClick handler' 'disabled support'"
Sleep 1s
Enter
Sleep 50s
