# Context Engineering References for Workflow Design

These files were copied from the upstream context-engineering skill set so the workflow skill can load design guidance on demand without relying on global skill availability.

Load them selectively based on the workflow's risk profile:

| Concern | Reference | Load when |
| --- | --- | --- |
| Prompt/context basics | `context-engineering/context-fundamentals.md` | Every non-trivial workflow; designing stage prompts, token budgets, context placement, progressive disclosure. |
| Context loss | `context-engineering/context-degradation.md` | Long-running workflows, multi-turn sessions, accumulated state, review/fix loops. |
| Compression | `context-engineering/context-compression.md` | Passing large transcripts, summaries, research bundles, or logs between stages. |
| Token efficiency | `context-engineering/context-optimization.md` | Large fan-outs, repeated context blocks, cache-sensitive prompts, or expensive runs. |
| Multi-agent topology | `context-engineering/multi-agent-patterns.md` | Parallel specialists, orchestrator/reviewer/fixer patterns, handoff protocols. |
| Memory | `context-engineering/memory-systems.md` | Cross-run persistence, durable project knowledge, or reusable workflow memory. |
| Tools | `context-engineering/tool-design.md` | A stage needs custom tools, constrained capabilities, MCP access, or tool ergonomics. |
| Filesystem handoff | `context-engineering/filesystem-context.md` | Stages coordinate through files, artifacts, progress docs, or shared directories. |
| Hosted/remote agents | `context-engineering/hosted-agents.md` | Sandboxed, remote, containerized, or hosted execution environments. |
| Quality gates | `context-engineering/evaluation.md` | Review loops, acceptance checks, deterministic grading, or success criteria. |
| LLM-as-judge | `context-engineering/advanced-evaluation.md` | Automated judges, rubric-based review, pairwise comparison, evaluator agents. |
| Task fit | `context-engineering/project-development.md` | Deciding whether a workflow is a good automation target. |
| Deliberation model | `context-engineering/bdi-mental-states.md` | Explainable planning/reasoning workflows or cognitive-state decomposition. |

Use these references to design information flow before writing TypeScript. A workflow fails more often from missing/poorly-routed context than from syntax errors.
