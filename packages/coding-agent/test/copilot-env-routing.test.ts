import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
	type CopilotRoutingEnv,
	resolveCopilotEnvBaseUrl,
	withCopilotEnvBaseUrl,
} from "../src/core/copilot-env-routing.ts";

const INDIVIDUAL = "https://api.individual.githubcopilot.com";
const PUBLIC_HUB = "https://api.githubcopilot.com";
const ENTERPRISE = "https://api.enterprise.githubcopilot.com";

const businessToken = "tid=abc;exp=123;proxy-ep=proxy.business.githubcopilot.com;st=dotcom";
const plainToken = "github_pat_enterprise";

function copilotProvider(models: readonly Model<Api>[] = []): Provider {
	return {
		id: "github-copilot",
		name: "GitHub Copilot",
		baseUrl: INDIVIDUAL,
		auth: {},
		getModels: () => models,
	} as unknown as Provider;
}

function copilotModel(id: string): Model<Api> {
	return { id, provider: "github-copilot", api: "openai-completions", baseUrl: INDIVIDUAL } as Model<Api>;
}

function env(values: CopilotRoutingEnv): CopilotRoutingEnv {
	return values;
}

describe("resolveCopilotEnvBaseUrl precedence", () => {
	test("COPILOT_API_TARGET wins over every other signal", () => {
		const resolved = resolveCopilotEnvBaseUrl(
			env({
				COPILOT_API_TARGET: "copilot.internal.example.com",
				GITHUB_COPILOT_BASE_URL: "https://ignored.example.com",
				COPILOT_GITHUB_TOKEN: businessToken,
				GITHUB_SERVER_URL: "https://octocorp.ghe.com",
			}),
			"octocorp.ghe.com",
		);
		expect(resolved).toBe("https://copilot.internal.example.com");
	});

	test("GITHUB_COPILOT_BASE_URL applies when COPILOT_API_TARGET is unset", () => {
		const resolved = resolveCopilotEnvBaseUrl(
			env({ GITHUB_COPILOT_BASE_URL: "https://copilot-proxy.example.com/", COPILOT_GITHUB_TOKEN: businessToken }),
		);
		expect(resolved).toBe("https://copilot-proxy.example.com");
	});

	test("token proxy-ep beats GITHUB_SERVER_URL and the public hub", () => {
		const resolved = resolveCopilotEnvBaseUrl(
			env({ COPILOT_GITHUB_TOKEN: businessToken, GITHUB_SERVER_URL: "https://ghe.example.com" }),
		);
		expect(resolved).toBe("https://api.business.githubcopilot.com");
	});

	test("explicit enterpriseDomain applies when the token carries no proxy-ep", () => {
		const resolved = resolveCopilotEnvBaseUrl(env({ COPILOT_GITHUB_TOKEN: plainToken }), "octocorp.ghe.com");
		expect(resolved).toBe("https://copilot-api.octocorp.ghe.com");
	});

	test("GITHUB_SERVER_URL on ghe.com routes to the tenant Copilot host", () => {
		const resolved = resolveCopilotEnvBaseUrl(
			env({ COPILOT_GITHUB_TOKEN: plainToken, GITHUB_SERVER_URL: "https://octocorp.ghe.com" }),
		);
		expect(resolved).toBe("https://copilot-api.octocorp.ghe.com");
	});

	test("GITHUB_SERVER_URL on a self-hosted host routes to the enterprise CAPI host", () => {
		const resolved = resolveCopilotEnvBaseUrl(
			env({ COPILOT_GITHUB_TOKEN: plainToken, GITHUB_SERVER_URL: "https://github.acme-internal.net" }),
		);
		expect(resolved).toBe(ENTERPRISE);
	});

	test("GITHUB_SERVER_URL of github.com falls through to the public hub", () => {
		const resolved = resolveCopilotEnvBaseUrl(
			env({ COPILOT_GITHUB_TOKEN: plainToken, GITHUB_SERVER_URL: "https://github.com" }),
		);
		expect(resolved).toBe(PUBLIC_HUB);
	});

	test("a bare env token routes to the public hub, never the individual host", () => {
		expect(resolveCopilotEnvBaseUrl(env({ COPILOT_GITHUB_TOKEN: plainToken }))).toBe(PUBLIC_HUB);
	});

	test("no routing signal at all leaves pi's default untouched", () => {
		expect(resolveCopilotEnvBaseUrl(env({}))).toBeUndefined();
	});

	// The resolver is pure precedence: GITHUB_SERVER_URL resolves on its own, and
	// withCopilotEnvBaseUrl is what restricts routing to the env-token auth path.
	test("GITHUB_SERVER_URL resolves without a token; the wrapper applies the auth gate", () => {
		expect(resolveCopilotEnvBaseUrl(env({ GITHUB_SERVER_URL: "https://octocorp.ghe.com" }))).toBe(
			"https://copilot-api.octocorp.ghe.com",
		);
	});
});

describe("withCopilotEnvBaseUrl", () => {
	test("rewrites the provider and every model base URL for env-token auth", () => {
		const provider = withCopilotEnvBaseUrl(
			copilotProvider([copilotModel("gpt-5.5"), copilotModel("claude-opus-5")]),
			env({ COPILOT_GITHUB_TOKEN: businessToken }),
		);
		expect(provider.baseUrl).toBe("https://api.business.githubcopilot.com");
		for (const model of provider.getModels()) {
			expect(model.baseUrl).toBe("https://api.business.githubcopilot.com");
		}
	});

	test("leaves the provider untouched without an env token (OAuth path)", () => {
		const base = copilotProvider([copilotModel("gpt-5.5")]);
		const provider = withCopilotEnvBaseUrl(base, env({ GITHUB_SERVER_URL: "https://octocorp.ghe.com" }));
		expect(provider).toBe(base);
		expect(provider.baseUrl).toBe(INDIVIDUAL);
	});

	test("leaves non-Copilot providers untouched", () => {
		const anthropic = { ...copilotProvider(), id: "anthropic" } as Provider;
		expect(withCopilotEnvBaseUrl(anthropic, env({ COPILOT_GITHUB_TOKEN: businessToken }))).toBe(anthropic);
	});

	test("routes models added by a later dynamic refresh", () => {
		const models: Model<Api>[] = [copilotModel("gpt-5.5")];
		const base = { ...copilotProvider(), getModels: () => models } as Provider;
		const provider = withCopilotEnvBaseUrl(base, env({ COPILOT_GITHUB_TOKEN: plainToken }));
		models.push(copilotModel("gemini-3-pro"));
		expect(provider.getModels()).toHaveLength(2);
		for (const model of provider.getModels()) expect(model.baseUrl).toBe(PUBLIC_HUB);
	});
});
