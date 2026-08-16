# 3.4 Write a skill
# Beats: the agent writes a project-local SKILL.md, then a matching request
# makes Atomic discover and follow that procedure.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 26ms
Type "Create .atomic/skills/repo-stats/SKILL.md with YAML frontmatter (name: repo-stats, description: Use when the user asks for repository statistics such as file counts and line counts) and a short Usage section telling the agent to count files and lines with shell commands. Write the file, nothing else."
Sleep 1s
Enter
Sleep 45s
Type "/reload"
Sleep 1.5s
Enter
Sleep 5s
Set TypingSpeed 30ms
Type "Give me the repository statistics for this project."
Sleep 1s
Enter
Sleep 40s
