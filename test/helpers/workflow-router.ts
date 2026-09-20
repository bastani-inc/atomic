import type { PiExecuteContext } from "../../packages/workflows/src/extension/public-types.js";
import type { WorkflowRouterState } from "../../packages/workflows/src/extension/workflow-router-schema.js";
import type { WorkflowBudget } from "../../packages/workflows/src/shared/budget.js";
import { decisionMessage, decisionModel, messageStream } from "./structured-output.js";

/** Complete caller context for launch tests unrelated to routing semantics. Inference remains mocked. */
export function workflowRouterState(budget?: WorkflowBudget) {
	return {
		task: "Implement the approved change and validate it.",
		conversation: [{ role: "user", text: "Implement only the approved change; do not publish." }],
		constraints: ["Do not publish or widen scope."],
		documents: [
			{ source: "task-contract", content: "Implement the change, run focused checks, and report results." },
		],
		...(budget === undefined
			? {}
			: {
					userBudget: {
						limits: budget,
						provenance: `User explicitly requested limits ${JSON.stringify(budget)}.`,
					},
				}),
	} satisfies WorkflowRouterState;
}
export function workflowRouterContext(workflowType: string, maxBudget: WorkflowBudget = {}): PiExecuteContext {
	return {
		model: decisionModel,
		getRouterModel: () => "decision-test/chat",
		modelRegistry: {
			getAvailable: () => [decisionModel],
			getAll: () => [decisionModel],
			streamSimple: () =>
				messageStream(
					decisionMessage({
						workflowType,
						maxBudget: { ...maxBudget },
						estimatedDuration: "15min",
						interaction: "executable",
						complexity: "workflow_beneficial",
						preference: "unspecified",
					}),
				),
		},
	};
}

/** Deterministic independent judgments for tests concerned with other routing boundaries. */
export function workflowDecisionMessage(values: Record<string, unknown>) {
	return decisionMessage({
		interaction: "executable",
		complexity: "workflow_beneficial",
		preference: "unspecified",
		...values,
	});
}
