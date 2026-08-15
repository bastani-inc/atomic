/** Shared status slot used by workflow graph/attach UI surfaces. */
export const WORKFLOW_STATUS_KEY = "pi-workflows";

/**
 * Host status keys hidden from the workflow orchestrator statusline. The MCP
 * server count and the ADHD Mode badge of a separately installed i-have-adhd
 * extension are main-chat chrome and carry no workflow signal, so the overlay
 * keeps its statusline for run-scoped hints instead. The key stays listed
 * even though the package is no longer bundled, so an externally installed
 * copy remains hidden too.
 */
export const OVERLAY_HIDDEN_STATUS_KEYS: ReadonlySet<string> = new Set(["mcp", "i-have-adhd"]);
