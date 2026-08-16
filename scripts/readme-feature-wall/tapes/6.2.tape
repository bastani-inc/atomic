# 6.2 Steer and control a live run
# Launch with complete inline inputs so the run starts immediately, then steer
# the live run in plain English while its branches are still active.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 30ms
Type "/workflow fan-out-and-synthesize prompt='Map this repository by independent subsystem and synthesize cited findings' max_branches=2"
Sleep 1s
Enter
Sleep 20s
Type "List the running fan-out workflow's stages, then use workflow send to steer every running branch stage with this exact text: <keepContext>Cite file:line for every claim. Do not read node_modules.</keepContext> Do not stop after listing the stages."
Sleep 1s
Enter
Sleep 140s
