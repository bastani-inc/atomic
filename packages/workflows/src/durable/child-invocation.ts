import type { Workspace } from "@bastani/atomic";
import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../shared/types.js";
import { durableHash } from "./durable-hash.js";
import type { WorkflowSerializableObject } from "./types.js";

/**
 * Bind durable child replay to the definition, the exact validated input value and the workspace identity, so two
 * otherwise identical children bound to different repositories never share a replay ordinal.
 */
export function durableChildInvocationFingerprint(
	child: Pick<WorkflowDefinition<WorkflowInputValues, WorkflowOutputValues>, "name" | "normalizedName">,
	inputs: WorkflowSerializableObject,
	workspace?: Workspace,
): string {
	return durableHash({
		definition: { name: child.name, normalizedName: child.normalizedName },
		inputs,
		...(workspace !== undefined
			? {
					workspace: {
						repo: workspace.repo,
						base: workspace.base ?? null,
						branch: workspace.branch ?? null,
						worktree: workspace.worktree ?? null,
						sandbox: workspace.sandbox,
					},
				}
			: {}),
	});
}
