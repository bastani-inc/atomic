import type { Static } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, expectTypeOf, it } from "vitest";
import { getModels, getProviders } from "../src/compat.ts";
import {
	AnthropicMessagesCompatSchema,
	BedrockCompatSchema,
	MistralConversationsCompatSchema,
	OpenAICompletionsCompatSchema,
	OpenAIResponsesCompatSchema,
	ProviderCompatSchema,
} from "../src/providers/compat-schema.ts";

type ProviderCompat = Static<typeof ProviderCompatSchema>;

describe("compatibility schemas", () => {
	it("preserves property types in the provider superset", () => {
		expectTypeOf<ProviderCompat["supportsStore"]>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<ProviderCompat["sessionAffinityFormat"]>().toEqualTypeOf<
			"openai" | "openai-nosession" | "openrouter" | undefined
		>();
	});

	it("preserves API-specific defaults", () => {
		const completionsDefaults = Compile(OpenAICompletionsCompatSchema).Default({});
		expect(completionsDefaults).not.toHaveProperty("thinkingFormat");
		expect(completionsDefaults).not.toHaveProperty("supportsLongCacheRetention");
		expect(Compile(OpenAIResponsesCompatSchema).Default({})).toMatchObject({ supportsDeveloperRole: true });
		const anthropicDefaults = Compile(AnthropicMessagesCompatSchema).Default({});
		expect(anthropicDefaults).not.toHaveProperty("sendSessionAffinityHeaders");
		expect(anthropicDefaults).toMatchObject({ supportsLongCacheRetention: true });
		expect(Compile(BedrockCompatSchema).Default({})).toMatchObject({ supportsStrictMode: false });
	});

	it("does not assign API-specific defaults to the provider superset", () => {
		const defaults = Compile(ProviderCompatSchema).Default({});
		expect(defaults).not.toHaveProperty("supportsDeveloperRole");
		expect(defaults).not.toHaveProperty("sendSessionAffinityHeaders");
		expect(defaults).not.toHaveProperty("supportsLongCacheRetention");
		expect(defaults).not.toHaveProperty("supportsStrictMode");
	});

	it("describes Atomic's compatibility fields in the API schemas and the provider superset", () => {
		const atomicFields = [
			[OpenAICompletionsCompatSchema, ["supportsTemperature", "supportsForcedToolChoice"]],
			[
				AnthropicMessagesCompatSchema,
				["supportsForcedToolChoice", "enforcesPreservedThinkingBinding", "delegatesThinkingModelBinding"],
			],
			[BedrockCompatSchema, ["supportsForcedToolChoice", "supportsTemperature"]],
		] as const;
		for (const [schema, fields] of atomicFields) {
			for (const field of fields) {
				expect(schema.properties, field).toHaveProperty(field);
				expect(ProviderCompatSchema.properties, field).toHaveProperty(field);
			}
		}
		expectTypeOf<ProviderCompat["supportsForcedToolChoice"]>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<ProviderCompat["delegatesThinkingModelBinding"]>().toEqualTypeOf<boolean | undefined>();
	});

	it("declares every compatibility field the built-in model catalog sets", () => {
		const declared = new Set<string>(Object.keys(ProviderCompatSchema.properties));
		const undeclared = new Map<string, string>();
		for (const provider of getProviders()) {
			for (const model of getModels(provider)) {
				for (const field of Object.keys(model.compat ?? {})) {
					if (!declared.has(field)) undeclared.set(field, `${provider}/${model.id}`);
				}
			}
		}
		expect(Object.fromEntries(undeclared)).toEqual({});
	});

	it("keeps each API schema's properties inside the provider superset", () => {
		const apiSchemas = [
			OpenAICompletionsCompatSchema,
			OpenAIResponsesCompatSchema,
			AnthropicMessagesCompatSchema,
			BedrockCompatSchema,
			MistralConversationsCompatSchema,
		];
		for (const schema of apiSchemas) {
			for (const field of Object.keys(schema.properties)) {
				expect(ProviderCompatSchema.properties, field).toHaveProperty(field);
			}
		}
	});
});
