/**
 * Builtin workflow: open-claude-design
 *
 * Shape: Design-system onboarding → import → generate → refine → export/handoff.
 *
 * Inputs:
 *   reference     — optional text: URL or path to a design reference (Figma, screenshot, doc).
 *   output_type   — optional select: "component" | "page" | "theme" | "tokens" (default "component").
 *   design_system — optional text: name/identifier of the target design system (e.g. "shadcn", "tailwind", "custom").
 *
 * cross-ref spec §5.11; v0.x packages/atomic/src/commands/builtin-[star]/open-claude-design/
 */
declare const _default: import("../src/types.js").WorkflowDefinition<Record<string, unknown> & Record<"reference", unknown> & Record<"output_type", unknown> & Record<"design_system", unknown>>;
export default _default;
//# sourceMappingURL=open-claude-design.d.ts.map