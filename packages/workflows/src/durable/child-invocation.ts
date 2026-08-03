import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../shared/types.js";
import { durableHash } from "./durable-hash.js";
import type { WorkflowSerializableObject } from "./types.js";

/** Bind durable child replay to the definition and exact validated input value. */
export function durableChildInvocationFingerprint(
	child: Pick<WorkflowDefinition<WorkflowInputValues, WorkflowOutputValues>, "name" | "normalizedName">,
	inputs: WorkflowSerializableObject,
): string {
	return durableHash({
		definition: { name: child.name, normalizedName: child.normalizedName },
		inputs,
	});
}
