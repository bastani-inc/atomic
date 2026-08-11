# 1.4 File-based todos
# Beats: the agent plans with the todo tool, then the resulting plain files
# under .atomic/todos are read from inside the session.
# Never use `ls -l` in a tape: a long listing renders the OS account name.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 30ms
Type "Plan test coverage for greeter.ts with the todo tool: create one todo per exported function, then list all todos."
Sleep 1s
Enter
Sleep 45s
Type "!ls .atomic/todos/"
Sleep 800ms
Enter
Sleep 4s
Type "!!cat .atomic/todos/*"
Sleep 800ms
Enter
Sleep 10s
