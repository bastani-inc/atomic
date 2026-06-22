import type { AgentType, Workflow, WorkflowInput } from "./workflow-picker-types.js";

export const DEFAULT_PROMPT_INPUT: WorkflowInput = {
  name: "prompt",
  type: "text",
  required: true,
  description: "what do you want this workflow to do?",
  placeholder: "describe your task…",
};

export const WORKFLOWS: Workflow[] = [
  { name: "deep-research-codebase", description: "Deterministic deep codebase research: scout → LOC-driven parallel explorers → aggregator.", source: "local", agents: ["copilot"] },
  { name: "generate-spec", description: "Convert research docs into detailed execution specs with file paths and test plans.", source: "local", agents: ["claude", "copilot"], inputs: [
    { name: "research_doc", type: "string", required: true, description: "path to the research doc to convert", placeholder: "research/docs/2026-04-11-auth.md" },
    { name: "focus", type: "enum", required: true, description: "how aggressively to scope the spec", values: ["minimal", "standard", "exhaustive"], default: "standard" },
    { name: "notes", type: "text", description: "extra guidance for the spec writer (optional)", placeholder: "anything the research doc doesn't already cover…" },
  ] },
  { name: "refactor-planner", description: "Plan multi-file refactors with cross-module impact analysis and rollback guidance.", source: "local", agents: ["claude"], inputs: [
    { name: "target_dir", type: "string", required: true, description: "directory rooted in the repo to analyse", placeholder: "src/middleware/auth" },
    { name: "goal", type: "text", required: true, description: "what the refactor should achieve", placeholder: "migrate legacy session tokens to HMAC scheme, preserving…" },
    { name: "strategy", type: "enum", required: true, description: "how to stage the rollout", values: ["incremental", "full-rewrite", "parallel"], default: "incremental" },
  ] },
  { name: "code-review", description: "Run a PR diff through every installed agent backend, then reconcile disagreements.", source: "global", agents: ["claude", "opencode", "copilot"], inputs: [
    { name: "pr_ref", type: "string", required: true, description: "PR number, branch, or git ref", placeholder: "anomalyco/atomic#580" },
    { name: "depth", type: "enum", required: true, description: "how deeply to analyse each hunk", values: ["quick", "thorough"], default: "thorough" },
  ] },
  { name: "doc-writer", description: "Generate or update API docs from source, preserving prior prose where still accurate.", source: "global", agents: ["claude", "opencode"] },
  { name: "hello-world", description: "Minimal two-stage demo workflow — useful for validating SDK setups.", source: "builtin", agents: ["claude", "opencode", "copilot"] },
];

export const INSTALLED_AGENTS: Record<AgentType, boolean> = {
  claude: true,
  copilot: true,
  opencode: false,
};

export const VALID_AGENTS: readonly AgentType[] = ["claude", "copilot", "opencode"];
export const DEFAULT_AGENT: AgentType = "copilot";

export function parseAgentFromArgv(): AgentType {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag !== "-a" && flag !== "--agent") continue;
    const val = args[i + 1];
    if (!val) {
      console.error(`Missing value for ${flag}. Usage: -a <${VALID_AGENTS.join("|")}>`);
      process.exit(1);
    }
    if (!(VALID_AGENTS as readonly string[]).includes(val)) {
      console.error(`Unknown agent "${val}". Valid: ${VALID_AGENTS.join(", ")}`);
      process.exit(1);
    }
    return val as AgentType;
  }
  return DEFAULT_AGENT;
}

export const CURRENT_AGENT: AgentType = parseAgentFromArgv();
