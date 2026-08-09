import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

const INDIVIDUAL_ENDPOINT = "https://api.individual.githubcopilot.com";
const ENTERPRISE_ENDPOINT = "https://api.enterprise.githubcopilot.com";
const SUPPRESSION_HEADERS: ProviderHeaders = { Authorization: null, "x-copilot": "enterprise" };

type CapturedRequest = {
	baseUrl: string | undefined;
	headers: ProviderHeaders | undefined;
};

function expectCredentialRequests(requests: readonly CapturedRequest[]): void {
	expect(requests).not.toHaveLength(0);
	for (const request of requests) {
		expect(request.baseUrl).toBe(ENTERPRISE_ENDPOINT);
		expect(request.headers).toEqual(SUPPRESSION_HEADERS);
	}
}

function assistantMessage(model: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function completedStream(model: Model<Api>, text: string) {
	const stream = createAssistantMessageEventStream();
	stream.end(assistantMessage(model, text));
	return stream;
}

function installCopilotCredential(harness: Harness): Model<Api> {
	const catalogModel = { ...harness.getModel(), provider: "github-copilot", baseUrl: INDIVIDUAL_ENDPOINT };
	harness.session.agent.state.model = catalogModel;
	vi.spyOn(harness.session.modelRuntime, "getAuth").mockResolvedValue({
		auth: {
			apiKey: "copilot-token",
			baseUrl: ENTERPRISE_ENDPOINT,
			headers: SUPPRESSION_HEADERS,
		},
	});
	return catalogModel;
}

function seedCompactableSession(harness: Harness): void {
	harness.sessionManager.appendMessage({
		role: "user",
		content: [
			{ type: "text", text: Array.from({ length: 40 }, (_value, index) => `context line ${index}`).join("\n") },
		],
		timestamp: Date.now(),
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("GitHub Copilot credential endpoints in summaries", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	it("uses the credential-resolved endpoint for Verbatim Compaction", async () => {
		harness = await createHarness();
		installCopilotCredential(harness);
		seedCompactableSession(harness);
		const requests: CapturedRequest[] = [];
		harness.session.agent.streamFunction = async (requestModel, _context, options) => {
			requests.push({ baseUrl: requestModel.baseUrl, headers: options?.headers });
			return completedStream(requestModel, "1,20\n");
		};

		await harness.session.compact({ preserve_recent: 0 });

		expectCredentialRequests(requests);
	});

	it("uses the credential-resolved endpoint for branch summaries", async () => {
		harness = await createHarness();
		const catalogModel = installCopilotCredential(harness);
		const rootId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Explore the alternate Copilot branch." }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage(assistantMessage(catalogModel, "Alternate branch response."));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const requests: CapturedRequest[] = [];
		harness.session.agent.streamFunction = async (requestModel, _context, options) => {
			requests.push({ baseUrl: requestModel.baseUrl, headers: options?.headers });
			return completedStream(requestModel, "Enterprise branch summary.");
		};

		const result = await harness.session.navigateTree(rootId, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.summaryEntry?.summary).toContain("Enterprise branch summary.");
		expectCredentialRequests(requests);
	});
});
