import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionHeader, SessionInfo, SessionListProgress } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const fullTranscriptReadTracking = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("fs/promises", async () => {
	const original = await vi.importActual<typeof import("fs/promises")>("fs/promises");
	return {
		...original,
		readFile: (...args: Parameters<typeof original.readFile>) => {
			fullTranscriptReadTracking.paths.push(String(args[0]));
			return original.readFile(...args);
		},
	};
});

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;
type SelectSession = (current: SessionsLoader, all: SessionsLoader) => Promise<string | null>;
type SelectorBuilder = (done: () => void) => {
	component: SessionSelectorComponent;
	focus: SessionSelectorComponent;
};

let selectSessionImplementation: SelectSession = async () => null;

vi.mock("../src/cli/session-picker.ts", () => ({
	selectSession: (current: SessionsLoader, all: SessionsLoader) => selectSessionImplementation(current, all),
}));

const messageLine = (text: string, timestamp: number) =>
	JSON.stringify({
		type: "message",
		id: `entry-${timestamp}`,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content: text, timestamp },
	});

function writeSession(
	dir: string,
	id: string,
	cwd: string,
	options: { internal?: boolean; stageId?: string; body?: string; mtime: number },
): string {
	const header: SessionHeader = {
		type: "session",
		version: 3,
		id,
		timestamp: new Date(options.mtime).toISOString(),
		cwd,
		...(options.internal
			? {
					internal: true,
					workflow: { runId: "run-many", stageId: options.stageId ?? id, stageName: `stage-${id}` },
				}
			: {}),
	};
	const path = join(dir, `${id}.jsonl`);
	writeFileSync(path, `${JSON.stringify(header)}\n${options.body ?? messageLine(id, options.mtime)}\n`);
	utimesSync(path, options.mtime / 1000, options.mtime / 1000);
	return path;
}

