import { sep } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession, SessionStats } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import {
	FooterComponent,
	formatCwdForFooter,
	UsageMeterComponent,
} from "../src/modes/interactive/components/footer.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	contextPercent?: number;
	contextWindow?: number;
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: options.contextWindow ?? 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({
			contextWindow: options.contextWindow ?? 200_000,
			percent: options.contextPercent ?? 12.3,
		}),
		modelRuntime: {
			isUsingOAuth: () => false,
		},
		settingsManager: {
			getCodexFastModeSettings: () => ({ enabled: false }),
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe(`~${sep}project`);
	});
});

describe("UsageMeterComponent context color", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("renders over-limit auto-compacted context usage as a warning", () => {
		const usageMeter = new UsageMeterComponent(
			createSession({ sessionName: "", contextPercent: 101.2, contextWindow: 200_000 }),
		);

		const [line] = usageMeter.render(120);
		expect(line).toContain(theme.fg("warning", "101.2%/200k (auto)"));
		expect(line).not.toContain(theme.fg("error", "101.2%/200k (auto)"));
	});

	it("renders near-limit auto-compacted context usage as a warning", () => {
		const usageMeter = new UsageMeterComponent(
			createSession({ sessionName: "", contextPercent: 95.4, contextWindow: 200_000 }),
		);

		const [line] = usageMeter.render(120);
		expect(line).toContain(theme.fg("warning", "95.4%/200k (auto)"));
		expect(line).not.toContain(theme.fg("error", "95.4%/200k (auto)"));
	});

	it("keeps over-limit context usage red when auto-compaction is disabled", () => {
		const usageMeter = new UsageMeterComponent(
			createSession({ sessionName: "", contextPercent: 101.2, contextWindow: 200_000 }),
		);
		usageMeter.setAutoCompactEnabled(false);

		const [line] = usageMeter.render(120);
		expect(line).toContain(theme.fg("error", "101.2%/200k"));
		expect(line).not.toContain(theme.fg("warning", "101.2%/200k"));
	});

	it("renders RPC session stats for adapter-backed stages", () => {
		const stats: SessionStats = {
			sessionFile: "/tmp/remote-session.jsonl",
			sessionId: "remote-session",
			userMessages: 2,
			assistantMessages: 2,
			toolCalls: 1,
			toolResults: 1,
			totalMessages: 6,
			tokens: { input: 12_000, output: 3_000, cacheRead: 8_000, cacheWrite: 500, total: 23_500 },
			cost: 0.012,
			contextUsage: { tokens: 95_000, contextWindow: 131_072, percent: 72.5 },
		};

		const line = stripAnsi(new UsageMeterComponent(stats).render(120)[0]);
		expect(line).toContain("↑12k");
		expect(line).toContain("↓3.0k");
		expect(line).toContain("CH39.0%");
		expect(line).toContain("72.5%/131k (auto)");
	});
});
describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("includes branch summary and tool result usage in the total cost", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
			branchUsage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
			compactionUsage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
			toolUsage: {
				input: 15,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.375 },
			},
		});
		const usageMeter = new UsageMeterComponent(session);

		const statsLine = usageMeter.render(120).map(stripAnsi).join("\n");
		expect(statsLine).toContain("$1.125");
	});

	it("shows the latest cache hit rate when cache usage is present", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const usageMeter = new UsageMeterComponent(session);

		const statsLine = usageMeter.render(120).map(stripAnsi).join("\n");
		expect(statsLine).toContain("CH25.0%");
	});

	it("marks Kimi Coding costs as subscription estimates", () => {
		const session = createSession({
			sessionName: "",
			provider: "kimi-coding",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const usageMeter = new UsageMeterComponent(session);

		expect(usageMeter.render(120).map(stripAnsi).join("\n")).toContain("$1.234 (sub)");
	});
});
