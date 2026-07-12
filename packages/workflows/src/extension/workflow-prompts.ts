export const WORKFLOW_TOOL_DESCRIPTION =
  "Run named builtin, project, user, or package workflows, or direct one-off task/tasks/chain workflows; " +
  "when workflow execution fits but another shape would better achieve the task, author a custom TypeScript workflow({...}) inline with normal coding tools, reload it, and run it; " +
  "discover with list/get/inputs, inspect status/stages/stage details, " +
  "send prompt answers or steering, pause/resume/interrupt/kill runs, and reload workflow resources. " +
  "For large stage handoffs, write context to files/artifacts, pass paths via reads, and prompt downstream agents to 'Read the file at <path>...' instead of injecting large previous text. " +
  "For transcripts, prefer status/stages/stage to get sessionFile/transcriptPath, " +
  "quote the exact path without rewriting separators (Windows backslashes are valid), " +
  "then search it with rg/grep and read small ranges; transcript is path-only by default when sessionFile/transcriptPath exists, explicit tail/limit returns bounded previews, and missing transcript paths fall back to a small preview.";

export const DEFAULT_PROMPT_GUIDANCE: string[] = [
  `**Execution routing**: Use the least orchestration that reliably fits the user's intent.
  - Keep interactive, exploratory, conceptual, and conversation-led work inline so the user can steer it turn by turn.
  - Use a single subagent or a bounded subagent chain/parallel fan-out for specialist work while the parent remains in control. Multiple steps, files, tests, validation commands, or parallelism alone do not require a workflow.
  - Use a workflow when the user clearly delegates a well-defined autonomous job that is likely long-running or background-oriented, or when the job materially needs durable stage tracking, artifacts/checkpoints, resumability, human-in-the-loop prompts, gates, retries, or bounded loops. When the user clearly delegates such a long-running job, choose and run an appropriate workflow rather than keeping it inline.
  - Treat loop or stop-condition phrasing as a key workflow signal, especially requests such as "do X until Y", "repeat until", "iterate until", "review/fix until passing", "run checks and fix until green", or "keep going until done". When the user asks Atomic to execute such a loop, prefer a workflow so the stop condition, retries, evidence, and convergence are tracked. Do not let this override a clearly exploratory or conceptual conversation.
  - Named workflows may be builtin, project, user, or package supplied. Direct \`task\`, \`tasks\`, and \`chain\` modes provide one-off tracked shapes. When workflow execution is warranted, you may always author a custom TypeScript \`workflow({...})\` inline with normal coding tools if that shape best achieves the user's task; it need not reuse an installed workflow or fit a direct mode. For richer branches, loops, gates, child workflows, or human-in-the-loop behavior, write the definition, reload workflow resources, then run it. The workflow tool does not have a create action; do not force-fit a builtin such as \`goal\` or \`ralph\` when a custom workflow better matches the job.`,
  `**Workflow discovery and lifecycle**:
  - For unfamiliar named workflows, discover with \`action: "list"\`, inspect with \`action: "get"\` or \`action: "inputs"\`, and run with \`action: "run"\`, \`workflow\`, and validated \`inputs\`; do not invent workflow names or input keys.
  - Once you run a workflow, end the current turn and wait for user input or a lifecycle notice. Do not use sleep/status polling loops: key start, finish, and failure events arrive automatically. Use targeted \`status\`/\`stages\`/\`stage\` checks only when the user asks or the next step needs them, and use \`send\`/\`pause\`/\`resume\`/\`interrupt\`/\`kill\` only to answer, steer, or honor control requests.
  - For transcripts, avoid whole-file reads. Get \`sessionFile\`/\`transcriptPath\` from \`stages\` or \`stage\`, preserve the exact path and platform separators, search with \`rg\`/\`grep\`, and read small relevant ranges; use explicit \`tail\` or \`limit\` only for a bounded preview.`,
  `**Workflow authoring and handoffs**:
  - When a user asks to create or edit a workflow, clarify only unresolved requirements that materially affect its purpose, inputs, stages, handoffs, validation, success criteria, or starter pattern. Read the workflow docs/examples, implement the TypeScript definition with normal coding tools, reload it, and run representative test inputs before presenting it. Use the create-spec skill when it adds value; it is not mandatory when context is already sufficient.
  - Consult docs/workflows.md and its starter patterns (Classify-and-act, Fan-out-and-synthesize, Adversarial verification, Generate-and-filter, Tournament, and Loop until done) when designing a stage graph.
  - Pass large stage context through files/artifacts and \`reads\` with an explicit \`Read the file at <path>...\` prompt rather than large \`previous\` payloads or injected session history.
  - Separate implementation/review acceptance from explicitly authorized final actions such as PR/MR/review creation, release tagging, deployment, or publication. Stop implementation loops once acceptance is proven and carry a remaining final action separately.
  - A model stage sees its local prompt, artifacts, tools, and reads, not the graph name or surrounding implementation. State the concrete action, evidence, and success criteria directly.`,
];
