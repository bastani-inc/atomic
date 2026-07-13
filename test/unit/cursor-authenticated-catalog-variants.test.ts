import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Model, ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai/compat";
import {
	mapCursorCatalogToProviderModels,
	resolveCursorModelVariant,
	type CursorModelRouting,
} from "../../packages/cursor/src/model-mapper.js";
import { CursorStreamAdapter } from "../../packages/cursor/src/stream.js";
import { authenticatedVariantCorrectionModels } from "./cursor-authenticated-catalog-fixture.js";
import { collectEvents, context } from "./cursor-stream-helpers.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const EXPECTED_ROWS = [
	["claude-fable-5-1m-max", "Fable 5 (1M, Max)"],
	["claude-fable-5-1m-max-thinking", "Fable 5 (1M, Max, Thinking)"],
	["claude-fable-5-300k", "Fable 5 (300K)"],
	["claude-fable-5-300k-thinking", "Fable 5 (300K, Thinking)"],
	["claude-opus-4-8-1m-max", "Opus 4.8 (1M, Max)"],
	["claude-opus-4-8-1m-max-fast", "Opus 4.8 (1M, Max, Fast)"],
	["claude-opus-4-8-1m-max-thinking", "Opus 4.8 (1M, Max, Thinking)"],
	["claude-opus-4-8-1m-max-thinking-fast", "Opus 4.8 (1M, Max, Thinking, Fast)"],
	["claude-opus-4-8-300k", "Opus 4.8 (300K)"],
	["claude-opus-4-8-300k-max-fast", "Opus 4.8 (300K, Max, Fast)"],
	["claude-opus-4-8-300k-max-thinking-fast", "Opus 4.8 (300K, Max, Thinking, Fast)"],
	["claude-opus-4-8-300k-thinking", "Opus 4.8 (300K, Thinking)"],
	["claude-sonnet-5-1m-max", "Sonnet 5 (1M, Max)"],
	["claude-sonnet-5-1m-max-thinking", "Sonnet 5 (1M, Max, Thinking)"],
	["claude-sonnet-5-300k", "Sonnet 5 (300K)"],
	["claude-sonnet-5-300k-thinking", "Sonnet 5 (300K, Thinking)"],
	["composer-2.5", "Composer 2.5"],
	["composer-2.5-fast", "Composer 2.5 (Fast)"],
	["gpt-5.1", "GPT-5.1"],
	["gpt-5.6-sol-1m-max", "GPT-5.6 Sol (1M, Max)"],
	["gpt-5.6-sol-272k", "GPT-5.6 Sol (272K)"],
	["gpt-5.6-sol-272k-fast", "GPT-5.6 Sol (272K, Fast)"],
] as const;

function tupleKey(route: CursorModelRouting): string {
	return JSON.stringify([route.modelId, route.maxMode ?? null, route.parameters ?? []]);
}

function advertisedTupleKeys(): Set<string> {
	return new Set(authenticatedVariantCorrectionModels().flatMap((model) => (model.variants ?? []).map((variant) => tupleKey({
		modelId: model.serverModelName ?? model.id,
		maxMode: variant.isMaxMode,
		parameters: variant.parameters,
	}))));
}

function mappedModels() {
	return mapCursorCatalogToProviderModels({
		source: "live",
		fetchedAt: 1,
		models: authenticatedVariantCorrectionModels(),
	});
}

test("authenticated raw names map to exact concise rows without collisions", () => {
	const mapped = mappedModels();
	assert.deepEqual(mapped.map(({ id, name }) => [id, name]), EXPECTED_ROWS);
	assert.equal(new Set(mapped.map(({ id }) => id)).size, mapped.length);
	assert.equal(mapped.some(({ id }) => /context-|max-mode|-(?:none|low|medium|high|xhigh)(?:-|$)/u.test(id)), false);
});

test("reasoning cycles expose every and only advertised effort", () => {
	for (const model of mappedModels()) {
		const routes = model.compat?.cursorRouting ?? {};
		const supported = THINKING_LEVELS.filter((level) => typeof model.thinkingLevelMap?.[level] === "string");
		const rawEfforts = new Set(Object.values(routes).map((route) => route.parameters
			?.find(({ id }) => id === "effort" || id === "reasoning")?.value).filter((value): value is string => value !== undefined));
		const selectedEfforts = new Set(supported.map((level) => routes[model.thinkingLevelMap![level] as string]?.parameters
			?.find(({ id }) => id === "effort" || id === "reasoning")?.value).filter((value): value is string => value !== undefined));
		assert.deepEqual(selectedEfforts, rawEfforts, model.id);
		if (rawEfforts.has("none")) {
			const offRouteId = model.thinkingLevelMap?.off;
			assert.equal(typeof offRouteId, "string", model.id);
			assert.equal(routes[offRouteId as string]?.parameters?.some(({ id, value }) => id === "reasoning" && value === "none"), true, model.id);
		}
	}
});

test("bare selection preserves Cursor default separately from explicit reasoning", () => {
	for (const model of mappedModels()) {
		const routes = model.compat?.cursorRouting ?? {};
		assert.equal(resolveCursorModelVariant(model.id, model.thinkingLevelMap, undefined, true), model.id);
		assert.ok(routes[model.id], model.id);
	}
});

test("all public row and reasoning routes forward exact complete advertised tuples", async () => {
	const advertised = advertisedTupleKeys();
	const reached = new Set<string>();
	for (const definition of mappedModels()) {
		const model = { ...definition, provider: "cursor" } as Model<Api>;
		const selections: ReadonlyArray<{ readonly reasoning?: ThinkingLevel; readonly useProviderDefault: boolean; readonly label: string }> = [
			{ useProviderDefault: true, label: "default" },
			...THINKING_LEVELS
				.filter((level) => typeof model.thinkingLevelMap?.[level] === "string")
				.map((level) => ({
					...(level === "off" ? {} : { reasoning: level }),
					useProviderDefault: false,
					label: level,
				})),
		];
		const resolvedIds = new Set<string>();
		for (const [index, selection] of selections.entries()) {
			const resolvedId = resolveCursorModelVariant(model.id, model.thinkingLevelMap, selection.reasoning, selection.useProviderDefault);
			if (resolvedIds.has(resolvedId)) continue;
			resolvedIds.add(resolvedId);
			const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
			const adapter = new CursorStreamAdapter({ transport, uuid: () => `${model.id}-${index}` });
			const options = selection.useProviderDefault
				? { apiKey: "access-secret" }
				: { apiKey: "access-secret", reasoning: selection.reasoning };
			await collectEvents(adapter.streamSimple(model, context(), options));
			const request = transport.runs[0]?.request;
			assert.ok(request, model.id);
			assert.ok(request.requestedModelId, model.id);
			const key = tupleKey({
				modelId: request.requestedModelId,
				maxMode: request.requestedMaxMode,
				parameters: request.modelParameters,
			});
			assert.ok(advertised.has(key), `${model.id}:${selection.label}`);
			reached.add(key);
		}
	}
	assert.deepEqual(reached, advertised);
});
