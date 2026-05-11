/**
 * Builtin workflow: deep-research-codebase
 *
 * Shape: Scout → per-partition specialist sub-agents → aggregator.
 * Each specialist stage is run in parallel (Promise.all).
 *
 * Inputs:
 *   prompt        — required text: the research question / investigation focus.
 *   max_partitions — optional number (default 4): max parallel specialist stages.
 *
 * cross-ref spec §5.11; v0.x packages/atomic/src/commands/builtin-[star]/deep-research-codebase/
 */
declare const _default: import("../src/types.js").WorkflowDefinition<Record<string, unknown> & Record<"prompt", unknown> & Record<"max_partitions", unknown>>;
export default _default;
//# sourceMappingURL=deep-research-codebase.d.ts.map