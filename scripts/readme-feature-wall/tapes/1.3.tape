# 1.3 The agent interviews you
# Beats: the agent calls ask_user_question, the editor is replaced by the
# structured question UI, the operator answers with arrow keys and Enter.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 26ms
Type "Scaffold a config file for this project, but do NOT write anything yet. First use the ask_user_question tool to ask me: (1) which format - JSON, TOML, or YAML; (2) whether it should include explanatory comments. Then create the file exactly per my answers."
Sleep 1s
Enter
Sleep 26s
Down
Sleep 2s
Enter
Sleep 4s
Down
Sleep 2s
Enter
Sleep 40s
