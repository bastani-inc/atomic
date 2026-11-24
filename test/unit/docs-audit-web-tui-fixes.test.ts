import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@bastani/atomic";
import { ProcessTerminal } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

const ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"GEMINI_API_KEY",
	"PERPLEXITY_API_KEY",
	"EXA_API_KEY",
	"ATOMIC_ALLOW_BROWSER_COOKIES",
	"PI_ALLOW_BROWSER_COOKIES",
	"ATOMIC_PROGRAM_STATUS",
	"PI_PROGRAM_STATUS",
] as const;

let tempHome = "";
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

function writeJsonFile(filePath: string, value: object): void {
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertValidGeminiConfigGuidance(message: string): void {
	assert.ok(
		message.includes('Set GEMINI_API_KEY in the environment or "geminiApiKey" in ~/.atomic/web-search.json'),
		`expected valid geminiApiKey guidance, got:\n${message}`,
	);
	assert.doesNotMatch(
		message,
		/Set GEMINI_API_KEY in ~\/\.atomic\/web-search\.json/,
		`must not tell users to set GEMINI_API_KEY in JSON, got:\n${message}`,
	);
	assert.ok(
		message.includes('"allowBrowserCookies": true'),
		`expected allowBrowserCookies guidance, got:\n${message}`,
	);
	assert.ok(
		message.includes("ATOMIC_ALLOW_BROWSER_COOKIES=1"),
		`expected ATOMIC_ALLOW_BROWSER_COOKIES=1 guidance, got:\n${message}`,
	);
}

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
	}
	tempHome = mkdtempSync(join(tmpdir(), "docs-audit-web-tui-"));
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	delete process.env.GEMINI_API_KEY;
	delete process.env.PERPLEXITY_API_KEY;
	delete process.env.EXA_API_KEY;
	delete process.env.ATOMIC_ALLOW_BROWSER_COOKIES;
	delete process.env.PI_ALLOW_BROWSER_COOKIES;
	vi.resetModules();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = "";
	}
});

describe("web-access Gemini configuration error messages", () => {
	test("gemini search error names geminiApiKey and allowBrowserCookies", async () => {
		const { search } = await import("../../packages/web-access/gemini-search.js");
		await assert.rejects(
			() => search("atomic cli", { provider: "gemini" }),
			(err: Error) => {
				assertValidGeminiConfigGuidance(err.message);
				return true;
			},
		);
	});

	test("local video extraction error names geminiApiKey and allowBrowserCookies", async () => {
		const videoPath = join(tempHome, "clip.mp4");
		writeFileSync(videoPath, "fake video bytes");
		const { extractContent } = await import("../../packages/web-access/extract.js");
		const result = await extractContent(videoPath);
		assert.ok(result.error, "expected video extraction error");
		assertValidGeminiConfigGuidance(result.error);
	});

	test("YouTube extraction error names geminiApiKey and allowBrowserCookies", async () => {
		const { extractContent } = await import("../../packages/web-access/extract.js");
		const result = await extractContent("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
		assert.ok(result.error, "expected YouTube extraction error");
		assertValidGeminiConfigGuidance(result.error);
	});

	test("HTTP fallback error names geminiApiKey and allowBrowserCookies", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" })),
		);
		const { extractContent } = await import("../../packages/web-access/extract.js");
		const result = await extractContent("https://example.com/blocked");
		assert.ok(result.error, "expected HTTP fallback error");
		assertValidGeminiConfigGuidance(result.error);
	});
});

