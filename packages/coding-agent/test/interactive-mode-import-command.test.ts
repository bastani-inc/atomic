import { describe, expect, it, vi } from "vitest";
import { SessionImportFileNotFoundError } from "../src/core/agent-session-runtime.ts";
import { type MissingSessionCwdChoice, MissingSessionCwdError } from "../src/core/session-cwd.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { formatWorktreeRestoreNotice, formatWorktreeRestoreWarning } from "../src/core/session-worktree-snapshots.ts";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type PathCommand = "/export" | "/import";

type InteractiveModePrototype = {
	getPathCommandArgument(this: unknown, text: string, command: PathCommand): string | undefined;
	handleImportCommand(this: ImportCommandContext, text: string): Promise<void>;
};

type ImportCommandContext = {
	loadingAnimation?: { stop: () => void };
	statusContainer: { clear: () => void };
	runtimeHost: {
		importFromJsonl: (inputPath: string, cwdOverride?: string) => Promise<{ cancelled: boolean }>;
		takeResumeNotices: () => readonly { type: "info" | "warning"; message: string }[];
	};
	sessionManager: {
		getBranch: () => SessionEntry[];
		getWorktreeSnapshotRecords: () => Map<string, WorktreeSnapshot>;
	};
	showError: (message: string) => void;
	showWarning: (message: string) => void;
	showStatus: (message: string, persist?: boolean) => void;
	showExtensionConfirm: (title: string, message: string) => Promise<boolean>;
	handleRuntimeSessionChange: () => Promise<void>;
	renderCurrentSessionState: () => void;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
	promptForMissingSessionCwd: (error: unknown) => Promise<MissingSessionCwdChoice | undefined>;
	switchToForkedSession: (source: { exportPath: string }, cwd: string) => Promise<{ cancelled: boolean }>;
	getPathCommandArgument: (text: string, command: PathCommand) => string | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

const sessionWithoutRestores = (): ImportCommandContext["sessionManager"] => ({
	getBranch: () => [],
	getWorktreeSnapshotRecords: () => new Map(),
});

describe("InteractiveMode /import parsing", () => {
	it("strips quotes from /import path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument('/import "path/to/session.jsonl"', "/import")).toBe(
			"path/to/session.jsonl",
		);
		expect(
			interactiveModePrototype.getPathCommandArgument('/import "path with spaces/session.jsonl"', "/import"),
		).toBe("path with spaces/session.jsonl");
	});

	it("preserves apostrophes in unquoted /import path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/import john's/session.jsonl", "/import")).toBe(
			"john's/session.jsonl",
		);
	});

	it("enforces command token boundaries", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/important /tmp/session.jsonl", "/import")).toBe(
			undefined,
		);
		expect(interactiveModePrototype.getPathCommandArgument("/exporter out.html", "/export")).toBe(undefined);
		expect(interactiveModePrototype.getPathCommandArgument("/import /tmp/session.jsonl", "/import")).toBe(
			"/tmp/session.jsonl",
		);
	});

	it("passes unquoted path to runtimeHost.importFromJsonl", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			runtimeHost: { importFromJsonl, takeResumeNotices: () => [] },
			sessionManager: sessionWithoutRestores(),
			showError,
			showWarning: vi.fn(),
			showStatus,
			showExtensionConfirm,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			switchToForkedSession: vi.fn(async () => ({ cancelled: false })),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, '/import "path/to/session.jsonl"');

		expect(showExtensionConfirm).toHaveBeenCalledWith(
			"Import session",
			"Replace current session with path/to/session.jsonl?",
		);
		expect(importFromJsonl).toHaveBeenCalledWith("path/to/session.jsonl");
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session imported from: path/to/session.jsonl");
	});

	it("passes unquoted apostrophe path to runtimeHost.importFromJsonl unchanged", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			runtimeHost: { importFromJsonl, takeResumeNotices: () => [] },
			sessionManager: sessionWithoutRestores(),
			showError,
			showWarning: vi.fn(),
			showStatus,
			showExtensionConfirm,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			switchToForkedSession: vi.fn(async () => ({ cancelled: false })),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, "/import john's/session.jsonl");

		expect(importFromJsonl).toHaveBeenCalledWith("john's/session.jsonl");
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session imported from: john's/session.jsonl");
	});

	it("shows each restore the import performed as a lasting line, with the warnings it recorded (#4245)", async () => {
		const branch: SessionEntry[] = [];
		const restore = {
			from: "/recorded/repo",
			to: "/host/worktrees/restored",
			snapshotId: "0123456789abcdef0123456789abcdef",
			tree: "t",
			restoredAt: "",
		};
		const warning = { code: "lfs-objects-unavailable" as const, paths: ["data.bin"] };
		const importFromJsonl = vi.fn(async () => {
			const mapping = { ...restore, restoredAt: new Date().toISOString() };
			branch.push({
				type: "worktree_snapshot",
				id: "restore",
				parentId: null,
				timestamp: mapping.restoredAt,
				root: mapping.to,
				snapshotId: mapping.snapshotId,
				restore: mapping,
				restoreWarnings: [warning],
			});
			return { cancelled: false };
		});
		const showStatus = vi.fn();
		const showWarning = vi.fn();
		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			runtimeHost: { importFromJsonl, takeResumeNotices: () => [] },
			sessionManager: { getBranch: () => branch, getWorktreeSnapshotRecords: () => new Map() },
			showError: vi.fn(),
			showWarning,
			showStatus,
			showExtensionConfirm: vi.fn(async () => true),
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			switchToForkedSession: vi.fn(async () => ({ cancelled: false })),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, "/import exported.jsonl");

		const recorded = branch[0];
		expect(recorded?.type === "worktree_snapshot" && recorded.restore).toBeTruthy();
		if (recorded?.type !== "worktree_snapshot" || !recorded.restore) return;
		expect(showStatus.mock.calls).toEqual([
			["Session imported from: exported.jsonl"],
			[formatWorktreeRestoreNotice(recorded.restore), true],
		]);
		expect(showWarning.mock.calls).toEqual([[formatWorktreeRestoreWarning(warning)]]);
	});

	it("shows a non-fatal error when /import path does not exist", async () => {
		const importFromJsonl = vi.fn(async () => {
			throw new SessionImportFileNotFoundError("/tmp/missing-session.jsonl");
		});
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();
		const handleFatalRuntimeError = vi.fn(async () => {
			throw new Error("unexpected fatal error");
		});

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			runtimeHost: { importFromJsonl, takeResumeNotices: () => [] },
			sessionManager: sessionWithoutRestores(),
			showError,
			showWarning: vi.fn(),
			showStatus,
			showExtensionConfirm,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError,
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			switchToForkedSession: vi.fn(async () => ({ cancelled: false })),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, "/import /tmp/missing-session.jsonl");

		expect(showError).toHaveBeenCalledWith("Failed to import session: File not found: /tmp/missing-session.jsonl");
		expect(showStatus).not.toHaveBeenCalled();
		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode /import with a missing session cwd (earendil-works/pi#11060)", () => {
	const missingCwd = new MissingSessionCwdError({ sessionCwd: "/renamed-from", fallbackCwd: "/renamed-to" });

	function missingCwdContext(
		choice: MissingSessionCwdChoice | undefined,
		overrides: Partial<ImportCommandContext> = {},
	) {
		const importFromJsonl = vi.fn(async (_path: string, cwdOverride?: string) => {
			if (cwdOverride === undefined) throw missingCwd;
			return { cancelled: false };
		});
		const showStatus = vi.fn();
		const switchToForkedSession = vi.fn(async () => ({ cancelled: false }));
		const renderCurrentSessionState = vi.fn();
		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			runtimeHost: { importFromJsonl, takeResumeNotices: () => [] },
			sessionManager: sessionWithoutRestores(),
			showError: vi.fn(),
			showWarning: vi.fn(),
			showStatus,
			showExtensionConfirm: vi.fn(async () => true),
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState,
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => choice),
			switchToForkedSession,
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
			...overrides,
		};
		return { context, importFromJsonl, showStatus, switchToForkedSession, renderCurrentSessionState };
	}

	it("prompts with the missing-cwd error", async () => {
		const { context } = missingCwdContext(undefined);

		await interactiveModePrototype.handleImportCommand.call(context, "/import exported.jsonl");

		expect(context.promptForMissingSessionCwd).toHaveBeenCalledWith(missingCwd);
	});

	it("continues the import in the current cwd", async () => {
		const { context, importFromJsonl, showStatus, switchToForkedSession, renderCurrentSessionState } =
			missingCwdContext("continue");

		await interactiveModePrototype.handleImportCommand.call(context, "/import exported.jsonl");

		expect(importFromJsonl.mock.calls).toEqual([["exported.jsonl"], ["exported.jsonl", "/renamed-to"]]);
		expect(switchToForkedSession).not.toHaveBeenCalled();
		expect(renderCurrentSessionState).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Session imported from: exported.jsonl");
	});

	it("reports a cancelled continued import and does not show it as imported", async () => {
		const { context, importFromJsonl, showStatus, renderCurrentSessionState } = missingCwdContext("continue");
		importFromJsonl.mockRejectedValueOnce(missingCwd).mockResolvedValueOnce({ cancelled: true });

		await interactiveModePrototype.handleImportCommand.call(context, "/import exported.jsonl");

		expect(showStatus.mock.calls).toEqual([["Import cancelled"]]);
		expect(renderCurrentSessionState).not.toHaveBeenCalled();
	});

	it("forks the export into the current cwd without importing it", async () => {
		const { context, importFromJsonl, showStatus, switchToForkedSession } = missingCwdContext("fork");

		await interactiveModePrototype.handleImportCommand.call(context, "/import exported.jsonl");

		expect(switchToForkedSession).toHaveBeenCalledWith({ exportPath: "exported.jsonl" }, "/renamed-to");
		expect(importFromJsonl.mock.calls).toEqual([["exported.jsonl"]]);
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("reports an import cancelled by an extension after the fork", async () => {
		const { context, showStatus, switchToForkedSession } = missingCwdContext("fork");
		switchToForkedSession.mockResolvedValueOnce({ cancelled: true });

		await interactiveModePrototype.handleImportCommand.call(context, "/import exported.jsonl");

		expect(showStatus.mock.calls).toEqual([["Import cancelled"]]);
	});

	it("cancels without importing or forking", async () => {
		const { context, importFromJsonl, showStatus, switchToForkedSession } = missingCwdContext(undefined);

		await interactiveModePrototype.handleImportCommand.call(context, "/import exported.jsonl");

		expect(importFromJsonl.mock.calls).toEqual([["exported.jsonl"]]);
		expect(switchToForkedSession).not.toHaveBeenCalled();
		expect(showStatus.mock.calls).toEqual([["Import cancelled"]]);
	});
});
