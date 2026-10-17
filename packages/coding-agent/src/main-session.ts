import { createInterface } from "node:readline";
import { ProcessTerminal, setCapabilityOverrides, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { Args } from "./cli/args.ts";
import { selectSession } from "./cli/session-picker.ts";
import { getAgentDir } from "./config.js";
import { KeybindingsManager } from "./core/keybindings.ts";
import { formatMissingSessionCwdPrompt, type SessionCwdIssue } from "./core/session-cwd.ts";
import { ownedSessionManagerStores } from "./core/session-lifecycle-work.ts";
import { assertValidSessionId, SessionManager } from "./core/session-manager.ts";
import { classifiedWorkflowMetadata, workflowSessionMetadataFromEnv } from "./core/session-manager-classification.ts";
import { resolveSessionStore, selectSessionStorage } from "./core/session-storage.js";
import type { SettingsManager } from "./core/settings-manager.ts";
import { type StorageSelection, storageSelectionKey } from "./core/storage/provider.js";
import type { SessionStore } from "./core/storage/session/types.js";
import { ExtensionSelectorComponent } from "./modes/interactive/components/extension-selector.ts";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.js";
import { resolveSessionIdTargetAcrossScopes } from "./session-id-target.js";
import { resolvePath } from "./utils/paths.ts";

type ResolvedSession =
	| { type: "local" | "global"; id: string; cwd: string }
	| { type: "error"; message: string }
	| { type: "not_found"; arg: string };

async function findLocalSessionByExactId(sessionId: string, cwd: string, store: SessionStore) {
	const header = await store.readHeader(sessionId);
	return header && !classifiedWorkflowMetadata(header) && resolvePath(header.cwd) === resolvePath(cwd)
		? { id: header.id }
		: undefined;
}

async function resolveSessionId(sessionArg: string, cwd: string, store: SessionStore): Promise<ResolvedSession> {
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
	});
	try {
		const manager = await createSessionManagerWithStore(parsed, cwd, settingsManager, store);
		if (store !== sessionStore) ownedSessionManagerStores.set(manager, store);
		const selection = selectSessionStorage(cwd, {
			sessionStore,
			settings: settingsManager.getSettings(),
			noSession: parsed.noSession,
			sessionDir: parsed.sessionDir ?? sessionDir,
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
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session !== undefined) {
		const resolved = await resolveSessionId(parsed.session, cwd, store);

		switch (resolved.type) {
			case "local":
				return openSessionOrExit(resolved.id, store);

			case "global": {
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
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
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
				store.descriptor.adapter === "jsonl" ? undefined : (id) => store.delete(id),
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

export async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
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
			formatMissingSessionCwdPrompt(issue),
			["Continue", "Cancel"],
			(option) => finish(option === "Continue" ? issue.fallbackCwd : undefined),
			() => finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
	});
}