describe("youtube.enabled: false enforcement for frame and timestamp options", () => {
	test("skips frame extraction when youtube.enabled is false even with frames or timestamp", async () => {
		writeJsonFile(join(tempHome, ".atomic", "web-search.json"), { youtube: { enabled: false } });
		const paragraph = "Readable YouTube watch page fallback text when YouTube extraction is disabled. ".repeat(15);
		const fetchMock = vi.fn(
			async () =>
				new Response(
					`<html><head><title>Watch</title></head><body><article><p>${paragraph}</p></article></body></html>`,
					{ headers: { "content-type": "text/html" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { extractContent } = await import("../../packages/web-access/extract.js");
		const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
		for (const options of [{ frames: 2 }, { timestamp: "invalid" }, { frames: 3, timestamp: "1:23" }]) {
			const result = await extractContent(url, undefined, options);
			assert.equal(result.error, null, `expected HTTP fallback without error for ${JSON.stringify(options)}`);
			assert.equal(result.frames, undefined);
			assert.match(result.content, /Readable YouTube watch page fallback text/);
		}
		assert.equal(fetchMock.mock.calls.length, 3);
	});
});

describe("/curator and /google-account slash commands", () => {
	type CommandEntry = Omit<RegisteredCommand, "name" | "sourceInfo">;
	interface SentMessageCall {
		customType: string;
		triggerTurn: boolean | undefined;
		deliverAs: string | undefined;
	}

	function createCommandHarness() {
		const commands = new Map<string, CommandEntry>();
		const sent: SentMessageCall[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const atomic: Pick<
			ExtensionAPI,
			| "registerCommand"
			| "registerTool"
			| "registerShortcut"
			| "registerMessageRenderer"
			| "on"
			| "sendMessage"
			| "appendEntry"
		> = {
			registerCommand(name, command) {
				commands.set(name, command);
			},
			registerTool() {},
			registerShortcut() {},
			registerMessageRenderer() {},
			on: () => () => {},
			sendMessage: ((message: { customType: string }, options?: { triggerTurn?: boolean; deliverAs?: string }) => {
				sent.push({
					customType: message.customType,
					triggerTurn: options?.triggerTurn,
					deliverAs: options?.deliverAs,
				});
			}) as ExtensionAPI["sendMessage"],
			appendEntry: (async () => {}) as ExtensionAPI["appendEntry"],
		};
		const ui: Pick<ExtensionCommandContext["ui"], "notify"> = {
			notify(message: string, level = "info") {
				notifications.push({ message, level });
			},
		};
		const ctx: Pick<ExtensionCommandContext, "ui"> = { ui: ui as ExtensionCommandContext["ui"] };
		return { atomic: atomic as ExtensionAPI, commands, sent, notifications, ctx: ctx as ExtensionCommandContext };
	}

	test("/curator usage error includes none alongside on, off, and summary-review", async () => {
		const { atomic, commands, notifications, ctx } = createCommandHarness();
		const { default: initHeavy } = await import("../../packages/web-access/index-heavy.js");
		await initHeavy(atomic);

		const curator = commands.get("curator");
		assert.ok(curator, "expected /curator command");
		await curator.handler("invalid-mode", ctx);

		assert.deepEqual(notifications, [
			{
				message: "Unknown option: invalid-mode. Use on, off, none, or summary-review.",
				level: "error",
			},
		]);
	});

	test("/google-account sends messages with triggerTurn: false across all branches", async () => {
		let cookies: Record<string, string> | null = null;
		let email: string | null = null;
		vi.doMock("../../packages/web-access/gemini-web.js", () => ({
			isGeminiWebAvailable: async () => cookies,
			getActiveGoogleEmail: async () => email,
			queryWithCookies: async () => "",
		}));
		try {
			const { atomic, commands, sent, ctx } = createCommandHarness();
			const { default: initHeavy } = await import("../../packages/web-access/index-heavy.js");
			await initHeavy(atomic);

			const googleAccount = commands.get("google-account");
			assert.ok(googleAccount, "expected /google-account command");

			await googleAccount.handler("", ctx);
			process.env.ATOMIC_ALLOW_BROWSER_COOKIES = "1";
			cookies = null;
			await googleAccount.handler("", ctx);
			cookies = { "__Secure-1PSID": "tok" };
			email = "user@example.com";
			await googleAccount.handler("", ctx);

			assert.deepEqual(sent, [
				{ customType: "google-account", triggerTurn: false, deliverAs: "followUp" },
				{ customType: "google-account", triggerTurn: false, deliverAs: "followUp" },
				{ customType: "google-account", triggerTurn: false, deliverAs: "followUp" },
			]);
		} finally {
			vi.doUnmock("../../packages/web-access/gemini-web.js");
		}
	});
});

describe("web-access config path creation and initial shortcut loading", () => {
	test("saveConfig creates dirname(WEB_SEARCH_CONFIG_PATH) instead of homedir()/.atomic", async () => {
		const customConfigPath = join(tempHome, "custom-config-root", "nested", "web-search.json");
		vi.doMock("@bastani/atomic", async (importOriginal) => {
			const original = await importOriginal<typeof import("@bastani/atomic")>();
			return {
				...original,
				getUserConfigPaths: (filename: string) =>
					filename === "web-search.json" ? [customConfigPath] : original.getUserConfigPaths(filename),
			};
		});
		try {
			const { saveConfig } = await import("../../packages/web-access/web-search-config.js");
			await saveConfig({ workflow: "summary-review" });
			const saved = JSON.parse(readFileSync(customConfigPath, "utf8")) as { workflow?: string };
			assert.deepEqual(saved, { workflow: "summary-review" });
		} finally {
			vi.doUnmock("@bastani/atomic");
		}
	});

	test("getInitialShortcutConfig uses getUserConfigPaths and does not fall back to legacy on malformed primary JSON", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const primaryPath = join(tempHome, "custom-primary", "web-search.json");
		const legacyPath = join(tempHome, "custom-legacy", "web-search.json");
		vi.doMock("@bastani/atomic", async (importOriginal) => {
			const original = await importOriginal<typeof import("@bastani/atomic")>();
			return {
				...original,
				getUserConfigPaths: (filename: string) =>
					filename === "web-search.json" ? [primaryPath, legacyPath] : original.getUserConfigPaths(filename),
			};
		});
		try {
			const collectShortcuts = async (): Promise<string[]> => {
				const shortcuts: string[] = [];
				const { default: registerWebAccess } = await import("../../packages/web-access/index.js");
				const atomic: Pick<
					ExtensionAPI,
					"registerShortcut" | "registerTool" | "registerCommand" | "registerMessageRenderer" | "on"
				> = {
					registerShortcut(shortcut) {
						shortcuts.push(shortcut);
					},
					registerTool() {},
					registerCommand() {},
					registerMessageRenderer() {},
					on: () => () => {},
				};
				registerWebAccess(atomic as ExtensionAPI);
				return shortcuts;
			};

			writeJsonFile(legacyPath, { shortcuts: { curate: "alt+shift+c", activity: "alt+shift+a" } });
			assert.deepEqual(await collectShortcuts(), ["alt+shift+c", "alt+shift+a"]);

			mkdirSync(join(primaryPath, ".."), { recursive: true });
			writeFileSync(primaryPath, "{ malformed json", "utf8");
			assert.deepEqual(await collectShortcuts(), ["ctrl+shift+s", "ctrl+shift+w"]);
			assert.ok(errorSpy.mock.calls.length >= 1, "expected diagnostic error for malformed primary config");

			writeJsonFile(primaryPath, { shortcuts: { curate: "alt+c", activity: "alt+a" } });
			assert.deepEqual(await collectShortcuts(), ["alt+c", "alt+a"]);
		} finally {
			vi.doUnmock("@bastani/atomic");
		}
	});
});

describe("web-access provider switching cache invalidation", () => {
	test("saveConfig clears legacy searchProvider and invalidates memoized search config immediately", async () => {
		const configPath = join(tempHome, ".atomic", "web-search.json");
		writeJsonFile(configPath, {
			searchProvider: "perplexity",
			perplexityApiKey: "pplx-key",
			exaApiKey: "exa-key",
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.startsWith("https://api.perplexity.ai/")) {
					return Response.json({
						choices: [{ message: { content: "Perplexity answer" } }],
						citations: ["https://example.test/pplx"],
					});
				}
				if (url.startsWith("https://api.exa.ai/")) {
					return Response.json({
						answer: "Exa answer",
						citations: [{ title: "Exa source", url: "https://example.test/exa" }],
					});
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);

		const { search } = await import("../../packages/web-access/gemini-search.js");
		const { saveConfig } = await import("../../packages/web-access/web-search-config.js");

		const first = await search("first query");
		assert.equal(first.provider, "perplexity");

		await saveConfig({ provider: "exa" });
		const savedOnDisk = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, string>;
		assert.equal(savedOnDisk.provider, "exa");
		assert.equal("searchProvider" in savedOnDisk, false);

		const second = await search("second query");
		assert.equal(second.provider, "exa");

		await saveConfig({ provider: "perplexity" });
		const third = await search("third query");
		assert.equal(third.provider, "perplexity");
	});
});

describe("ProcessTerminal.restoreOnExit OSC 7501 clearing", () => {
	const CLEAR_PROGRAM_STATUS = "\x1b]7501;state=clear\x1b\\";

	function captureRestoreOnExit(terminal: ProcessTerminal, fileName: string): string {
		const outPath = join(tempHome, fileName);
		const fd = openSync(outPath, "w");
		const previousDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "fd");
		Object.defineProperty(process.stdout, "fd", { value: fd, configurable: true });
		try {
			terminal.restoreOnExit("[before]", "[after]");
		} finally {
			if (previousDescriptor) Object.defineProperty(process.stdout, "fd", previousDescriptor);
			closeSync(fd);
		}
		return readFileSync(outPath, "utf8");
	}

	test("emits OSC 7501 state=clear in restoreOnExit when supported and active", () => {
		const previousWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
		process.env.ATOMIC_PROGRAM_STATUS = "1";
		delete process.env.PI_PROGRAM_STATUS;

		const terminal = new ProcessTerminal();
		try {
			terminal.start(
				() => {},
				() => {},
			);
			assert.equal(captureRestoreOnExit(terminal, "unset.txt").includes(CLEAR_PROGRAM_STATUS), false);

			terminal.setProgramStatus({ state: "working", app: "atomic" });
			const activeOutput = captureRestoreOnExit(terminal, "active.txt");
			assert.ok(activeOutput.startsWith("[before]"));
			assert.ok(activeOutput.endsWith("[after]"));
			assert.ok(activeOutput.includes(CLEAR_PROGRAM_STATUS));

			terminal.setProgramStatus({ state: "clear" });
			assert.equal(captureRestoreOnExit(terminal, "cleared.txt").includes(CLEAR_PROGRAM_STATUS), false);
		} finally {
			terminal.stop();
			process.stdout.write = previousWrite;
		}
	});

	test("omits OSC 7501 state=clear in restoreOnExit when unsupported", () => {
		const previousWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
		process.env.ATOMIC_PROGRAM_STATUS = "0";
		delete process.env.PI_PROGRAM_STATUS;

		const terminal = new ProcessTerminal();
		try {
			terminal.start(
				() => {},
				() => {},
			);
			terminal.setProgramStatus({ state: "working", app: "atomic" });
			assert.equal(captureRestoreOnExit(terminal, "disabled.txt").includes(CLEAR_PROGRAM_STATUS), false);
		} finally {
			terminal.stop();
			process.stdout.write = previousWrite;
		}
	});
});

describe("@bastani/atomic-ai package bin registration", () => {
	test("registers both atomic-ai and legacy pi-ai bins pointing to dist/cli.js", () => {
		const manifestPath = fileURLToPath(new URL("../../packages/ai/package.json", import.meta.url));
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: Record<string, string> };
		assert.deepEqual(manifest.bin, {
			"atomic-ai": "dist/cli.js",
			"pi-ai": "dist/cli.js",
		});
	});
});
