import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Context, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import type { ProviderConfigInput } from "../../packages/coding-agent/src/core/model-registry-types.js";
import { trustedCursorProviderSource } from "../../packages/coding-agent/test/cursor-test-provider-source.js";
import { CursorAuthService } from "../../packages/cursor/src/auth.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import { registerCursorProvider, type CursorProviderConfig, type CursorProviderHost } from "../../packages/cursor/src/provider.js";
import { CursorProtobufProtocolCodec } from "../../packages/cursor/src/transport.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";
import { cursorProtoTest } from "./cursor-proto-test-helpers.js";
import { collectEvents } from "./cursor-stream-helpers.js";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const imageContext: Context = {
	messages: [{
		role: "user",
		content: [{ type: "text", text: "describe" }, { type: "image", data: "aGk=", mimeType: "image/png" }],
		timestamp: 1,
	}],
};
const callbacks: OAuthLoginCallbacks = { onAuth() {}, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined };

function token(subject: string): string {
	return `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`;
}

function bytesField(fields: ReturnType<typeof cursorProtoTest.readFields>, fieldNumber: number): Uint8Array {
	const value = fields.find((field) => field.fieldNumber === fieldNumber)?.value;
	assert.ok(value instanceof Uint8Array, `expected length-delimited field ${fieldNumber}`);
	return value;
}

function stringField(fields: ReturnType<typeof cursorProtoTest.readFields>, fieldNumber: number): string {
	return cursorProtoTest.decodeString(bytesField(fields, fieldNumber));
}

function boolField(fields: ReturnType<typeof cursorProtoTest.readFields>, fieldNumber: number): boolean {
	const value = fields.find((field) => field.fieldNumber === fieldNumber)?.value;
	if (value === undefined) return false;
	assert.equal(typeof value, "bigint", `expected varint field ${fieldNumber}`);
	return value !== 0n;
}
class QueueAuthService extends CursorAuthService {
	readonly #tokens: string[];
	constructor(tokens: string[]) {
		super();
		this.#tokens = [...tokens];
	}
	override async login(): Promise<OAuthCredentials> {
		const access = this.#tokens.shift();
		if (access === undefined) throw new Error("No queued Cursor login token");
		return { access, refresh: "refresh", expires: 1 };
	}
}

class QueueDiscoveryService extends CursorModelDiscoveryService {
	readonly #catalogs: CursorModelCatalog[];
	constructor(catalogs: CursorModelCatalog[]) {
		super({ transport: new CursorMockTransport() });
		this.#catalogs = [...catalogs];
	}
	override async discover(): Promise<CursorModelCatalog> {
		const catalog = this.#catalogs.shift();
		if (catalog === undefined) throw new Error("No queued Cursor catalog");
		return catalog;
	}
}

function registryHost(): {
	readonly host: CursorProviderHost;
	readonly registrations: CursorProviderConfig[];
	readonly registry: ModelRegistry;
} {
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	const registrations: CursorProviderConfig[] = [];
	return {
		registry,
		registrations,
		host: {
			registerProvider(name, config) {
				registry.registerProvider(name, {
					...config,
					models: [...config.models] as unknown as NonNullable<ProviderConfigInput["models"]>,
				}, trustedCursorProviderSource());
				registrations.push(config);
			},
			on() {},
		},
	};
}

test("provider refresh keeps a selected duplicate occurrence while using its current wire metadata", async () => {
	const access = token("duplicate-refresh");
	const discovery = new QueueDiscoveryService([
		{
			source: "live",
			fetchedAt: 1,
			models: [
				{ id: "old-before", maxMode: false },
				{ id: "duplicate-route", displayName: "First old", maxMode: false },
				{ id: "old-between", maxMode: true },
				{ id: "duplicate-route", displayName: "Second old", maxMode: true, supportsImages: true },
			],
		},
		{
			source: "live",
			fetchedAt: 2,
			models: [
				{ id: "current-before", maxMode: true },
				{ id: "duplicate-route", displayName: "First current", maxMode: true, supportsImages: true },
				{ id: "current-between-a", maxMode: false },
				{ id: "current-between-b", maxMode: true },
				{ id: "duplicate-route", displayName: "Second current", maxMode: false },
			],
		},
	]);
	const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
	const harness = registryHost();
	const runtime = registerCursorProvider(harness.host, {
		authService: new QueueAuthService([access, access]),
		discoveryService: discovery,
		transport,
		now: () => 2,
	});

	await harness.registrations[0]!.oauth.login(callbacks);
	const originalRows = harness.registry.getAll().filter((model) => model.provider === "cursor" && model.id === "duplicate-route");
	assert.deepEqual(originalRows.map((model) => model.name), ["First old", "Second old"]);
	const selectedLaterOccurrence = originalRows[1]!;

	await harness.registrations.at(-1)!.oauth.login(callbacks);
	const currentRows = harness.registry.getAll().filter((model) => model.provider === "cursor" && model.id === "duplicate-route");
	assert.deepEqual(currentRows.map((model) => model.name), ["First current", "Second current"]);
	const currentLaterOccurrence = currentRows[1]!;
	const textualFirstOccurrence = harness.registry.find("cursor", "duplicate-route")!;
	const config = harness.registrations.at(-1)!;
	await collectEvents(config.streamSimple(textualFirstOccurrence, imageContext, { apiKey: access }));
	const staleEvents = await collectEvents(config.streamSimple(selectedLaterOccurrence, context, { apiKey: access }));
	assert.equal(staleEvents.at(-1)?.type, "error");
	await collectEvents(config.streamSimple(currentLaterOccurrence, context, { apiKey: access }));
	const unsupportedImageEvents = await collectEvents(config.streamSimple(currentLaterOccurrence, imageContext, { apiKey: access }));
	assert.equal(unsupportedImageEvents.at(-1)?.type, "error");
	assert.equal(transport.runs.length, 2);

	const codec = new CursorProtobufProtocolCodec();
	const wire = transport.runs.map(({ request }) => {
		const clientFields = cursorProtoTest.readFields(codec.encodeRunRequest(request));
		const runFields = cursorProtoTest.readFields(bytesField(clientFields, 1));
		const modelDetails = cursorProtoTest.readFields(bytesField(runFields, 3));
		const requestedModel = cursorProtoTest.readFields(bytesField(runFields, 9));
		return [
			stringField(modelDetails, 1),
			boolField(modelDetails, 7),
			stringField(requestedModel, 1),
			boolField(requestedModel, 2),
			requestedModel.some((field) => field.fieldNumber === 3),
		] as const;
	});
	assert.deepEqual(wire, [
		["duplicate-route", true, "duplicate-route", true, false],
		["duplicate-route", false, "duplicate-route", false, false],
	]);
	await runtime.dispose();
});
