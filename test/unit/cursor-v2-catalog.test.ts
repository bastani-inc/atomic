import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	CURSOR_HOST_CONTEXT_WINDOW,
	CURSOR_HOST_MAX_OUTPUT_TOKENS,
	mapCursorCatalogToProviderModels,
	type CursorModelCatalog,
} from "../../packages/cursor/src/model-mapper.js";
import { CursorProtobufProtocolCodec } from "../../packages/cursor/src/proto/protobuf-codec.js";
import { GetUsableModelsResponseSchema, ModelDetailsSchema } from "../../packages/cursor/src/proto/cursor-protocol.js";
import { CursorError } from "../../packages/cursor/src/errors.js";

function catalog(rows: CursorModelCatalog["rows"]): CursorModelCatalog {
	return { accountScope: "cursor-account-v1:scope", clientVersion: "client-v1", fetchedAt: 10, catalogGeneration: 4, providerInstanceGeneration: 7, credentialGeneration: 9, rows };
}

const cursorSourceRoot = new URL("../../packages/cursor/src/", import.meta.url);

function productionCursorFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return productionCursorFiles(path);
		return /\.(?:json|ts)$/u.test(entry.name) ? [path] : [];
	});
}

describe("Cursor authoritative catalog", () => {
	test("projects every exact row in literal order without grouping duplicates", () => {
		const models = mapCursorCatalogToProviderModels(catalog([
			{ modelId: " A ", displayName: "First A", maxMode: undefined },
			{ modelId: "B", maxMode: false },
			{ modelId: " A ", displayName: "Second A", maxMode: undefined },
			{ modelId: " A ", maxMode: true },
		]));
		assert.deepEqual(models.map((model) => model.id), [" A ", "B", " A ", " A "]);
		assert.deepEqual(models.map((model) => model.providerReference.data), [
			{ accountScope: "cursor-account-v1:scope", routeId: " A ", maxMode: undefined, occurrence: 1, catalogGeneration: 4, providerInstanceGeneration: 7, credentialGeneration: 9, clientVersion: "client-v1" },
			{ accountScope: "cursor-account-v1:scope", routeId: "B", maxMode: false, occurrence: 1, catalogGeneration: 4, providerInstanceGeneration: 7, credentialGeneration: 9, clientVersion: "client-v1" },
			{ accountScope: "cursor-account-v1:scope", routeId: " A ", maxMode: undefined, occurrence: 2, catalogGeneration: 4, providerInstanceGeneration: 7, credentialGeneration: 9, clientVersion: "client-v1" },
			{ accountScope: "cursor-account-v1:scope", routeId: " A ", maxMode: true, occurrence: 1, catalogGeneration: 4, providerInstanceGeneration: 7, credentialGeneration: 9, clientVersion: "client-v1" },
		]);
		for (const model of models) {
			assert.deepEqual(model.input, ["text"]);
			assert.equal(model.reasoning, false);
			assert.equal(model.contextWindow, CURSOR_HOST_CONTEXT_WINDOW);
			assert.equal(model.maxTokens, CURSOR_HOST_MAX_OUTPUT_TOKENS);
		}
	});

	test("treats an authoritative empty catalog as a successful empty projection", () => {
		assert.deepEqual(mapCursorCatalogToProviderModels(catalog([])), []);
	});
});

	test("production contains no static/default or legacy catalog surface", () => {
		for (const relative of ["cursor-models-raw.json", "model-reference.ts", "proto/agent_pb.ts", "proto/protobuf-codec-base64.ts"]) {
			assert.equal(existsSync(new URL(relative, cursorSourceRoot)), false, `${relative} must stay deleted`);
		}
		for (const path of productionCursorFiles(cursorSourceRoot.pathname)) {
			const source = readFileSync(path, "utf8");
			assert.doesNotMatch(source, /CURSOR_DEFAULT_MODEL_ID|["']composer-2["']|AvailableModels/u, `${path} contains a forbidden static/default catalog symbol`);
		}
	});

describe("GetUsableModels exact protobuf decoding", () => {
	test("preserves exact IDs, order, duplicates, and optional Max presence", () => {
		const body = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, { modelId: " A ", displayName: "A" }),
				create(ModelDetailsSchema, { modelId: "B", maxMode: false }),
				create(ModelDetailsSchema, { modelId: " A ", maxMode: true }),
			],
		}));
		assert.deepEqual(new CursorProtobufProtocolCodec().decodeGetUsableModelsResponse(body), [
			{ modelId: " A ", displayName: "A", maxMode: undefined },
			{ modelId: "B", maxMode: false },
			{ modelId: " A ", maxMode: true },
		]);
	});

	test("rejects malformed trailing framing after a valid catalog data frame", () => {
		const body = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {
			models: [create(ModelDetailsSchema, { modelId: "ok" })],
		}));
		const framed = new Uint8Array(5 + body.byteLength + 6);
		new DataView(framed.buffer).setUint32(1, body.byteLength, false);
		framed.set(body, 5);
		const trailing = 5 + body.byteLength;
		new DataView(framed.buffer).setUint32(trailing + 1, 9, false);
		framed[trailing + 5] = 1;
		assert.throws(() => new CursorProtobufProtocolCodec().decodeGetUsableModelsResponse(framed), (error: Error) =>
			error instanceof CursorError && error.code === "ProtocolMalformed");
	});

	test("accepts empty and rejects the whole response when any row has an empty ID", () => {
		const codec = new CursorProtobufProtocolCodec();
		assert.deepEqual(codec.decodeGetUsableModelsResponse(toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {}))), []);
		const malformed = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {
			models: [create(ModelDetailsSchema, { modelId: "good" }), create(ModelDetailsSchema, { modelId: "" })],
		}));
		assert.throws(() => codec.decodeGetUsableModelsResponse(malformed), CursorError);
	});
});
