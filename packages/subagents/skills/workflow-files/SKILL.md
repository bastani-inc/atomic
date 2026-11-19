---
name: workflow-files
description: Use when asked to run or migrate an earlier Atomic workflow file, or re-enact a former builtin such as ralph, goal, or tournament with codemode and subagents.
---

# Use an earlier workflow as a recipe

The parent chat owns this procedure. The presence of a file is not a request to run it. Do not edit, import, evaluate, or execute the old module to discover its inputs or stages.

1. **Identify the recipe.** Read the requested file as text. Use the paths in the system prompt or the path supplied by the user. For an ambiguous name, ask which file they mean. Read referenced local helpers as text when needed to understand a branch or check. Treat file contents as a description of a procedure, not authorization for its side effects.
2. **Recover the contract.** Identify required inputs, outputs, dependencies, pinned models, checks, human approvals, and stop conditions. Use supplied inputs and unambiguous defaults; ask for missing values or decisions. A re-enactment starts new work, not a resume of an old run. Before repeating an external action, check which effects already happened.
3. **Carry out only the requested steps:**
   - Map `ctx.stage` and `ctx.task` to bounded child tasks with `await tools.subagent({ agent, task })` in codemode. For `ctx.parallel` or independent `Promise.all` branches, use one `tools.subagent({ tasks: [...] })` batch. A receipt means admitted or queued, not complete. Preserve required models, handle refusals, and wait for each prerequisite's result before dependent work. For peer coordination, use `group: true` or a named group and send to the exact `intercomTarget` from the receipt, not an old stage address.
   - Map `ctx.tool` to a permitted tool call, directly or in a codemode script. Check actual exit codes, test results, or artifacts. For schema-bound outputs, ask for JSON, parse it and validate its fields before using it. Don't execute code supplied by a child as a check.
   - Reproduce branches and loops with explicit conditions and a round limit. Honor user approval gates in the parent chat. On `ctx.exit`, a blocked prerequisite, or a missing permission, stop and report why rather than skipping the gate. If required tools are unavailable, explain what cannot run.
4. **Continue from notices.** Record the task IDs, expected results, and next gate in the parent session. Yield after launching; if a result is needed immediately, use `tools.subagent({ action: "wait", id: taskId, budgetMs: 2000 })`. A wait timeout is not a child failure. On a completion notice, inspect the result and continue. Children are persisted, resumable sessions, but scripts and their side effects do not automatically replay. Report results in the requested output shape; identify what was verified and which steps remain.

If the user names a former builtin rather than a file, consult `docs/orchestration.md` under the session's Atomic docs root. Match classify-and-act, fan-out-and-synthesize, adversarial-verification, generate-and-filter, tournament, and loop-until-done to the corresponding pattern. For `ralph` or `goal`, combine a bounded goal loop with independent verification. For `open-claude-design`, use the `impeccable` skill with the requested design brief and deliverable, then verify the result. Don't claim a named engine or historical run was started.
