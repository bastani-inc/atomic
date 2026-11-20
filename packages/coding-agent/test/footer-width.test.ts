import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage, FileAuthStorageBackend } from "../src/core/auth-storage.js";
import { setDebugSetting } from "../src/core/debug-setting.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import {
	FooterComponent,
	formatCwdForFooter,
	UsageMeterComponent,
} from "../src/modes/interactive/components/footer.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	cwd?: string;
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
		get model() {
			return this.state.model;
		},
		sessionManager: {
			getEntries: () => entries,
			getEntryCount: () => entries.length,
			getSessionId: () => "test",
			getLeafId: () => "leaf",
			getSessionName: () => options.sessionName,
			getCwd: () => options.cwd ?? "/tmp/project",
		},
		getContextUsage: () => ({
			contextWindow: options.contextWindow ?? 200_000,
			percent: options.contextPercent ?? 12.3,
		}),
		modelRuntime: {
			isUsingOAuth: () => false,
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

	it("renders subscription usage without synchronous credential file checks (#5516)", async () => {
		const directory = fs.mkdtempSync(join(tmpdir(), "footer-auth-"));
		try {
			const credentials = AuthStorage.create(join(directory, "auth.json"));
			await credentials.modify("anthropic", async () => ({
				type: "oauth",
				access: "fixture-access",
				refresh: "fixture-refresh",
				expires: Number.MAX_SAFE_INTEGER,
			}));
			const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
			await runtime.getAvailable();
			const session = createSession({ sessionName: "", provider: "anthropic" });
			Object.assign(session, { modelRuntime: runtime });
			const usageMeter = new UsageMeterComponent(session);
			const version = vi.spyOn(FileAuthStorageBackend.prototype, "version");
			const stat = vi.spyOn(fs, "statSync");
			const read = vi.spyOn(fs, "readFileSync");
			syncBuiltinESMExports();
			try {
				const rendered = usageMeter.render(120).map(stripAnsi).join("\n");
				assert.match(rendered, /sub/);
				assert.equal(version.mock.calls.length, 0, "drawing must not check credential files synchronously");
				assert.equal(stat.mock.calls.length, 0, "drawing must not stat credential files");
				assert.equal(read.mock.calls.length, 0, "drawing must not read credential files");
			} finally {
				version.mockRestore();
				stat.mockRestore();
				read.mockRestore();
				syncBuiltinESMExports();
			}
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it("renders over-limit auto-compacted context usage as a warning", () => {
		const usageMeter = new UsageMeterComponent(
			createSession({ sessionName: "", contextPercent: 101.2, contextWindow: 200_000 }),
		);

		const [line] = usageMeter.render(120);
		expect(line).toContain(theme.fg("warning", "101.2%/200.0k (auto)"));
		expect(line).not.toContain(theme.fg("error", "101.2%/200.0k (auto)"));
	});

	it("renders near-limit auto-compacted context usage as a warning", () => {
		const usageMeter = new UsageMeterComponent(
			createSession({ sessionName: "", contextPercent: 95.4, contextWindow: 200_000 }),
		);

		const [line] = usageMeter.render(120);
		expect(line).toContain(theme.fg("warning", "95.4%/200.0k (auto)"));
		expect(line).not.toContain(theme.fg("error", "95.4%/200.0k (auto)"));
	});

	it("keeps over-limit context usage red when auto-compaction is disabled", () => {
		const usageMeter = new UsageMeterComponent(
			createSession({ sessionName: "", contextPercent: 101.2, contextWindow: 200_000 }),
		);
		usageMeter.setAutoCompactEnabled(false);

		const [line] = usageMeter.render(120);
		expect(line).toContain(theme.fg("error", "101.2%/200.0k"));
		expect(line).not.toContain(theme.fg("warning", "101.2%/200.0k"));
	});
});

describe("UsageMeterComponent on a narrow terminal", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	const meter = () =>
		new UsageMeterComponent(
			createSession({
				sessionName: "",
				contextPercent: 45.2,
				contextWindow: 200_000,
				usage: {
					input: 1_234_567,
					output: 45_678,
					cacheRead: 12_345_678,
					cacheWrite: 234_567,
					cost: { total: 12.345 },
				},
			}),
		);
	const line = (width: number) => stripAnsi(meter().render(width)[0] ?? "").trim();

	it("writes every token count with one decimal and its unit", () => {
		assert.equal(line(100), "↑1.2M • ↓45.7k • R12.3M • W234.6k • CH89.4% • $12.345 • 45.2%/200.0k (auto)");
	});

	it("drops cache write, cache read, hit rate, cost, input and output before it cuts the context usage", () => {
		const shown = [
			"↑1.2M • ↓45.7k • R12.3M • W234.6k • CH89.4% • $12.345 • 45.2%/200.0k (auto)",
			"↑1.2M • ↓45.7k • R12.3M • CH89.4% • $12.345 • 45.2%/200.0k (auto)",
			"↑1.2M • ↓45.7k • CH89.4% • $12.345 • 45.2%/200.0k (auto)",
			"↑1.2M • ↓45.7k • $12.345 • 45.2%/200.0k (auto)",
			"↑1.2M • ↓45.7k • 45.2%/200.0k (auto)",
			"↓45.7k • 45.2%/200.0k (auto)",
			"45.2%/200.0k (auto)",
		];
		for (const expected of shown) assert.equal(line(visibleWidth(expected)), expected);
		for (const [index, expected] of shown.slice(1).entries())
			assert.equal(line(visibleWidth(shown[index]!) - 1), expected, `one column narrower than ${shown[index]}`);
	});

	it("keeps the context usage whole at every width it fits in, and its percentage down to the cut", () => {
		const context = "45.2%/200.0k (auto)";
		for (let width = visibleWidth(context); width <= 120; width++) {
			assert.ok(line(width).endsWith(context), `${width}: ${line(width)}`);
			assert.ok(visibleWidth(meter().render(width)[0] ?? "") <= width, `${width}`);
		}
		for (let width = visibleWidth("45.2%..."); width < visibleWidth(context); width++)
			assert.ok(line(width).startsWith("45.2%"), `${width}: ${line(width)}`);
	});
});
describe("FooterComponent model label", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	const statusLine = (providerCount: number, model: Parameters<typeof createSession>[0]): string =>
		stripAnsi(new FooterComponent(createSession(model), createFooterData(providerCount)).render(200)[0] ?? "");
	const sonnet = { sessionName: "", provider: "anthropic", modelId: "claude-sonnet-4-5", reasoning: true };

	it("shows the raw model ID and its level, as provider/id when several providers are configured (#4269)", () => {
		assert.match(statusLine(1, { ...sonnet, thinkingLevel: "high" }), /^claude-sonnet-4-5 {2}high • /);
		assert.match(statusLine(2, { ...sonnet, thinkingLevel: "high" }), /^anthropic\/claude-sonnet-4-5 {2}high • /);
	});

	it("shows off for a reasoning model, and no level for a model without reasoning (#4269)", () => {
		assert.match(statusLine(2, { ...sonnet, thinkingLevel: "off" }), /^anthropic\/claude-sonnet-4-5 {2}off • /);
		assert.match(
			statusLine(2, { ...sonnet, modelId: "gpt-4o", provider: "openai", reasoning: false }),
			/^openai\/gpt-4o • /,
		);
	});
});
describe("FooterComponent composer hints (#5224)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});
	const session = () =>
		createSession({ sessionName: "shipping fix-first", provider: "anthropic", modelId: "claude-sonnet-4-5" });

	it("the main composer's keys follow the model line, and its session title moves to the prompt's rule", () => {
		const footer = new FooterComponent(session(), createFooterData(1), undefined, undefined, undefined, () => [
			"? keys",
		]);
		const line = stripAnsi(footer.render(200)[0] ?? "");
		assert.match(line, / · \? keys$/);
		assert.doesNotMatch(line, /shipping fix-first/);
	});

	it("the composer's keys stay whole on a narrow terminal while the directory shortens", () => {
		const footer = new FooterComponent(session(), createFooterData(1), undefined, undefined, undefined, () => [
			"? keys",
		]);
		const line = stripAnsi(footer.render(36)[0] ?? "");
		assert.ok(visibleWidth(line) <= 36, line);
		assert.match(line, /\.\.\. · \? keys$/);
	});

	it("a chat without composer hints still names its session in the footer", () => {
		const line = stripAnsi(new FooterComponent(session(), createFooterData(1)).render(200)[0] ?? "");
		assert.match(line, /shipping fix-first/);
	});

	it("sanitizes newlines and terminal escape sequences in the footer session name, working directory and model label (#5243)", () => {
		for (const [raw, expected] of [
			["my\nsession", "my session"],
			["a\x1b]52;c;SGVsbG8=\x07b", "a ]52;c;SGVsbG8= b"],
			["x\x1b]0;PWNED\x07y", "x ]0;PWNED y"],
			["\x1b[2J\x1b[Hboom", "[2J [Hboom"],
		] as const) {
			const s = createSession({ sessionName: raw, provider: "anthropic", modelId: "claude-sonnet-4-5" });
			const rawLine = new FooterComponent(s, createFooterData(1)).render(200)[0] ?? "";
			assert.doesNotMatch(rawLine, /[\r\n\t\x07]|\x1b\]|\x1b\[2J|\x1b\[H/);
			assert.ok(stripAnsi(rawLine).endsWith(` • ${expected}`), stripAnsi(rawLine));
		}
		for (const [rawCwd, expectedPwd] of [
			["/tmp/a\x1b]52;c;SGVsbG8=\x07b", "/tmp/a ]52;c;SGVsbG8= b (main)"],
			["/tmp/x\ny", "/tmp/x y (main)"],
		] as const) {
			const s = createSession({ sessionName: "", cwd: rawCwd, provider: "anthropic", modelId: "claude-sonnet-4-5" });
			const rawLine = new FooterComponent(s, createFooterData(1)).render(200)[0] ?? "";
			assert.doesNotMatch(rawLine, /[\r\n\t\x07]|\x1b\]|\x1b\[2J|\x1b\[H/);
			assert.ok(stripAnsi(rawLine).endsWith(` • ${expectedPwd}`), stripAnsi(rawLine));
		}
		for (const [rawModelId, expectedModel] of [
			["m\x1b]0;PWNED\x07x", "m ]0;PWNED x"],
			["m\x1b[2J\x1b[Hx", "m [2J [Hx"],
			["m\nx", "m x"],
		] as const) {
			const s = createSession({ sessionName: "", provider: "anthropic", modelId: rawModelId });
			const rawLine = new FooterComponent(s, createFooterData(1)).render(200)[0] ?? "";
			assert.doesNotMatch(rawLine, /[\r\n\t\x07]|\x1b\]|\x1b\[2J|\x1b\[H/);
			assert.ok(stripAnsi(rawLine).startsWith(`${expectedModel} • `), stripAnsi(rawLine));
		}
	});

	it("sanitizes the provider shown when several providers are configured (#5243)", () => {
		for (const [rawProvider, expectedLabel] of [
			["anthropic", "anthropic/claude-sonnet-4-5"],
			["evil\x1b]0;PWNED\x07co", "evil ]0;PWNED co/claude-sonnet-4-5"],
			["evil\x1b]52;c;SGVsbG8=\x1b\\\nco", "evil ]52;c;SGVsbG8= \\ co/claude-sonnet-4-5"],
		] as const) {
			const s = createSession({ sessionName: "", provider: rawProvider, modelId: "claude-sonnet-4-5" });
			const rawLine = new FooterComponent(s, createFooterData(2)).render(200)[0] ?? "";
			assert.doesNotMatch(rawLine, /[\r\n\t\x07]|\x1b\]|\x1b\\/);
			assert.ok(stripAnsi(rawLine).startsWith(`${expectedLabel} • `), stripAnsi(rawLine));
		}
	});

	it("sanitizes the thinking level shown for a reasoning model (#5243)", () => {
		const s = createSession({
			sessionName: "",
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
			reasoning: true,
			thinkingLevel: "high\x1b]0;PWNED\x07\n",
		});
		const rawLine = new FooterComponent(s, createFooterData(1)).render(200)[0] ?? "";
		assert.doesNotMatch(rawLine, /[\r\n\t\x07]|\x1b\]/);
		assert.ok(stripAnsi(rawLine).startsWith("claude-sonnet-4-5  high ]0;PWNED • "), stripAnsi(rawLine));
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

	// Upstream footer.ts:101 / usage-totals.ts:49 count compaction boundaries
	// alongside branch summaries and tool results.
	it("includes branch summary, compaction, and tool result usage in the total cost", () => {
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
		expect(statsLine).toContain("$1.250");
		expect(statsLine).toContain("↑140");
		expect(statsLine).toContain("↓20");
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

describe("FooterComponent debug indicator (#4360)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});
	afterEach(() => {
		setDebugSetting(false);
		vi.unstubAllEnvs();
	});

	const render = (): string =>
		new FooterComponent(createSession({ sessionName: "" }), createFooterData(1)).render(200)[0] ?? "";

	it("shows a debug badge only while debug mode is on", () => {
		vi.stubEnv("ATOMIC_DEBUG", undefined);
		vi.stubEnv("ATOMIC_EXPERIMENTAL", undefined);
		assert.doesNotMatch(stripAnsi(render()), /debug/);
		setDebugSetting(true);
		assert.match(render(), new RegExp(`${escapeRegExp(theme.fg("warning", "debug"))}$`));
		setDebugSetting(false);
		assert.doesNotMatch(stripAnsi(render()), /debug/);
		vi.stubEnv("ATOMIC_DEBUG", "1");
		assert.match(stripAnsi(render()), / debug$/);
	});
});

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
