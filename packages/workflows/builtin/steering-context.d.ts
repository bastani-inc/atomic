import type { WorkflowInputValues, WorkflowOutputValues, WorkflowRunContext } from "../src/authoring.js";

export declare function withSteeringPropagationContext<
	TInputs extends WorkflowInputValues,
	TOutputs extends WorkflowOutputValues,
>(ctx: WorkflowRunContext<TInputs, TOutputs>): WorkflowRunContext<TInputs, TOutputs>;
