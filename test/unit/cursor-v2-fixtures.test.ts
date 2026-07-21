import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fromBinary } from "@bufbuild/protobuf";
import { AgentClientMessageSchema } from "../../packages/cursor/src/proto/cursor-protocol.js";
import {
	CursorConnectFrameDecoder,
	CursorProtobufProtocolCodec,
	CursorTransportError,
	decodeCursorConnectFrames,
} from "../../packages/cursor/src/transport.js";
import { throwIfCursorEndStreamError } from "../../packages/cursor/src/transport-errors.js";

const fixtureDir = new URL("./fixtures/cursor-v2/", import.meta.url);
const expectedFixtures = [
	"cancel-action.hex",
	"get-usable-models-duplicates.hex",
	"get-usable-models-empty.hex",
	"get-usable-models-malformed-row.hex",
	"get-usable-models-max-states.hex",
	"run-route-absent-max.hex",
	"run-route-max.hex",
	"run-route-nonmax.hex",
	"stream-clean-terminal.connect.hex",
	"stream-error-auth.connect.hex",
	"stream-error-server.connect.hex",
	"stream-malformed-header.hex",
	"stream-text-chunks.connect.hex",
	"stream-thinking-chunks.connect.hex",
	"stream-truncated-body.hex",
] as const;
function fixture(name: string): Uint8Array {
	const text = readFileSync(new URL(name, fixtureDir), "utf8").replace(/#.*$/gmu, "").replace(/\s+/gu, "");
	return Uint8Array.from(Buffer.from(text, "hex"));
}

describe("Cursor v2 sanitized protocol fixtures", () => {
	test("contains exactly 15 bounded synthetic fixtures with no forbidden data", () => {
		const actual = readdirSync(fixtureDir).filter((name) => name.endsWith(".hex")).sort();
		assert.deepEqual(actual, [...expectedFixtures]);
		const allowedPrintable = /^(?: R\/1 [8J]?|one|two|think-[12]|[27][{]"error":[{]"code":"(?:unauthenticated|internal)","message":"(?:denied|rejected)"[}][}])$/u;
		for (const name of expectedFixtures) {
			const bytes = fixture(name);
			assert.ok(bytes.byteLength <= 64, `${name} is not a bounded purpose fixture`);
			const raw = Buffer.from(bytes).toString("latin1");
			assert.doesNotMatch(raw, /(?:authorization|bearer|cookie|api[_-]?key|eyJ[A-Za-z0-9_-]+\.|[0-9a-f]{8}-[0-9a-f-]{27}|[A-Z]:\\|\/(?:Users|home)\/|https?:\/\/|[\w.+-]+@[\w.-]+)/iu, `${name} contains forbidden identity, credential, or machine data`);
			for (const printable of raw.match(/[ -~]{3,}/gu) ?? []) {
				assert.match(printable, allowedPrintable, `${name} contains non-synthetic printable content`);
			}
		}
	});
	test("decodes duplicate, Max tri-state, empty, and malformed discovery fixtures", () => {
		const codec = new CursorProtobufProtocolCodec();
		assert.deepEqual(codec.decodeGetUsableModelsResponse(fixture("get-usable-models-duplicates.hex")), [
			{ modelId: "A", maxMode: false }, { modelId: "B", maxMode: false }, { modelId: "A", maxMode: false },
		]);
		assert.deepEqual(codec.decodeGetUsableModelsResponse(fixture("get-usable-models-max-states.hex")), [
			{ modelId: "M", maxMode: undefined }, { modelId: "M", maxMode: false }, { modelId: "M", maxMode: true },
		]);
		assert.deepEqual(codec.decodeGetUsableModelsResponse(fixture("get-usable-models-empty.hex")), []);
		assert.throws(() => codec.decodeGetUsableModelsResponse(fixture("get-usable-models-malformed-row.hex")));
	});

	test("proves exact dual route fields, Max mapping, and zero parameter elements", () => {
		for (const [name, modelMax, requestedMax] of [
			["run-route-nonmax.hex", false, false],
			["run-route-max.hex", true, true],
			["run-route-absent-max.hex", undefined, false],
		] as const) {
			const message = fromBinary(AgentClientMessageSchema, fixture(name)).message;
			assert.equal(message.case, "runRequest");
			if (message.case !== "runRequest") throw new Error("fixture is not a run request");
			const run = message.value;
			assert.equal(run.modelDetails?.modelId, " R/1 ");
			assert.equal(run.modelDetails?.maxMode, modelMax);
			assert.equal(run.requestedModel?.modelId, " R/1 ");
			assert.equal(run.requestedModel?.maxMode, requestedMax);
			assert.deepEqual(run.requestedModel?.parameters, []);
		}
	});

	test("decodes ordered text/thinking frames and clean terminal", () => {
		const codec = new CursorProtobufProtocolCodec();
		const text = decodeCursorConnectFrames(fixture("stream-text-chunks.connect.hex"));
		assert.deepEqual(text.flatMap((frame) => codec.decodeRunFrame(frame)), [
			{ type: "textDelta", text: "one" }, { type: "textDelta", text: "two" },
		]);
		const thinking = decodeCursorConnectFrames(fixture("stream-thinking-chunks.connect.hex"));
		assert.deepEqual(thinking.flatMap((frame) => codec.decodeRunFrame(frame)), [
			{ type: "thinkingDelta", text: "think-1" }, { type: "thinkingDelta", text: "think-2" },
		]);
		const cancel = fromBinary(AgentClientMessageSchema, fixture("cancel-action.hex")).message;
		assert.equal(cancel.case, "conversationAction");
		if (cancel.case === "conversationAction") assert.equal(cancel.value.action.case, "cancelAction");
		const [terminal] = decodeCursorConnectFrames(fixture("stream-clean-terminal.connect.hex"));
		assert.equal(terminal?.endStream, true);
		assert.doesNotThrow(() => throwIfCursorEndStreamError(terminal?.data ?? new Uint8Array(), []));
	});

	test("classifies sanitized auth/server errors and malformed/truncated frames", () => {
		for (const [name, code] of [["stream-error-auth.connect.hex", "Authentication"], ["stream-error-server.connect.hex", "ServerError"]] as const) {
			const [frame] = decodeCursorConnectFrames(fixture(name));
			assert.throws(() => throwIfCursorEndStreamError(frame?.data ?? new Uint8Array(), []),
				(error: Error) => error instanceof CursorTransportError && error.code === code);
		}
		for (const name of ["stream-malformed-header.hex", "stream-truncated-body.hex"]) {
			const decoder = new CursorConnectFrameDecoder();
			decoder.push(fixture(name));
			assert.throws(() => decoder.finish(), CursorTransportError);
		}
	});
});
