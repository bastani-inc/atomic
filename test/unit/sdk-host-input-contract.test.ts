import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionBindings as OriginalBindings } from "../../packages/coding-agent/src/core/agent-session-types.js";
import type { HostInput as ExtensionHostInput } from "../../packages/coding-agent/src/core/extensions/index.js";
import type {
	QuestionParams as OriginalParams,
	QuestionnaireResult as OriginalResult,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.js";
import type {
	AgentSession,
	ExtensionBindings,
	HostDiagnostic,
	HostInput,
	HostInputOptions,
	QuestionnaireResult,
	QuestionParams,
} from "../../packages/coding-agent/src/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type IsAny<T> = 0 extends 1 & T ? true : false;

// #3105: checked by the root TypeScript gate, not just runtime assertions.
const exact: [
	Equal<QuestionParams, OriginalParams>,
	Equal<QuestionnaireResult, OriginalResult>,
	Equal<HostInput, ExtensionHostInput>,
	IsAny<HostInput>,
	IsAny<QuestionParams>,
] = [true, true, true, false, false];
const options: HostInputOptions = { signal: new AbortController().signal, requestId: "request", sessionId: "session" };
const diagnostic: HostDiagnostic = { level: "warning", source: "fixture", message: "safe", sessionId: "session" };
// @ts-expect-error All five human-input methods are required.
const incomplete: HostInput = { confirm: async () => true };
// @ts-expect-error Confirmation must be a boolean, not a truthy string.
const invalidConfirm: HostInput["confirm"] = async () => "yes";
// @ts-expect-error Request identity is mandatory.
const missingIdentity: HostInputOptions = { signal: new AbortController().signal, sessionId: "session" };

// #3105: a named root import must compile, not merely disappear during Vitest transpilation.
const exactBindings: [
	Equal<ExtensionBindings, OriginalBindings>,
	Equal<ExtensionBindings, Parameters<AgentSession["bindExtensions"]>[0]>,
	IsAny<ExtensionBindings>,
	Equal<ExtensionBindings["humanInput"], HostInput | null | undefined>,
	Equal<ExtensionBindings["onDiagnostic"], ((diagnostic: HostDiagnostic) => void) | undefined>,
] = [true, true, false, true, true];
const omittedBindings: ExtensionBindings = {};
const withdrawnBindings: ExtensionBindings = { humanInput: null };
// @ts-expect-error Named bindings retain the required HostInput methods.
const incompleteBindings: ExtensionBindings = { humanInput: { confirm: async () => true } };

test("public ExtensionBindings export retains its exact concrete binding contract", () => {
	assert.deepEqual(exactBindings, [true, true, false, true, true]);
	assert.equal(omittedBindings.humanInput, undefined);
	assert.equal(withdrawnBindings.humanInput, null);
	assert.equal(typeof incompleteBindings.humanInput?.confirm, "function");
});

test("public host-input exports retain concrete original questionnaire types", () => {
	assert.deepEqual(exact, [true, true, true, false, false]);
	assert.equal(options.requestId, "request");
	assert.equal(options.sessionId, "session");
	assert.equal(diagnostic.level, "warning");
	assert.equal(typeof incomplete.confirm, "function");
	assert.equal(typeof invalidConfirm, "function");
	assert.equal(missingIdentity.sessionId, "session");
});
