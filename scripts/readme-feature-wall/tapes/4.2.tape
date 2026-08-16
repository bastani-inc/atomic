# 4.2 Local models via models.json
# Beats: the agent writes ~/.atomic/agent/models.json declaring a local
# OpenAI-compatible provider, then /model shows the local entries appear with
# no restart. The picker is filtered to the local entries on purpose.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 26ms
Type "Create ~/.atomic/agent/models.json declaring a providers block with an ollama provider: baseUrl http://localhost:11434/v1, api openai-completions, apiKey ollama, and two models with ids llama3.1:8b and qwen2.5-coder:7b. Write the file, then show it back to me."
Sleep 1s
Enter
Sleep 50s
Type "/model"
Sleep 2.5s
Type "llama"
Sleep 3s
Escape
Sleep 3s