describe("internal workflow sessions across resume surfaces", () => {
	let dir: string;
	let cwd: string;
	let settingsManager: SettingsManager;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atomic-internal-resume-"));
		cwd = join(dir, "project");
		settingsManager = SettingsManager.inMemory();
		selectSessionImplementation = async () => null;
		setKeybindings(new KeybindingsManager());
		fullTranscriptReadTracking.paths.length = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it("continueRecent skips a newer workflow stage by default and supports explicit internal recovery", () => {
		const now = Date.now();
		const userPath = writeSession(dir, "user-recent", cwd, { mtime: now - 10_000 });
		const workflowPath = writeSession(dir, "workflow-newest", cwd, {
			internal: true,
			stageId: "stage-newest",
			mtime: now,
		});

		const regular = SessionManager.continueRecent(cwd, dir);
		expect(regular.getSessionFile()).toBe(userPath);
		expect(regular.getHeader()?.internal).toBeUndefined();

		const internal = SessionManager.continueRecent(cwd, dir, { includeInternal: true });
		expect(internal.getSessionFile()).toBe(workflowPath);
		expect(internal.getHeader()?.workflow).toEqual({
			runId: "run-many",
			stageId: "stage-newest",
			stageName: "stage-workflow-newest",
		});
	});

	it("keeps many workflow transcripts out of listings without full transcript parsing", async () => {
		const now = Date.now();
		const userPath = writeSession(dir, "user-visible", cwd, { mtime: now - 100_000 });
		const workflowPaths: string[] = [];
		for (let index = 0; index < 64; index++) {
			workflowPaths.push(
				writeSession(dir, `workflow-${index}`, cwd, {
					internal: true,
					stageId: `stage-${index}`,
					body: `{malformed workflow body ${index} ${"x".repeat(4096)}}`,
					mtime: now + index,
				}),
			);
		}

		expect((await SessionManager.list(cwd, dir)).map((session) => session.id)).toEqual(["user-visible"]);
		expect((await SessionManager.listAll(dir)).map((session) => session.id)).toEqual(["user-visible"]);
		const defaultTranscriptReads = fullTranscriptReadTracking.paths.filter((path) => path.endsWith(".jsonl"));
		expect(defaultTranscriptReads).toEqual([userPath, userPath]);
		expect(defaultTranscriptReads).not.toEqual(expect.arrayContaining(workflowPaths));
		expect(SessionManager.continueRecent(cwd, dir).getSessionFile()).toBe(userPath);

		fullTranscriptReadTracking.paths.length = 0;
		const all = await SessionManager.listAll(dir, undefined, { includeInternal: true });
		expect(fullTranscriptReadTracking.paths.filter((path) => path.endsWith(".jsonl"))).toHaveLength(65);
		expect(all).toHaveLength(65);
		const stage = all.find((session) => session.id === "workflow-63");
		expect(stage).toMatchObject({
			internal: true,
			workflow: { runId: "run-many", stageId: "stage-63", stageName: "stage-workflow-63" },
		});
	});

	it("the interactive /resume surface wires default-filtered project and all-history loaders", async () => {
		const now = Date.now();
		writeSession(dir, "user-interactive", cwd, { mtime: now - 1_000 });
		writeSession(dir, "workflow-interactive", cwd, { internal: true, mtime: now });
		let selector: SessionSelectorComponent | undefined;
		const mode = {
			sessionManager: {
				getCwd: () => cwd,
				getSessionDir: () => dir,
				getSessionFile: () => undefined,
				usesDefaultSessionDir: () => false,
			},
			keybindings: new KeybindingsManager(),
			ui: { requestRender: () => {} },
			handleResumeSession: async () => {},
			shutdown: async () => {},
			showSelector: (build: SelectorBuilder) => {
				selector = build(() => {}).component;
			},
		};
		await import("../src/modes/interactive/interactive-session-routing.ts");
		InteractiveModeBase.prototype.showSessionSelector.call(mode as InteractiveModeBase);

		expect(selector).toBeDefined();
		const current = Reflect.get(selector!, "currentSessionsLoader") as SessionsLoader;
		const all = Reflect.get(selector!, "allSessionsLoader") as SessionsLoader;
		expect((await current()).map((session) => session.id)).toEqual(["user-interactive"]);
		expect((await all()).map((session) => session.id)).toEqual(["user-interactive"]);
	});

	it("the interactive /resume surface uses the default listAll overload for default storage", async () => {
		let selector: SessionSelectorComponent | undefined;
		const listAll = vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
		const mode = {
			sessionManager: {
				getCwd: () => cwd,
				getSessionDir: () => dir,
				getSessionFile: () => undefined,
				usesDefaultSessionDir: () => true,
			},
			keybindings: new KeybindingsManager(),
			ui: { requestRender: () => {} },
			handleResumeSession: async () => {},
			shutdown: async () => {},
			showSelector: (build: SelectorBuilder) => {
				selector = build(() => {}).component;
			},
		};
		await import("../src/modes/interactive/interactive-session-routing.ts");
		InteractiveModeBase.prototype.showSessionSelector.call(mode as InteractiveModeBase);

		const all = Reflect.get(selector!, "allSessionsLoader") as SessionsLoader;
		const onProgress: SessionListProgress = () => {};
		await all(onProgress);
		expect(listAll).toHaveBeenCalledWith(onProgress);
	});

	it.each(["-r", "--resume"])("%s passes default-filtered loaders to the startup resume picker", async (flag) => {
		const now = Date.now();
		const userPath = writeSession(dir, "user-picker", cwd, { mtime: now - 1_000 });
		writeSession(dir, "workflow-picker", cwd, { internal: true, mtime: now });
		let pickerCalled = false;
		selectSessionImplementation = async (current, all) => {
			pickerCalled = true;
			expect((await current()).map((session) => session.id)).toEqual(["user-picker"]);
			expect((await all()).map((session) => session.id)).toEqual(["user-picker"]);
			return userPath;
		};
		const { createSessionManager } = await import("../src/main-session.ts");

		const session = await createSessionManager(parseArgs([flag]), cwd, dir, settingsManager);
		expect(pickerCalled).toBe(true);
		expect(session.getSessionFile()).toBe(userPath);
	});

	it("opens an internal workflow session when its path is explicitly requested", async () => {
		const workflowPath = writeSession(dir, "workflow-explicit", cwd, {
			internal: true,
			stageId: "stage-explicit",
			mtime: Date.now(),
		});
		const { createSessionManager } = await import("../src/main-session.ts");

		const session = await createSessionManager(
			parseArgs(["--session", workflowPath]),
			cwd,
			dir,
			settingsManager,
		);
		expect(session.getSessionFile()).toBe(workflowPath);
		expect(session.getHeader()).toMatchObject({
			internal: true,
			workflow: { runId: "run-many", stageId: "stage-explicit", stageName: "stage-workflow-explicit" },
		});
	});

	it.each(["-c", "--continue"])("%s continues the regular session instead of a newer workflow stage", async (flag) => {
		const now = Date.now();
		const userPath = writeSession(dir, "user-continue", cwd, { mtime: now - 1_000 });
		writeSession(dir, "workflow-continue", cwd, { internal: true, mtime: now });

		const { createSessionManager } = await import("../src/main-session.ts");
		const session = await createSessionManager(parseArgs([flag]), cwd, dir, settingsManager);
		expect(session.getSessionFile()).toBe(userPath);
		expect(session.getHeader()?.internal).toBeUndefined();
	});
});
