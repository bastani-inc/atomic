/**
 * Schema-specific structured_output tool
 *
 * Atomic does not register `structured_output` in normal agent sessions by
 * default. This extension demonstrates the canonical factory for adding a
 * schema-backed terminating final-answer tool only when this extension is
 * enabled.
 *
 * Custom factory names are opt-in tools too: `createStructuredOutputTool({ name:
 * "final_decision", ... })` registers `final_decision`; include that name in any
 * explicit `tools` allowlist. The default factory name registers
 * `structured_output` for this extension/runtime only.
 */

import {
	createStructuredOutputTool,
	type ExtensionAPI,
} from "@bastani/atomic";
import { Type } from "typebox";

const SummarySchema = Type.Object({
	headline: Type.String({ description: "Short title for the result" }),
	summary: Type.String({ description: "One-paragraph summary" }),
	actionItems: Type.Array(Type.String(), { description: "Concrete next steps or key bullets" }),
}, { additionalProperties: false });

const structuredOutputTool = createStructuredOutputTool({
	schema: SummarySchema,
});

export default function (pi: ExtensionAPI) {
	// Register structured_output for sessions that load this extension.
	pi.registerTool(structuredOutputTool);
}
