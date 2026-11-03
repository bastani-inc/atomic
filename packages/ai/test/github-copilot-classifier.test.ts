import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.js";
import { builtinModels } from "../src/providers/all.js";
import { parseGitHubCopilotDiscoveredModels } from "../src/providers/github-copilot.js";

describe("GitHub Copilot classifier", () => {
	for (const oauth of [false, true]) {
		it(`classifies through the ${oauth ? "OAuth account" : "API key"} System One endpoint`, async () => {
			const credentials = new InMemoryCredentialStore();
			if (oauth) {
				await credentials.modify("github-copilot", async () => ({
					type: "oauth",
					access: "tid=test;exp=9999999999;proxy-ep=proxy.enterprise.githubcopilot.com;",
					refresh: "refresh",
					expires: Date.now() + 3_600_000,
					availableModelIds: ["example-chat-model"],
				}));
			}
			const models = builtinModels({ credentials });
			if (!oauth) await credentials.modify("github-copilot", async () => ({ type: "api_key", key: "secret" }));
			const model = models.getModelOfType("classifier", "github-copilot", "microsoft-decision-1");
			assert.ok(model);
			assert.equal(model.contextWindow, 32768);
			assert.equal(model.cost.input, 0.042);
			assert.deepEqual(await models.getAvailableOfType("classifier", "github-copilot"), [model]);
			const urls: string[] = [];
			const result = await models.classify(
				model,
				{
					state: { text: "yes" },
					questions: {
						approved: { type: "bool", instructions: "Approval?", criteria: { true: "Yes", false: "No" } },
					},
				},
				{
					...(oauth ? {} : { apiKey: "secret" }),
					fetch: async (input, init) => {
						urls.push(String(input));
						const headers = new Headers(init?.headers);
						assert.ok(headers.get("editor-version"));
						assert.equal(headers.get("copilot-integration-id"), "vscode-chat");
						return Response.json({ answers: { approved: { type: "noul", noul: 0.8 } } });
					},
				},
			);
			assert.deepEqual(urls, [`https://api.${oauth ? "enterprise" : "individual"}.githubcopilot.com/v1/systemone`]);
			assert.deepEqual(result.answers.approved, { type: "bool", probability: 0.8 });
		});
	}

	it("keeps the static classifier out of remote chat discovery", () => {
		const models = builtinModels();
		const classifier = models.getModelOfType("classifier", "github-copilot", "microsoft-decision-1");
		assert.ok(classifier);
		const discovered = parseGitHubCopilotDiscoveredModels(
			{
				data: [
					{
						id: classifier.id,
						capabilities: { type: "chat", supports: { tool_calls: true } },
					},
				],
			},
			[classifier],
		);
		assert.deepEqual(discovered, []);
	});
});
