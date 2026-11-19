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
type IsAny<T> = 0 extends 1 & T ? true : false;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const sessionIdentity: Equal<CreateAgentSessionResult["session"], AgentSession> = true;
const sessionConcrete: IsAny<CreateAgentSessionResult["session"]> = false;
const hostConcrete: IsAny<HostInput> = false;
const optionsConcrete: IsAny<CreateAgentSessionOptions> = false;
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
	await createAgentSession({ builtins: { workflows: false } });
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
void [hostConcrete, optionsConcrete, missingMethods, sessionIdentity, sessionConcrete, probe, incomplete];
