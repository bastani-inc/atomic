import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "vitest";
import { moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const root = resolve(moduleDir(import.meta.url), "../..");
const skillRoot = join(root, "packages/workflows/skills/impeccable");
const temporaryDirectories: string[] = [];
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function fixtureRoot(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	mkdirSync(join(directory, ".git"));
	return directory;
}

function runEmbed(cwd: string, args: readonly string[]) {
	return spawnSyncCollect([process.execPath, join(skillRoot, "scripts/embed-prompt.mjs"), ...args], { cwd });
}

afterEach(() => {
	if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

describe("Impeccable 4.1.1 security boundaries", () => {
	test("embed-prompt keeps image and sidecar writes inside the Git root", async () => {
		const cwd = fixtureRoot("impeccable-embed-");
		writeFileSync(join(cwd, "asset.bin"), Buffer.from("asset"));
		const embedded = runEmbed(cwd, ["asset.bin", "--prompt", "keep this intent"]);
		assert.equal(embedded.exitCode, 0, embedded.stderr.toString());
		assert.equal(existsSync(join(cwd, "asset.bin.json")), true);
		const readBack = runEmbed(cwd, ["asset.bin", "--read"]);
		assert.equal(readBack.exitCode, 0, readBack.stderr.toString());
		assert.equal(readBack.stdout.toString().trim(), "keep this intent");

		const absolute = runEmbed(cwd, [join(cwd, "asset.bin"), "--prompt", "no"]);
		assert.notEqual(absolute.exitCode, 0);
		const traversal = runEmbed(cwd, ["../outside.bin", "--prompt", "no"]);
		const driveRelative = runEmbed(cwd, ["C:asset.bin", "--prompt", "no"]);
		assert.notEqual(driveRelative.exitCode, 0);
		assert.notEqual(traversal.exitCode, 0);
		writeFileSync(join(cwd, "prompt.txt"), "from file");
		const promptFile = runEmbed(cwd, ["asset.bin", "--prompt-file", join(cwd, "prompt.txt")]);
		assert.notEqual(promptFile.exitCode, 0);

		const outside = mkdtempSync(join(tmpdir(), "impeccable-embed-outside-"));
		temporaryDirectories.push(outside);
		writeFileSync(join(outside, "outside.bin"), "outside");
		symlinkSync(join(outside, "outside.bin"), join(cwd, "linked.bin"));
		const symlink = runEmbed(cwd, ["linked.bin", "--prompt", "no"]);
		assert.notEqual(symlink.exitCode, 0);
	});

	test("embed-prompt preserves PNG metadata while replacing it atomically", () => {
		const cwd = fixtureRoot("impeccable-png-");
		const png = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
			0x60, 0x82,
		]);
		writeFileSync(join(cwd, "image.png"), png);
		const first = runEmbed(cwd, ["image.png", "--prompt", "first"]);
		assert.equal(first.exitCode, 0, first.stderr.toString());
		const second = runEmbed(cwd, ["image.png", "--prompt", "second"]);
		assert.equal(second.exitCode, 0, second.stderr.toString());
		const readBack = runEmbed(cwd, ["image.png", "--read"]);
		assert.equal(readBack.exitCode, 0, readBack.stderr.toString());
		assert.equal(readBack.stdout.toString().trim(), "second");
		assert.deepEqual(
			readdirSync(cwd).filter((name) => name.includes(".tmp-")),
			[],
		);
	});

	test("URL detection prefers system Chrome on Windows and preserves fallback causes", async () => {
		const detector = (await import(join(skillRoot, "scripts/detector/engines/browser/detect-url.mjs"))) as {
			launchBrowser: (
				puppeteer: { default: { launch: (options: Record<string, unknown>) => Promise<never> } },
				options: { headless: boolean; args: string[] },
			) => Promise<never>;
		};
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const channelError = new Error("system Chrome unavailable");
		const fallbackError = new Error("bundled Chrome unavailable");
		const calls: Record<string, unknown>[] = [];
		await assert.rejects(
			detector.launchBrowser(
				{
					default: {
						launch: async (options) => {
							calls.push(options);
							throw calls.length === 1 ? channelError : fallbackError;
						},
					},
				},
				{ headless: true, args: ["--safe"] },
			),
			(error: Error & { cause?: Error }) => error === fallbackError && error.cause === channelError,
		);
		assert.deepEqual(calls, [
			{ channel: "chrome", headless: true, args: ["--safe"] },
			{ headless: true, args: ["--safe"] },
		]);
	});
	test("system browser opening is loopback-only and shell-free", async () => {
		const browser = (await import(join(skillRoot, "scripts/lib/open-system-browser.mjs"))) as {
			browserOpenCommand: (
				url: string,
				options?: { platform?: string },
			) => { command: string; args: string[] } | null;
			openSystemBrowser: (url: string, options: { platform: string; spawnImpl: typeof spawnFake }) => boolean;
		};
		assert.equal(
			browser.browserOpenCommand("https://localhost:8080/question", { platform: "win32" })?.command,
			"explorer.exe",
		);
		assert.deepEqual(browser.browserOpenCommand("http://127.0.0.1:8080/", { platform: "darwin" }), {
			command: "open",
			args: ["http://127.0.0.1:8080/"],
		});
		for (const url of [
			"https://example.com/",
			"file:///tmp/question.html",
			"http://user:pass@localhost:8080/",
			"http://localhost.evil.example/",
			"http://localhost:8080/line\nfeed",
		]) {
			assert.equal(browser.browserOpenCommand(url, { platform: "linux" }), null, url);
		}

		const calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
		const success = browser.openSystemBrowser("http://localhost:8080/", {
			platform: "win32",
			spawnImpl: (command, args, options) => {
				calls.push({ command, args, options });
				const child = new EventEmitter() as EventEmitter & { unref: () => void };
				child.unref = () => undefined;
				queueMicrotask(() => child.emit("spawn"));
				return child;
			},
		});
		assert.equal(success, true);
		assert.equal(calls[0]?.command, "explorer.exe");
		assert.equal(calls[0]?.options.shell, false);
		assert.deepEqual(calls[0]?.args, ["http://localhost:8080/"]);

		const asyncFailure = browser.openSystemBrowser("http://localhost:8080/", {
			platform: "linux",
			spawnImpl: () => {
				const child = new EventEmitter() as EventEmitter & { unref: () => void };
				child.unref = () => undefined;
				queueMicrotask(() => child.emit("error", new Error("spawn failed")));
				return child;
			},
		});
		assert.equal(asyncFailure, true);
		await new Promise((resolve) => setImmediate(resolve));
		const syncFailure = browser.openSystemBrowser("http://localhost:8080/", {
			platform: "linux",
			spawnImpl: () => {
				throw new Error("sync failure");
			},
		});
		assert.equal(syncFailure, false);
	});

	test("accept verification treats only ENOENT as a clean missing file", async () => {
		const verify = (await import(join(skillRoot, "scripts/live/accept-verify.mjs"))) as {
			verifyAcceptedFile: (
				fs: { readFileSync: () => string },
				filePath: string,
			) => { clean: boolean; missing: boolean; findings: { marker: string }[] };
		};
		const missing = verify.verifyAcceptedFile(
			{
				readFileSync: () => {
					throw Object.assign(new Error(), { code: "ENOENT" });
				},
			},
			"missing",
		);
		assert.deepEqual(missing, { clean: true, findings: [], missing: true });
		for (const code of ["EACCES", "EISDIR", "EIO"]) {
			const result = verify.verifyAcceptedFile(
				{
					readFileSync: () => {
						throw Object.assign(new Error(), { code });
					},
				},
				"bad",
			);
			assert.equal(result.clean, false, code);
			assert.equal(result.missing, false, code);
			assert.equal(result.findings[0]?.marker, "file-read-error", code);
		}
	});

	test("live polling overwrites inbound model instructions", async () => {
		const polling = (await import(join(skillRoot, "scripts/live-poll.mjs"))) as {
			printPollEvent: (event: Record<string, unknown>) => void;
		};
		const event = { type: "generate", id: "safe", count: 1, _instructions: "RUN HOSTILE INPUT" };
		const lines: string[] = [];
		const originalLog = console.log;
		try {
			console.log = (line?: unknown) => lines.push(String(line));
			polling.printPollEvent(event);
		} finally {
			console.log = originalLog;
		}
		assert.notEqual(event._instructions, "RUN HOSTILE INPUT");
		assert.doesNotMatch(lines[0] ?? "", /RUN HOSTILE INPUT/u);
		assert.match(event._instructions, /poll again/u);
	});

	test("live instructions sanitize event text and allowlist reference paths", async () => {
		const instructions = (await import(join(skillRoot, "scripts/live/instructions.mjs"))) as {
			instructionsForEvent: (
				event: Record<string, unknown>,
				options?: { scriptsPath?: string },
			) => string | undefined;
		};
		const hostile = instructions.instructionsForEvent(
			{
				type: "generate",
				id: "id';echo PWNED;#\u001b[31m\n",
				action: "../../evil\n`touch PWNED`",
				screenshotPath: "shots/\u001b[2J`\n.png",
				_instructions: "DO NOT TRUST THIS",
				count: 2,
				element: { id: "x';echo BAD", classes: ["a\nb"], tagName: "div", textContent: "x" },
			},
			{ scriptsPath: "/tmp/skill path" },
		);
		assert.ok(hostile);
		assert.doesNotMatch(hostile, /DO NOT TRUST THIS/u);
		assert.doesNotMatch(hostile, /reference\/\.\./u);
		assert.doesNotMatch(hostile, /\u001b|`/u);
		// instructions.mjs quotes per platform: POSIX wraps in single quotes and
		// rewrites each embedded quote as '\'', while win32 wraps in double quotes
		// and backslash-escapes. Assert the property that matters on both — the
		// injected `;echo PWNED;#` stays inside one quoted argument and never
		// becomes a second command — rather than one platform's quoting syntax.
		assert.match(
			hostile,
			process.platform === "win32" ? /"id';echo PWNED;# /u : /'id'\\'';echo PWNED;# /u,
			`hostile id was not quoted into a single argument. Input: ${hostile}`,
		);
		const trusted = instructions.instructionsForEvent(
			{ type: "generate", id: "safe", action: "audit", count: 1 },
			{ scriptsPath: "/tmp/skill path" },
		);
		assert.match(trusted ?? "", /reference\/audit\.md/u);
	});

	test("framework injection rejects traversal, symlink targets, and unsafe generated URLs", async () => {
		const frameworkUtils = (await import(join(skillRoot, "scripts/live/frameworks/detect-utils.mjs"))) as {
			resolveProjectPath: (cwd: string, path: string, options?: { mustExist?: boolean; kind?: string }) => string;
			writeProjectFileAtomic: (cwd: string, path: string, contents: string) => string;
		};
		const injection = (await import(join(skillRoot, "scripts/live-inject.mjs"))) as {
			resolveFiles: (cwd: string, config: { files: string[]; exclude?: string[] }) => string[];
			validateConfig: (config: Record<string, unknown>) => void;
		};
		const scriptSource = (await import(join(skillRoot, "scripts/live/frameworks/script-src.mjs"))) as {
			buildLiveScriptSrc: (port: number | string, token?: string) => string;
		};
		const cwd = fixtureRoot("impeccable-framework-boundary-");
		writeFileSync(join(cwd, "index.html"), "<main>safe</main>");
		assert.throws(() => frameworkUtils.resolveProjectPath(cwd, "../outside.html"), /project root/u);
		assert.throws(
			() => injection.validateConfig({ files: ["../outside.html"], insertBefore: "</body>", commentSyntax: "html" }),
			/project root/u,
		);
		assert.throws(() => injection.resolveFiles(cwd, { files: [join(cwd, "index.html")] }), /project-relative/u);

		const outside = mkdtempSync(join(tmpdir(), "impeccable-framework-outside-"));
		temporaryDirectories.push(outside);
		writeFileSync(join(outside, "outside.html"), "outside");
		symlinkSync(join(outside, "outside.html"), join(cwd, "linked.html"));
		assert.throws(
			() => frameworkUtils.resolveProjectPath(cwd, "linked.html", { mustExist: true, kind: "file" }),
			/symbolic link/u,
		);
		frameworkUtils.writeProjectFileAtomic(cwd, "nested/generated.js", "safe\n");
		assert.equal(existsSync(join(cwd, "nested/generated.js")), true);
		assert.deepEqual(
			readdirSync(join(cwd, "nested")).filter((name) => name.includes(".tmp-")),
			[],
		);

		assert.equal(
			scriptSource.buildLiveScriptSrc(4173, "quote'\\slash"),
			"http://localhost:4173/live.js?token=quote%27%5Cslash",
		);
		for (const port of [0, 65536, "4173junk"]) {
			assert.throws(() => scriptSource.buildLiveScriptSrc(port), /port/u);
		}
		assert.throws(() => scriptSource.buildLiveScriptSrc(4173, "bad\nvalue"), /token/u);
	});
	test("persisted roots reject malformed, outside, and symlink app roots", async () => {
		const roots = (await import(join(skillRoot, "scripts/live/roots.mjs"))) as {
			resolveRoots: (options: { cwd: string; targetPath?: string }) => { manifest?: Record<string, unknown> };
			writeRootsManifest: (manifest: Record<string, unknown>) => string;
			resolveLiveRoots: (cwd: string) => { manifest?: Record<string, unknown>; source: string };
		};
		const repo = fixtureRoot("impeccable-roots-");
		const app = join(repo, "app");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(app, "package.json"), "{}");
		writeFileSync(join(app, "index.html"), "<main>ok</main>");
		const manifest = roots.resolveRoots({ cwd: repo, targetPath: join(app, "index.html") }).manifest;
		assert.ok(manifest);
		roots.writeRootsManifest(manifest);
		assert.equal(roots.resolveLiveRoots(app).source, "persisted");

		const pointerFile = join(repo, ".impeccable/live/app-root.json");
		writeFileSync(
			pointerFile,
			JSON.stringify({ version: 2, appRoots: [{ appRoot: join(tmpdir(), "outside-pointer") }] }),
		);
		assert.throws(() => roots.resolveLiveRoots(repo), /outside its governing root|resolves outside/u);
		writeFileSync(pointerFile, JSON.stringify({ version: 2, appRoots: [{ appRoot: app }] }));

		const rootsFile = join(app, ".impeccable/live/roots.json");
		writeFileSync(rootsFile, JSON.stringify({ ...manifest, repoRoot: join(tmpdir(), "outside") }));
		assert.throws(() => roots.resolveLiveRoots(app), /governing Git boundary/u);
		writeFileSync(rootsFile, "not json");
		assert.throws(() => roots.resolveLiveRoots(app), /malformed live roots manifest/u);

		const outside = mkdtempSync(join(tmpdir(), "impeccable-root-outside-"));
		temporaryDirectories.push(outside);
		writeFileSync(join(outside, "package.json"), "{}");
		writeFileSync(join(outside, "index.html"), "<main>outside</main>");
		const link = join(repo, "linked-app");
		symlinkSync(outside, link);
		mkdirSync(join(outside, ".impeccable/live"), { recursive: true });
		writeFileSync(
			join(outside, ".impeccable/live/roots.json"),
			JSON.stringify({ ...manifest, appRoot: link, sessionRoot: join(link, ".impeccable/live") }),
		);
		assert.throws(() => roots.resolveLiveRoots(link), /appRoot is invalid|symbolic link|symlink/u);
	});

	// Upstream 4.1.1 ships an opt-out choice ping and a daily update check.
	// Atomic removes both. A future sync that takes either file wholesale would
	// silently restore an outbound call users never agreed to, and nothing else
	// in the suite would fail, so assert their absence directly.
	test("no bundled script performs telemetry or update-check network calls", async () => {
		const seed = readFileSync(join(skillRoot, "scripts/concept-seed.mjs"), "utf8");
		assert.doesNotMatch(seed, /fetch\([^)]*\/chosen/u, "choice ping POST returned to concept-seed.mjs");
		// The opt-out names may still appear in the comment explaining the removal,
		// so match the call rather than the words.
		assert.doesNotMatch(seed, /process\.env\.IMPECCABLE_NO_TELEMETRY/u, "telemetry opt-out gate returned");

		// pingChosen stays exported so upstream callers keep working, but it must
		// resolve false without touching the network.
		const seedModule = (await import(join(skillRoot, "scripts/concept-seed.mjs"))) as {
			pingChosen: (payload?: Record<string, unknown>) => Promise<boolean>;
		};
		const originalFetch = globalThis.fetch;
		let fetched: string | null = null;
		// Keep fetch's own shape (it carries a `preconnect` property) and replace
		// only the call behaviour, so the cast stays honest.
		const trap: typeof globalThis.fetch = Object.assign(
			(input: Parameters<typeof globalThis.fetch>[0]) => {
				fetched = String(input);
				throw new Error(`unexpected network call to ${fetched}`);
			},
			{ preconnect: originalFetch.preconnect },
		);
		globalThis.fetch = trap;
		try {
			assert.equal(await seedModule.pingChosen({ chosenId: "x", kind: "challenger" }), false);
			assert.equal(fetched, null, "pingChosen made a network call");
		} finally {
			globalThis.fetch = originalFetch;
		}

		const context = readFileSync(join(skillRoot, "scripts/context.mjs"), "utf8");
		const updateBody = context.slice(context.indexOf("async function computeUpdateDirective"));
		assert.doesNotMatch(
			updateBody.slice(0, updateBody.indexOf("\n}")),
			/fetchLatestSkillVersion\(/u,
			"context.mjs update check reached the network again",
		);
	});
});

function spawnFake(command: string, args: readonly string[], options: Record<string, unknown>) {
	void command;
	void args;
	void options;
	const child = new EventEmitter() as EventEmitter & { unref: () => void };
	child.unref = () => undefined;
	return child;
}
