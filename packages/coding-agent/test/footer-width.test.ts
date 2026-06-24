import { sep } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, UsageMeterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
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
	contextPercent?: number;
	contextWindow?: number;
}): AgentSession {
	const usage = options.usage;
	const entries =
		usage === undefined
			? []
			: [
					{
						type: "message",
						message: {
							role: "assistant",
							usage,
						},
					},
				];

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
		modelRegistry: {
			isUsingOAuth: () => false,
		},
		settingsManager: {
			getCodexFastModeSettings: () => ({ chat: false, workflow: false }),
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
		const session = createSession({
			sessionName: "",
			contextPercent: 101.2,
			contextWindow: 200_000,
		});
		const usageMeter = new UsageMeterComponent(session);

		const [line] = usageMeter.render(120);

		expect(line).toContain(theme.fg("warning", "101.2%/200k (auto)"));
		expect(line).not.toContain(theme.fg("error", "101.2%/200k (auto)"));
	});

	it("renders near-limit auto-compacted context usage as a warning", () => {
		const session = createSession({
			sessionName: "",
			contextPercent: 95.4,
			contextWindow: 200_000,
		});
		const usageMeter = new UsageMeterComponent(session);

		const [line] = usageMeter.render(120);

		expect(line).toContain(theme.fg("warning", "95.4%/200k (auto)"));
		expect(line).not.toContain(theme.fg("error", "95.4%/200k (auto)"));
	});

	it("keeps over-limit context usage red when auto-compaction is disabled", () => {
		const session = createSession({
			sessionName: "",
			contextPercent: 101.2,
			contextWindow: 200_000,
		});
		const usageMeter = new UsageMeterComponent(session);
		usageMeter.setAutoCompactEnabled(false);

		const [line] = usageMeter.render(120);

		expect(line).toContain(theme.fg("error", "101.2%/200k"));
		expect(line).not.toContain(theme.fg("warning", "101.2%/200k"));
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

		const statsText = stripAnsi(usageMeter.render(120).join("\n"));
		expect(statsText).toContain("CH25.0%");
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
});
