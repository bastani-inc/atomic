/**
 * Builtin workflow: ralph
 *
 * Shape: Plan → orchestrate → review loop with bounded iteration.
 * Human-in-the-loop (HIL) via ctx.ui.editor() / ctx.ui.confirm() between
 * iterations.  Bounded by a JS for-loop; terminates early when the reviewer
 * approves or the iteration cap is reached.
 *
 * Inputs:
 *   prompt         — required text: the task/goal for ralph to accomplish.
 *   max_iterations — optional number (default 3): hard cap on plan→act→review cycles.
 *
 * cross-ref spec §5.11; v0.x packages/atomic/src/commands/builtin-[star]/ralph/
 */
declare const _default: import("../src/types.js").WorkflowDefinition<Record<string, unknown> & Record<"prompt", unknown> & Record<"max_iterations", unknown>>;
export default _default;
//# sourceMappingURL=ralph.d.ts.map