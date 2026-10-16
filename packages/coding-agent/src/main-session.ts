import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { ProcessTerminal, setCapabilityOverrides, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { Args } from "./cli/args.ts";
import { selectSession } from "./cli/session-picker.ts";
import { getAgentDir } from "./config.js";
import { KeybindingsManager } from "./core/keybindings.ts";
import { formatMissingSessionCwdPrompt, type SessionCwdIssue } from "./core/session-cwd.ts";
import { assertValidSessionId, SessionManager } from "./core/session-manager.ts";
import { classifiedWorkflowMetadata, workflowSessionMetadataFromEnv } from "./core/session-manager-classification.ts";
import { getDefaultSessionDirPath } from "./core/session-manager-paths.ts";
import type { SettingsManager } from "./core/settings-manager.ts";
import { JsonlSessionStore } from "./core/storage/session/jsonl-session-store.js";
import { ExtensionSelectorComponent } from "./modes/interactive/components/extension-selector.ts";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.js";
import { resolveSessionIdTargetAcrossScopes } from "./session-id-target.js";
import { resolvePath } from "./utils/paths.ts";

type ResolvedSession =
	| { type: "local" | "global"; id: string; directory: string; cwd: string }
	| { type: "error"; message: string }
	| { type: "not_found"; arg: string };

async function findLocalSessionByExactId(sessionId: string, cwd: string, sessionDir?: string) {
	const directory = sessionDir ?? getDefaultSessionDirPath(cwd);
	const store = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
	try {
		const header = await store.readHeader(sessionId);
		return header && !classifiedWorkflowMetadata(header) && resolvePath(header.cwd) === resolvePath(cwd)
			? { id: header.id, directory }
			: undefined;
	} finally {
		await store.close();
	}
}

async function resolveSessionId(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	const localSessions = await SessionManager.list(cwd, sessionDir, undefined, { includeInternal: true });
	const resolution = await resolveSessionIdTargetAcrossScopes(sessionArg, localSessions, () =>
		SessionManager.listAll(sessionDir, undefined, { includeInternal: true }),
	);
	if (resolution.kind === "exact" || resolution.kind === "unique_prefix") {
		return {
			type: resolution.scope,
			id: resolution.session.id,
			directory: dirname(resolution.session.path),
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
	sessionDir?: string,
	sessionId?: string,
	sourceDirectory?: string,
): Promise<SessionManager> {
	try {
		const store = await JsonlSessionStore.open(sourceDirectory ?? getDefaultSessionDirPath(cwd), {
			exactDirectory: true,
			scanExisting: false,
		});
		const source = await SessionManager.open(store, sourceId);
		return await source.forkTo(cwd, sessionDir, { id: sessionId });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

async function openSessionOrExit(sessionId: string, directory: string, exactDirectory = true): Promise<SessionManager> {
	try {
		const store = await JsonlSessionStore.open(directory, { exactDirectory, scanExisting: false });
		return await SessionManager.open(store, sessionId);
	} catch (error: unknown) {
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

export async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
): Promise<SessionManager> {
	validateImportFlags(parsed);
	if (parsed.noSession) {
		const manager = SessionManager.inMemory(
			cwd,
			parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined,
		);
		return parsed.import !== undefined ? manager.importFromJsonl(resolvePath(parsed.import, cwd)) : manager;
	}
	if (parsed.import !== undefined)
		return SessionManager.importFromJsonl(resolvePath(parsed.import, cwd), cwd, sessionDir);

	if (parsed.fork !== undefined) {
		if (parsed.sessionId !== undefined) {
			const existingTarget = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
			if (existingTarget) {
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionId(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "local":
			case "global":
				return forkSessionOrExit(resolved.id, cwd, sessionDir, parsed.sessionId, resolved.directory);
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
		const resolved = await resolveSessionId(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			case "local":
				return openSessionOrExit(resolved.id, resolved.directory);

			case "global": {
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.id, cwd, sessionDir, undefined, resolved.directory);
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
				(onProgress) => SessionManager.list(cwd, sessionDir, onProgress),
				(onProgress) => SessionManager.listAll(sessionDir, onProgress),
				settingsManager,
			);
			if (selected === null) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return openSessionOrExit(selected.id, dirname(selected.path));
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		return await SessionManager.continueRecent(cwd, sessionDir);
	}

	if (parsed.sessionId !== undefined) {
		const existingSession = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
		if (existingSession) {
			return openSessionOrExit(existingSession.id, existingSession.directory);
		}
		console.error(chalk.yellow(`No session found with id '${parsed.sessionId}'; creating a new session.`));
	}

	return await SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
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
