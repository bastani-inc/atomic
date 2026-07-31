/**
 * Cancellation reasons for in-flight `ctx.tool` graph nodes.
 *
 * A tool node can be aborted on its own (`/workflow interrupt|quit` naming the
 * node) or as part of a graceful run-level quit. Both use `AbortError` as the
 * error name so the existing callback-cancellation classification and any
 * author code that checks `err.name === "AbortError"` keep working; the `scope`
 * field is what separates a single-node abort from a graceful run quit.
 *
 * cross-ref: issue #2078 — in-flight ctx.tool calls cannot be quit.
 */

export type WorkflowToolAbortScope = "node" | "quit";

export interface WorkflowToolAbortInput {
	readonly runId: string;
	readonly nodeId: string;
	readonly toolName: string;
	readonly scope: WorkflowToolAbortScope;
}

/** Abort reason handed to a tool node's `AbortController`. */
export class WorkflowToolAbortError extends Error {
	readonly runId: string;
	readonly nodeId: string;
	readonly toolName: string;
	readonly scope: WorkflowToolAbortScope;

	constructor(input: WorkflowToolAbortInput) {
		super(
			`atomic-workflows: ctx.tool ${input.toolName} aborted by ${
				input.scope === "quit" ? "workflow quit" : "node abort"
			}`,
		);
		this.name = "AbortError";
		this.runId = input.runId;
		this.nodeId = input.nodeId;
		this.toolName = input.toolName;
		this.scope = input.scope;
	}
}

export function isWorkflowToolAbortError(value: unknown): value is WorkflowToolAbortError {
	return value instanceof WorkflowToolAbortError;
}

/** Exit reason a gracefully quit run reports instead of a terminal status. */
export const WORKFLOW_GRACEFUL_QUIT_EXIT_REASON = "quit";

/**
 * Suspension raised at a nested `ctx.workflow(...)` boundary whose child run was
 * gracefully quit. It carries the quit through the parent so the parent also
 * suspends instead of recording a terminal child failure.
 */
export class WorkflowGracefulQuitError extends Error {
	readonly runId: string;

	constructor(runId: string, detail: string) {
		super(`atomic-workflows: ${detail} suspended by workflow quit`);
		this.name = "AbortError";
		this.runId = runId;
	}
}

export type WorkflowGracefulQuitSignal = WorkflowToolAbortError | WorkflowGracefulQuitError;

function isGracefulQuitSignal(value: unknown): value is WorkflowGracefulQuitSignal {
	if (value instanceof WorkflowGracefulQuitError) return true;
	return isWorkflowToolAbortError(value) && value.scope === "quit";
}

/**
 * Find a graceful run-quit suspension in an error or its cause chain.
 *
 * Depth-bounded so a self-referential cause cannot spin, and every property
 * read is guarded: control-signal probing must never let a throwing accessor
 * on a foreign error escape into run finalization.
 */
export function findWorkflowGracefulQuit(value: unknown): WorkflowGracefulQuitSignal | undefined {
	let current: unknown = value;
	for (let depth = 0; depth < 8; depth++) {
		if (isGracefulQuitSignal(current)) return current;
		if (typeof current !== "object" || current === null) return undefined;
		try {
			if (!("cause" in current)) return undefined;
			current = (current as { readonly cause?: unknown }).cause;
		} catch {
			return undefined;
		}
	}
	return undefined;
}
