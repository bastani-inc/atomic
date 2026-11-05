// #3105: public types from the genuine packed consumer, without ambient bridges.
import {
	type AgentSession,
	type CreateAgentSessionResult,
	type CreateAgentSessionOptions,
	createAgentSession,
	type HostInput,
	type QuestionParams,
	type QuestionnaireResult,
} from "@bastani/atomic";
import {
	deliverStageWake,
	registerStageWakeKind,
	type StageWake,
	type StageWakeDelivery,
	workflow,
} from "@bastani/atomic/workflows";
import * as builtin from "@bastani/atomic/workflows/builtin";
import openClaudeDesign from "@bastani/atomic/workflows/builtin/open-claude-design";

// #4309: a host adds a wake kind by augmenting the published entry, and the public functions see it.
declare module "@bastani/atomic/workflows" {
	interface StageWakeKinds {
		"consumer-compaction-ready": { readonly summaryEntryId: string };
	}
}
type IsAny<T> = 0 extends 1 & T ? true : false;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const sessionIdentity: Equal<CreateAgentSessionResult["session"], AgentSession> = true;
const sessionConcrete: IsAny<CreateAgentSessionResult["session"]> = false;
const hostConcrete: IsAny<HostInput> = false;
const optionsConcrete: IsAny<CreateAgentSessionOptions> = false;
const workflowConcrete: IsAny<typeof workflow> = false;
const builtinConcrete: IsAny<typeof openClaudeDesign> = false;
const humanInput: HostInput = {
	confirm: async (_title, _message, options) => {
		const concrete: IsAny<typeof options> = false;
		void concrete;
		return false;
	},
	select: async (_title, choices) => choices[0],
	input: async () => "  preserved  ",
	editor: async () => "",
	questionnaire: async (questions) => {
		const exact: Equal<typeof questions, QuestionParams> = true;
		const concrete: IsAny<typeof questions> = false;
		void [exact, concrete];
		return { answers: [], cancelled: true } satisfies QuestionnaireResult;
	},
};
async function probe() {
	const { session } = await createAgentSession({ extensionBindings: { humanInput } });
	session.subscribe((event) => {
		const concrete: IsAny<typeof event> = false;
		void concrete;
	});
	await session.dispose();
	// @ts-expect-error Invalid builtin names must not widen the public options.
	await createAgentSession({ builtins: { invented: false } });
}
// @ts-expect-error All five HostInput methods are required.
const incomplete: HostInput = { confirm: async () => true };
function missingMethods(
	confirm: Omit<HostInput, "confirm">,
	select: Omit<HostInput, "select">,
	input: Omit<HostInput, "input">,
	editor: Omit<HostInput, "editor">,
	questionnaire: Omit<HostInput, "questionnaire">,
) {
	// @ts-expect-error confirm is required.
	const a: HostInput = confirm;
	// @ts-expect-error select is required.
	const b: HostInput = select;
	// @ts-expect-error input is required.
	const c: HostInput = input;
	// @ts-expect-error editor is required.
	const d: HostInput = editor;
	// @ts-expect-error questionnaire is required.
	const e: HostInput = questionnaire;
	void [a, b, c, d, e];
}
function stageWakes() {
	const remove: () => void = registerStageWakeKind("consumer-compaction-ready", (wake, context) => {
		const entryId: string = wake.summaryEntryId;
		const kind: "consumer-compaction-ready" = wake.kind;
		const concrete: IsAny<typeof wake> = false;
		void [entryId, kind, concrete, context.runId, context.stageId];
	});
	const delivery: StageWakeDelivery = deliverStageWake("run", "stage", {
		kind: "consumer-compaction-ready",
		summaryEntryId: "entry-1",
	});
	const merged: Equal<
		Extract<StageWake, { readonly kind: "consumer-compaction-ready" }>["summaryEntryId"],
		string
	> = true;
	// @ts-expect-error The augmented kind requires its payload.
	deliverStageWake("run", "stage", { kind: "consumer-compaction-ready" });
	// @ts-expect-error A kind nobody declared is not a stage wake.
	deliverStageWake("run", "stage", { kind: "consumer-undeclared" });
	// @ts-expect-error The built-in tool-results kind takes no handler.
	registerStageWakeKind("tool-results", () => {});
	void [remove, delivery, merged];
}
void [hostConcrete, optionsConcrete, workflowConcrete, builtinConcrete, missingMethods, stageWakes];
void [sessionIdentity, sessionConcrete, probe, incomplete, workflow, builtin, openClaudeDesign];
