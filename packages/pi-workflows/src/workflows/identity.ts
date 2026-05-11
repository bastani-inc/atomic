/**
 * Workflow name identity helpers.
 * Provides a canonical normalized form used as the registry key.
 *
 * cross-ref: pi-subagents src/agents/identity.ts
 */

/**
 * Normalize a workflow name to a canonical key:
 * - Trim surrounding whitespace
 * - Lowercase
 * - Replace one or more whitespace / underscore characters with a single hyphen
 * - Strip any characters that are not alphanumeric or hyphens
 *
 * @example
 * normalizeWorkflowName("Deep Research Codebase") // "deep-research-codebase"
 * normalizeWorkflowName("my_workflow")             // "my-workflow"
 * normalizeWorkflowName("  My Workflow  ")         // "my-workflow"
 */
export function normalizeWorkflowName(name: string): string {
  if (!name || typeof name !== "string") {
    throw new TypeError("normalizeWorkflowName: name must be a non-empty string");
  }
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Returns true when two workflow names refer to the same workflow
 * (i.e. their normalized forms are identical).
 */
export function workflowNamesEqual(a: string, b: string): boolean {
  return normalizeWorkflowName(a) === normalizeWorkflowName(b);
}
