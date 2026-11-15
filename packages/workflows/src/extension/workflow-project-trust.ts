import { projectTrustPrompt } from "../durable/project-trust.js";
import type { WorkflowExecutionPolicy } from "../shared/types.js";
import type { PiCommandContext } from "./public-types.js";

/**
 * A user command that can show a picker may ask whether to trust the project folder a run's workflow is defined in;
 * one that cannot is refused with how to trust it.
 */
export function projectTrustConfirmation(
	ctx: Pick<PiCommandContext, "ui">,
	policy: WorkflowExecutionPolicy,
): { confirmProjectTrust?: (projectDir: string) => Promise<boolean> } {
	const select = ctx.ui.select;
	return policy.allowInputPicker && select !== undefined
		? { confirmProjectTrust: projectTrustPrompt((title, options) => select(title, options)) }
		: {};
}
