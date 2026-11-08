import { describe, test } from "vitest";
import { rehydrateError, serializeError } from "../../packages/workflows/src/shared/error-codec.js";
import {
	deserializeWorkflowStructuredOutputInferenceError,
	findWorkflowStructuredOutputInferenceError,
	isWorkflowStructuredOutputInferenceError,
	WorkflowStructuredOutputInferenceError,
	type WorkflowStructuredOutputInferenceErrorCode,
	type WorkflowStructuredOutputInferenceErrorFields,
} from "../../packages/workflows/src/shared/structured-output-errors.js";
import { assert } from "./executor-shared.js";

const FIELDS: WorkflowStructuredOutputInferenceErrorFields = {
	runId: "run-1",
	stageId: "stage-1",
	stageName: "review",
	toolCallId: "workflow-auto-structured-output-2",
};
const CODES: readonly WorkflowStructuredOutputInferenceErrorCode[] = [
	"auto-inference-failed",
	"tool-context-unavailable",
];

describe("WorkflowStructuredOutputInferenceError (#4565)", () => {
	test("each code has its own name, hint and fields, is not retryable and builds its message from them (#4565)", () => {
		for (const code of CODES) {
			const error = new WorkflowStructuredOutputInferenceError(code, FIELDS);

			assert.ok(error instanceof Error);
			assert.equal(error.name, "WorkflowStructuredOutputInferenceError");
			assert.equal(error.code, code);
			assert.equal(error.retryable, false);
			assert.deepEqual(error.fields, FIELDS);
			assert.ok(error.hint.length > 0);
			assert.ok(error.message.includes('stage "review"'), error.message);
			assert.ok(error.message.includes(`(${code}). `), error.message);
			assert.ok(error.message.endsWith(error.hint), error.message);
		}
		assert.notEqual(
			new WorkflowStructuredOutputInferenceError("auto-inference-failed", FIELDS).hint,
			new WorkflowStructuredOutputInferenceError("tool-context-unavailable", FIELDS).hint,
		);
	});

	test("renders its message as the subject, the code and the hint, once per code (#4565)", () => {
		const failed = new WorkflowStructuredOutputInferenceError("auto-inference-failed", FIELDS);
		const unavailable = new WorkflowStructuredOutputInferenceError("tool-context-unavailable", FIELDS);

		assert.equal(
			failed.message,
			`The automatic structured_output inference failed: stage "review" (auto-inference-failed). ${failed.hint}`,
		);
		assert.equal(
			unavailable.message,
			`The automatic structured_output inference could not start: stage "review" (tool-context-unavailable). ${unavailable.hint}`,
		);
		assert.match(failed.hint, /corrective prompts.*decisionModel.*schemaTimeoutMs/);
		assert.match(unavailable.hint, /corrective prompts.*Atomic SDK/);
	});

	test("keeps the lower-level failure as its cause and puts no prompt text in its message or fields (#4565)", () => {
		const cause = new Error("decision provider unavailable");
		const error = new WorkflowStructuredOutputInferenceError("auto-inference-failed", FIELDS, { cause });

		assert.equal(error.cause, cause);
		assert.equal(error.message.includes(cause.message), false);
		assert.deepEqual(Object.keys(error.fields).sort(), ["runId", "stageId", "stageName", "toolCallId"]);
		assert.equal(new WorkflowStructuredOutputInferenceError("tool-context-unavailable", FIELDS).cause, undefined);
	});

	test("the guard matches the class and a structural copy by name and code, and nothing else (#4565)", () => {
		const error = new WorkflowStructuredOutputInferenceError("auto-inference-failed", FIELDS);

		assert.equal(isWorkflowStructuredOutputInferenceError(error), true);
		assert.equal(
			isWorkflowStructuredOutputInferenceError({
				name: "WorkflowStructuredOutputInferenceError",
				code: "tool-context-unavailable",
			}),
			true,
		);
		assert.equal(isWorkflowStructuredOutputInferenceError({ name: "Error", code: "auto-inference-failed" }), false);
		assert.equal(
			isWorkflowStructuredOutputInferenceError({ name: "WorkflowStructuredOutputInferenceError", code: "other" }),
			false,
		);
		assert.equal(isWorkflowStructuredOutputInferenceError(new Error("auto-inference-failed")), false);
		assert.equal(isWorkflowStructuredOutputInferenceError(undefined), false);
		assert.equal(isWorkflowStructuredOutputInferenceError("auto-inference-failed"), false);
	});

	test("the finder walks the cause chain to a bounded depth (#4565)", () => {
		const inner = new WorkflowStructuredOutputInferenceError("auto-inference-failed", FIELDS);
		const wrapped = new Error("stage failed", { cause: new Error("turn failed", { cause: inner }) });
		assert.equal(findWorkflowStructuredOutputInferenceError(wrapped), inner);
		assert.equal(findWorkflowStructuredOutputInferenceError(inner), inner);
		assert.equal(findWorkflowStructuredOutputInferenceError(new Error("plain")), undefined);

		let deep: Error = inner;
		for (let level = 0; level < 12; level += 1) deep = new Error(`level ${level}`, { cause: deep });
		assert.equal(findWorkflowStructuredOutputInferenceError(deep), undefined, "a chain deeper than the bound ends");

		const cyclic = new Error("loop");
		Object.defineProperty(cyclic, "cause", { value: cyclic });
		assert.equal(findWorkflowStructuredOutputInferenceError(cyclic), undefined);
	});

	test("serializes to JSON and rebuilds as the same class with its fields and cause chain (#4565)", () => {
		const original = new WorkflowStructuredOutputInferenceError("auto-inference-failed", FIELDS, {
			cause: new Error("decision failed", {
				cause: Object.assign(new Error("provider down"), { code: "ECONNRESET" }),
			}),
		});

		const json = JSON.parse(JSON.stringify(original.toJSON()));
		const rebuilt = deserializeWorkflowStructuredOutputInferenceError(json);

		assert.ok(rebuilt instanceof WorkflowStructuredOutputInferenceError);
		assert.equal(rebuilt.code, original.code);
		assert.equal(rebuilt.hint, original.hint);
		assert.equal(rebuilt.retryable, false);
		assert.equal(rebuilt.message, original.message);
		assert.deepEqual(rebuilt.fields, FIELDS);
		const decision = rebuilt.cause as Error & { cause?: Error & { code?: string } };
		assert.equal(decision.message, "decision failed");
		assert.equal(decision.cause?.message, "provider down");
		assert.equal(decision.cause?.code, "ECONNRESET");
	});

	test("serializes only the facts it has: no cause and no code unless the error carries them (#4565)", () => {
		const bare = new WorkflowStructuredOutputInferenceError("tool-context-unavailable", FIELDS);
		assert.equal(Object.hasOwn(bare.toJSON(), "cause"), false);

		const chained = new WorkflowStructuredOutputInferenceError("auto-inference-failed", FIELDS, {
			cause: new Error("outer", { cause: Object.assign(new Error("inner"), { code: "ECONNRESET" }) }),
		});
		assert.deepEqual(chained.toJSON().cause, {
			name: "Error",
			message: "outer",
			cause: { name: "Error", message: "inner", code: "ECONNRESET" },
		});
	});

	test("serializes a cause that is not an Error as its text, and ends a deep chain at the bound (#4565)", () => {
		const text = new WorkflowStructuredOutputInferenceError("auto-inference-failed", FIELDS, {
			cause: "provider down",
		});
		assert.deepEqual(text.toJSON().cause, { name: "Error", message: "provider down" });

		let chain: Error = new Error("level 0");
		for (let level = 1; level < 12; level += 1) chain = new Error(`level ${level}`, { cause: chain });
		const deep = new WorkflowStructuredOutputInferenceError("auto-inference-failed", FIELDS, { cause: chain });
		const messages: string[] = [];
		for (let link = deep.toJSON().cause as { message: string; cause?: unknown } | undefined; link; ) {
			messages.push(link.message);
			link = link.cause as typeof link | undefined;
		}
		assert.deepEqual(
			messages,
			[11, 10, 9, 8, 7, 6, 5, 4, 3].map((level) => `level ${level}`),
		);
	});

	test("rebuilds without a cause when the serialized error has none, and keeps the serialized message (#4565)", () => {
		const original = new WorkflowStructuredOutputInferenceError("tool-context-unavailable", FIELDS);

		const rebuilt = deserializeWorkflowStructuredOutputInferenceError({
			...original.toJSON(),
			message: "a message written by another version",
		});

		assert.ok(rebuilt);
		assert.equal(Object.hasOwn(rebuilt, "cause"), false);
		assert.equal(rebuilt.message, "a message written by another version");
	});

	test("rebuilds a cause chain without inventing causes or codes, and ends a deep one at the bound (#4565)", () => {
		const serialized = new WorkflowStructuredOutputInferenceError("auto-inference-failed", FIELDS, {
			cause: new Error("plain"),
		}).toJSON();

		const plain = deserializeWorkflowStructuredOutputInferenceError(serialized)?.cause as Error;
		assert.equal(plain.message, "plain");
		assert.equal(Object.hasOwn(plain, "cause"), false);
		assert.equal(Object.hasOwn(plain, "code"), false);

		type Link = { name: string; message: string; cause?: Link };
		let nested: Link = { name: "Error", message: "level 0" };
		for (let level = 1; level < 12; level += 1) nested = { name: "Error", message: `level ${level}`, cause: nested };
		const deep = deserializeWorkflowStructuredOutputInferenceError({ ...serialized, cause: nested });
		const messages: string[] = [];
		for (let link = deep?.cause as (Error & { cause?: unknown }) | undefined; link; ) {
			messages.push(link.message);
			link = link.cause as typeof link | undefined;
		}
		assert.deepEqual(
			messages,
			[11, 10, 9, 8, 7, 6, 5, 4, 3].map((level) => `level ${level}`),
		);
	});

	test("a serialized error with a code it does not know is refused (#4565)", () => {
		const json = {
			...new WorkflowStructuredOutputInferenceError("auto-inference-failed", FIELDS).toJSON(),
			code: "future",
		};

		assert.equal(deserializeWorkflowStructuredOutputInferenceError(json), undefined);
	});

	test("crosses the worker protocol as its own class and keeps its cause (#4565)", () => {
		const original = new WorkflowStructuredOutputInferenceError("tool-context-unavailable", FIELDS, {
			cause: new Error("extension runner is closed"),
		});

		const rebuilt = rehydrateError(JSON.parse(JSON.stringify(serializeError(original))));

		assert.ok(rebuilt instanceof WorkflowStructuredOutputInferenceError);
		assert.equal(serializeError(original).family, "structured-output");
		assert.deepEqual((rebuilt as WorkflowStructuredOutputInferenceError).fields, FIELDS);
		assert.equal((rebuilt.cause as Error).message, "extension runner is closed");
	});
});
