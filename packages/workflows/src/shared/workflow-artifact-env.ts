/**
 * Leaf module: durable workflow-artifact constants with no imports.
 *
 * These values are plain data, but their previous home — `workflow-artifacts.ts`
 * — sits atop roughly fifty modules including `@bastani/atomic` itself. Any
 * consumer that wanted only a constant paid to transform that whole graph.
 *
 * `test/setup-workflow-durability.ts` is such a consumer, and vitest runs it
 * once per test file, so every unit file transformed ten thousand lines to read
 * one string. Keeping these constants importable without dependencies is what
 * lets that setup stay cheap; `workflow-artifacts.ts` re-exports them, so this
 * split is invisible to every existing caller.
 *
 * Keep this module dependency-free.
 */

/** Maximum age of durable workflow run artifacts before the next workflow write prunes them. */
export const WORKFLOW_ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Overrides the durable workflow-artifact root, mirroring the agent-directory override convention. */
export const ENV_WORKFLOW_ARTIFACT_DIR = "ATOMIC_WORKFLOW_ARTIFACT_DIR";
