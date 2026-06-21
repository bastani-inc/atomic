export const WORKFLOW_TOOL_DESCRIPTION =
  "Run named workflows or direct one-off task/tasks/chain workflows; " +
  "discover with list/get/inputs, inspect status/stages/stage details, " +
  "send prompt answers or steering, pause/resume/interrupt/kill runs, and reload workflow resources. " +
  "For large stage handoffs, write context to files/artifacts, pass paths via reads, and prompt downstream agents to 'Read the file at <path>...' instead of injecting large previous text. " +
  "For transcripts, prefer status/stages/stage to get sessionFile/transcriptPath, " +
  "quote the exact path without rewriting separators (Windows backslashes are valid), " +
  "then search it with rg/grep and read small ranges; transcript is path-only by default when sessionFile/transcriptPath exists, explicit tail/limit returns bounded previews, and missing transcript paths fall back to a small preview.";

export const DEFAULT_PROMPT_GUIDANCE: string[] = [
  `**Workflows**: Use the \`workflow\` tool for existing named workflows and for repeatable, inspectable, resumable, or multi-stage processes; use direct \`task\`, \`tasks\`, or \`chain\` workflow calls for one-off tracked work when that is useful.
  - For unfamiliar named workflows, discover with \`action: "list"\`, inspect with \`action: "get"\` or \`action: "inputs"\`, and run with \`action: "run"\`, \`workflow\`, and validated \`inputs\`; do not invent workflow names or input keys.
  - When designing or editing workflows, read docs/workflows.md and reference its Workflow Starter Patterns: Classify-and-act, Fan-out-and-synthesize, Adversarial verification, Generate-and-filter, Tournament, and Loop until done. Choose or combine these patterns before inventing a custom stage graph, and reflect the selected pattern in the spec and Mermaid diagram when using the create-spec skill.
  - Once you run a workflow with the workflow tool, end your current turn and wait for the next user input or lifecycle notice.
    - You will automatically be alerted of key lifecycle events like start, finish, failure; do not micro-manage the run with sleep/status polling loops or read its logs/stages unless the user asks you to or you need information for the next step.
    - If the user needs information from the workflow run, use targeted \`status\`/\`stages\`/\`stage\` checks instead of trying to read everything.
    - Offer to help the user on another task instead of anxiously polling or help the user run another workflow if they need.
    - Use run-control and messaging actions (\`send\`, \`pause\`, \`resume\`, \`interrupt\`, \`kill\`) only when needed to answer prompts, steer a stage, resume or interrupt paused work, or respond to user requests/control signals.
  - For transcripts, avoid reading whole session transcripts at once. Use \`stages\` or \`stage\` to get \`sessionFile\`/\`transcriptPath\`, quote the exact path without rewriting separators (preserve Windows backslashes), search it with \`rg\`/\`grep\`, and read small relevant ranges; use \`transcript\` with explicit \`tail\` or \`limit\` only for quick recent-context checks.
  - If a user asks to create or edit a workflow, use the create-spec skill when available and ask detailed clarifying questions until you understand its purpose, inputs, stages, handoffs, validation, success criteria, and selected starter pattern. Then read the workflow docs/examples and implement the workflow from the created spec directly as a TypeScript definition. After you implement the workflow, reload it to access it and run it with test inputs to validate it works as intended before presenting it to the user.
    - Tip: when designing workflows, implement it in a way that you pass information from stage to stage by writing it to a file or artifact (either deterministic or model-driven), pass the path with \`reads\`, and explicitly prompt the downstream agent with wording like \`Read the file at <path>...\`; do not inject large \`previous\` payloads or session history into the next prompt unless explicitly requested to.
  - If you run \`ralph\` or \`goal\` workflow, define an objective that includes tight scope, concrete and verifiable done criteria, and validation steps; then monitor progress as above instead of doing parallel implementation yourself.`,
];
