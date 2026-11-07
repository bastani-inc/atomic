import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { ProcessTerminal, setCapabilityOverrides, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { Args } from "./cli/args.ts";
import { selectSession } from "./cli/session-picker.ts";
import { getAgentDir } from "./config.js";
import { KeybindingsManager } from "./core/keybindings.ts";
import {
	RESUME_CATALOG_TIMEOUT_MS,
	resumeLookupError,
	resumeNotFoundError,
	withResumeLookupDeadline,
} from "./core/resume/not-found.ts";
import { checkResumeStoragePreconditions, type ResumePreflightIo } from "./core/resume/preflight.ts";
import {
	type DirtyCheckoutChoice,
	type DirtyCheckoutPrompt,
	prepareSessionResume,
	type ResumeNotice,
	sessionResumeOptions,
} from "./core/resume/session-resume.ts";
import { formatMissingSessionCwdPrompt, type SessionCwdIssue } from "./core/session-cwd.ts";
import { ownedSessionManagerStores } from "./core/session-lifecycle-work.ts";
import { assertValidSessionId, SessionManager } from "./core/session-manager.ts";
import { classifiedWorkflowMetadata, workflowSessionMetadataFromEnv } from "./core/session-manager-classification.ts";
import { resolveSessionStore, selectSessionStorage } from "./core/session-storage.js";
import { sessionContinuesIn, sessionRunsInRecordedCheckout } from "./core/session-worktree-snapshots.ts";
import type { DefaultProjectTrust, SettingsManager } from "./core/settings-manager.ts";
import { type StorageSelection, storageSelectionKey } from "./core/storage/provider.js";
import type { SessionStore } from "./core/storage/session/types.js";
import type { ProjectTrustStore } from "./core/trust-manager.ts";
import type { AppMode } from "./main-app-mode.ts";
import { ExtensionSelectorComponent } from "./modes/interactive/components/extension-selector.ts";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.js";
import { resolveSessionIdTargetAcrossScopes } from "./session-id-target.js";
import { createSessionCwdMatcher, resolvePath } from "./utils/paths.ts";

type ResolvedSession =
	| { type: "local" | "global"; id: string; cwd: string }
	| { type: "error"; message: string }
	| { type: "not_found"; arg: string };

/** The `--resume` picker's delete: the id is checked before the store is touched (#4326). */
export async function deleteSessionFromPicker(store: SessionStore, id: string): Promise<void> {
	assertValidSessionId(id);
	await store.delete(id);
}

async function findLocalSessionByExactId(sessionId: string, cwd: string, store: SessionStore) {
	const header = await store.readHeader(sessionId);
	return header &&
		!classifiedWorkflowMetadata(header) &&
		createSessionCwdMatcher(resolvePath(cwd))(resolvePath(header.cwd))
		? { id: header.id, cwd: header.cwd }
		: undefined;
}

async function resolveSessionId(sessionArg: string, cwd: string, store: SessionStore): Promise<ResolvedSession> {
	const exact = await findLocalSessionByExactId(sessionArg, cwd, store).catch(() => undefined);
	if (exact) return { type: "local", id: exact.id, cwd: exact.cwd };
	const localSessions = await SessionManager.list(cwd, store, undefined, { includeInternal: true });
	const resolution = await resolveSessionIdTargetAcrossScopes(sessionArg, localSessions, () =>
		SessionManager.listAll(store, undefined, { includeInternal: true }),
	);
	if (resolution.kind === "exact" || resolution.kind === "unique_prefix") {
		return {
			type: resolution.scope,
			id: resolution.session.id,
			cwd: resolution.session.cwd,
		};
	}
	if (resolution.kind === "ambiguous" || resolution.kind === "malformed") {
		return { type: "error", message: resolution.message };
	}
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

export class SessionSelectorConflictError extends Error {
	readonly code = "SessionSelectorConflict";
	readonly conflictingFlags: readonly string[];

	constructor(conflictingFlags: readonly string[]) {
		super(
			`--import cannot be combined with ${conflictingFlags.join(", ")}. Use --import alone, optionally with --no-session or --session-dir.`,
		);
		this.name = "SessionSelectorConflictError";
		this.conflictingFlags = conflictingFlags;
	}
}

export function validateImportFlags(parsed: Args): void {
	if (parsed.import === undefined) return;
	const conflictingFlags = [
		parsed.session !== undefined ? "--session" : undefined,
		parsed.fork !== undefined ? "--fork" : undefined,
		parsed.sessionId !== undefined ? "--session-id" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
	].filter((flag): flag is string => flag !== undefined);
	if (conflictingFlags.length > 0) throw new SessionSelectorConflictError(conflictingFlags);
}

export function validateForkFlags(parsed: Args): void {
	if (parsed.fork === undefined) return;

	const conflictingFlags = [
		parsed.session !== undefined ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

export function validateSessionIdFlags(parsed: Args): void {
	if (parsed.sessionId === undefined) return;

	const conflictingFlags = [
		parsed.session !== undefined ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}

	try {
		assertValidSessionId(parsed.sessionId);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}
async function forkSessionOrExit(
	sourceId: string,
	cwd: string,
	store: SessionStore,
	sessionId?: string,
): Promise<SessionManager> {
	try {
		const source = await SessionManager.open(store, sourceId);
		return await source.forkTo(cwd, store, { id: sessionId });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

async function openSessionOrExit(sessionId: string, store: SessionStore): Promise<SessionManager> {
	try {
		return await SessionManager.open(store, sessionId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

export async function applyInheritedWorkflowSessionClassification(
	sessionManager: SessionManager,
	env: Record<string, string | undefined> = process.env,
): Promise<SessionManager> {
	const metadata = workflowSessionMetadataFromEnv(env);
	if (metadata) await sessionManager.markSessionInternal(metadata);
	return sessionManager;
}

const initialStorageKeys = new WeakMap<SessionManager, string>();
const provisionalSessions = new WeakSet<SessionManager>();

async function createProvisionalSession(store: SessionStore, cwd: string, id?: string): Promise<SessionManager> {
	const manager = await SessionManager.create(store, cwd, { id });
	provisionalSessions.add(manager);
	return manager;
}

/** Finalize a CLI-owned provisional store after trusted settings become available. */
export async function refreshSessionStorage(
	manager: SessionManager,
	parsed: Args,
	settingsManager: SettingsManager,
	sessionStore?: SessionStore | StorageSelection,
): Promise<SessionStore | undefined> {
	// An opened conversation belongs to the store that supplied it, even when its
	// project's newly trusted settings select a different store for new sessions.
	if (!provisionalSessions.has(manager) || manager.getEntries().length > 0) return undefined;
	const options = {
		sessionStore,
		settings: settingsManager.getSettings(),
		noSession: parsed.noSession,
		sessionDir: parsed.sessionDir,
		sessionStorePath: parsed.sessionStorePath,
		sessionPrefix: parsed.sessionPrefix,
	};
	const selection = selectSessionStorage(manager.getCwd(), options);
	if ("load" in selection) return undefined;
	const key = storageSelectionKey(selection, getAgentDir());
	const initialKey = initialStorageKeys.get(manager);
	if (initialKey === undefined || key === initialKey) return undefined;
	const previous = manager.getSessionStore();
	const next = await resolveSessionStore(manager.getCwd(), options);
	try {
		await manager.rebindStore(next, true);
	} catch (error) {
		await next.close();
		throw error;
	}
	initialStorageKeys.set(manager, key);
	ownedSessionManagerStores.set(manager, next);
	await previous.close();
	return next;
}

export async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
	sessionStore?: SessionStore | StorageSelection,
): Promise<SessionManager> {
	validateImportFlags(parsed);
	const store = await resolveSessionStore(cwd, {
		sessionStore,
		settings: settingsManager.getSettings(),
		noSession: parsed.noSession,
		sessionDir: parsed.sessionDir ?? sessionDir,
		sessionStorePath: parsed.sessionStorePath,
		sessionPrefix: parsed.sessionPrefix,
	});
	try {
		const manager = await createSessionManagerWithStore(parsed, cwd, settingsManager, store);
		if (store !== sessionStore) ownedSessionManagerStores.set(manager, store);
		const selection = selectSessionStorage(cwd, {
			sessionStore,
			settings: settingsManager.getSettings(),
			noSession: parsed.noSession,
			sessionDir: parsed.sessionDir ?? sessionDir,
			sessionStorePath: parsed.sessionStorePath,
			sessionPrefix: parsed.sessionPrefix,
		});
		if (!("load" in selection)) initialStorageKeys.set(manager, storageSelectionKey(selection, getAgentDir()));
		return manager;
	} catch (error) {
		if (store !== sessionStore) await store.close();
		throw error;
	}
}

async function createSessionManagerWithStore(
	parsed: Args,
	cwd: string,
	settingsManager: SettingsManager,
	store: SessionStore,
): Promise<SessionManager> {
	if (parsed.import !== undefined) return SessionManager.importFromJsonl(resolvePath(parsed.import, cwd), cwd, store);
	if (parsed.noSession) return createProvisionalSession(store, cwd, parsed.sessionId);

	if (parsed.fork !== undefined) {
		if (parsed.sessionId !== undefined) {
			const existingTarget = await findLocalSessionByExactId(parsed.sessionId, cwd, store);
			if (existingTarget) {
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionId(parsed.fork, cwd, store);

		switch (resolved.type) {
			case "local":
			case "global":
				return forkSessionOrExit(resolved.id, cwd, store, parsed.sessionId);
			case "error":
				console.error(chalk.red(`Error: ${resolved.message}`));
				process.exit(1);
				throw new Error("unreachable");

			case "not_found":
				console.error(chalk.red(`Error: ${resumeNotFoundError(resolved.arg, store.descriptor).message}`));
				process.exit(1);
		}
	}

	if (parsed.session !== undefined) {
		const resolved = await resolveSessionId(parsed.session, cwd, store);

		switch (resolved.type) {
			case "local":
				return openSessionOrExit(resolved.id, store);

			case "global": {
				const recordedOnAnotherNode = !existsSync(resolved.cwd);
				if (
					recordedOnAnotherNode ||
					(await sessionContinuesIn(store, resolved.id, cwd)) ||
					(settingsManager.getWorktreeSnapshotSettings().enabled &&
						(await sessionRunsInRecordedCheckout(store, resolved.id)))
				) {
					return openSessionOrExit(resolved.id, store);
				}
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.id, cwd, store);
			}
			case "error":
				console.error(chalk.red(`Error: ${resolved.message}`));
				process.exit(1);
				throw new Error("unreachable");

			case "not_found":
				console.error(chalk.red(`Error: ${resumeNotFoundError(resolved.arg, store.descriptor).message}`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		initTheme(settingsManager.getTheme(), true);
		try {
			const selected = await selectSession(
				(onProgress) => SessionManager.list(cwd, store, onProgress),
				(onProgress) => SessionManager.listAll(store, onProgress),
				settingsManager,
				store.descriptor.adapter === "jsonl" ? undefined : (id) => deleteSessionFromPicker(store, id),
			);
			if (selected === null) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return openSessionOrExit(selected.id, store);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		const recent = await store.findMostRecent({ cwd: resolvePath(cwd) });
		return recent ? SessionManager.open(store, recent.id) : createProvisionalSession(store, cwd);
	}

	if (parsed.sessionId !== undefined) {
		const existingSession = await findLocalSessionByExactId(parsed.sessionId, cwd, store);
		if (existingSession) {
			return openSessionOrExit(existingSession.id, store);
		}
		console.error(chalk.yellow(`No session found with id '${parsed.sessionId}'; creating a new session.`));
	}

	return createProvisionalSession(store, cwd, parsed.sessionId);
}

function promptStartupSelector(
	title: string,
	options: readonly string[],
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	initTheme(settingsManager.getTheme());
	setKeybindings(KeybindingsManager.create());

	return new Promise((resolve) => {
		const ui = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), getAgentDir());
		ui.setClearOnShrink(settingsManager.getClearOnShrink());

		let settled = false;
		const finish = (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			title,
			[...options],
			(option) => finish(option),
			() => finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
	});
}

export async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	const option = await promptStartupSelector(
		formatMissingSessionCwdPrompt(issue),
		["Continue", "Cancel"],
		settingsManager,
	);
	return option === "Continue" ? issue.fallbackCwd : undefined;
}

const DIRTY_CHECKOUT_OPTIONS: readonly (readonly [string, DirtyCheckoutChoice])[] = [
	["Restore the snapshot into a fresh worktree", "restore"],
	["Continue in this checkout as it is", "use"],
	["Cancel", "cancel"],
];

/** Asks what to do when a resume started in a checkout of the session's repository that differs from its snapshot. */
export async function promptForDirtyCheckout(
	prompt: DirtyCheckoutPrompt,
	settingsManager: SettingsManager,
): Promise<DirtyCheckoutChoice> {
	const option = await promptStartupSelector(
		`This checkout differs from the session's snapshot ${prompt.snapshotId.slice(0, 12)}\n${prompt.checkout}\n\nrecorded in\n${prompt.recordedRoot}`,
		DIRTY_CHECKOUT_OPTIONS.map(([label]) => label),
		settingsManager,
	);
	return DIRTY_CHECKOUT_OPTIONS.find(([label]) => label === option)?.[1] ?? "cancel";
}

/** The storage selection a CLI resume reads sessions from, or undefined when an SDK store instance was given. */
export function cliSessionStorageSelection(
	parsed: Args,
	cwd: string,
	settingsManager: SettingsManager,
	sessionStore?: SessionStore | StorageSelection,
): StorageSelection | undefined {
	const selection = selectSessionStorage(cwd, {
		sessionStore,
		settings: settingsManager.getSettings(),
		noSession: parsed.noSession,
		sessionDir: parsed.sessionDir,
		sessionStorePath: parsed.sessionStorePath,
		sessionPrefix: parsed.sessionPrefix,
	});
	return "load" in selection ? undefined : selection;
}

/** An id no session has, for probing storage when the resume names none. */
const PROBE_SESSION_ID = "00000000-0000-7000-8000-000000000000";

/** One point read through `selection`, proving the shared storage answers before the real lookup starts. */
async function probeSessionStorage(
	cwd: string,
	selection: StorageSelection,
	agentDir: string,
	sessionId: string | undefined,
): Promise<void> {
	const store = await resolveSessionStore(cwd, { agentDir, sessionStore: selection });
	try {
		await store.readHeader(sessionId ?? PROBE_SESSION_ID);
	} finally {
		await store.close();
	}
}

export interface OpenCliSessionOptions {
	readonly agentDir: string;
	/** How long the lookup waits for shared storage to answer. Default {@link RESUME_CATALOG_TIMEOUT_MS}. */
	readonly catalogTimeoutMs?: number;
	readonly sessionStorage?: SessionStore | StorageSelection;
	/** Whether the project at a restored worktree is trusted, which its `.atomic/setup` hook requires. */
	readonly trusted: (worktree: string) => boolean;
	readonly chooseDirtyCheckout?: (prompt: DirtyCheckoutPrompt) => Promise<DirtyCheckoutChoice>;
	readonly io?: ResumePreflightIo;
}

export interface OpenedCliSession {
	readonly sessionManager: SessionManager;
	readonly notices: readonly ResumeNotice[];
}

/**
 * Opens the session the CLI flags select and, for a resume, prepares its checkout on this machine. A resume
 * (`--session`, `--resume`, `--continue`) first checks its storage preconditions, and a lookup that cannot reach the
 * storage fails as {@link ResumeCatalogUnavailableError}. Returns "cancelled" when the user cancels at a prompt. When it
 * fails or is cancelled after opening the session store it selected, that store is closed again.
 */
export async function openCliSession(
	parsed: Args,
	cwd: string,
	settingsManager: SettingsManager,
	options: OpenCliSessionOptions,
): Promise<OpenedCliSession | "cancelled"> {
	const resuming = parsed.session !== undefined || parsed.resume === true || parsed.continue === true;
	const selection = resuming
		? cliSessionStorageSelection(parsed, cwd, settingsManager, options.sessionStorage)
		: undefined;
	if (selection !== undefined) {
		await checkResumeStoragePreconditions("cli", [{ domain: "sessions", selection }], options.agentDir, options.io);
	}
	if (selection?.kind === "adapter") {
		await withResumeLookupDeadline(
			probeSessionStorage(cwd, selection, options.agentDir, parsed.session),
			{ subject: "session", id: parsed.session ?? null, storage: selection.module },
			options.catalogTimeoutMs ?? RESUME_CATALOG_TIMEOUT_MS,
		).catch((error: unknown) => {
			throw resumeLookupError(error, "session", parsed.session ?? null);
		});
	}
	const sessionManager = await createSessionManager(
		parsed,
		cwd,
		undefined,
		settingsManager,
		options.sessionStorage,
	).catch((error: unknown) => {
		throw resuming ? resumeLookupError(error, "session", parsed.session ?? null) : error;
	});
	const owned = options.sessionStorage === undefined || !("load" in options.sessionStorage);
	const release = (failure?: unknown) =>
		owned ? closeStoreAfter(sessionManager.getSessionStore(), failure) : undefined;
	const prepared = await prepareSessionResume(sessionManager, {
		...sessionResumeOptions("cli", cwd, options.agentDir, settingsManager, options.trusted),
		chooseDirtyCheckout: options.chooseDirtyCheckout,
		io: options.io,
	}).catch(async (error: unknown) => {
		await release(error);
		throw error;
	});
	if (prepared.status === "cancelled") {
		await release();
		return "cancelled";
	}
	return { sessionManager: prepared.sessionManager, notices: prepared.notices };
}

/**
 * The resume notices print-like modes report with the startup diagnostics. Interactive mode shows them in the TUI
 * instead, so they are not reported twice.
 */
export function startupResumeDiagnostics(appMode: AppMode, notices: readonly ResumeNotice[]): readonly ResumeNotice[] {
	return appMode === "interactive" ? [] : notices;
}

/**
 * Closes `store` once the work that opened it ended. After `failure`, a close failure is kept as the failure's
 * `cleanupCause` instead of replacing it; without one, it is thrown.
 */
export async function closeStoreAfter(store: Pick<SessionStore, "close">, failure?: unknown): Promise<void> {
	try {
		await store.close();
	} catch (cleanup) {
		if (failure === undefined) throw cleanup;
		if (failure instanceof Error)
			Object.defineProperty(failure, "cleanupCause", { value: cleanup, enumerable: false });
	}
}

/**
 * Whether the CLI trusts the project at a restored worktree, which its `.atomic/setup` hook requires: the
 * `--approve`/`--deny` override, else the saved decision for that path, else the default trust setting.
 */
export function cliResumeTrust(
	override: boolean | undefined,
	trustStore: Pick<ProjectTrustStore, "get">,
	defaultTrust: DefaultProjectTrust,
): (worktree: string) => boolean {
	return (worktree) => override ?? trustStore.get(worktree) ?? defaultTrust === "always";
}
