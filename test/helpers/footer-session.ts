import type { AgentSession } from "@bastani/atomic";

export function fakeFooterAgentSession(isStreaming = false): AgentSession {
	const state = {
		model: {
			id: "gpt-5.5",
			provider: "openai-codex",
			reasoning: true,
			contextWindow: 200000,
		},
		thinkingLevel: "high",
	};
	return {
		state,
		get model() {
			return state.model;
		},
		sessionManager: {
			getCwd: () => "/workspace/project",
			getSessionId: () => "footer-session",
			getLeafId: () => "footer-message",
			getEntryCount() {
				return this.getEntries().length;
			},
			getEntries: () => [
				{
					type: "message",
					message: {
						role: "assistant",
						usage: {
							input: 1200,
							output: 3400,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 4600,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0.123,
							},
						},
					},
				},
			],
		},
		modelRuntime: {
			isUsingOAuth: () => false,
		},
		getContextUsage: () => ({
			tokens: 46800,
			contextWindow: 200000,
			percent: 23.4,
		}),
		isStreaming,
	} as unknown as AgentSession;
}
