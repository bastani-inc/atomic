import { createCacheMissModelSource, formatCacheWaste } from "../../core/cache-stats.ts";
import { formatResumeTimings, latestResumeTimings } from "../../core/resume/timings.ts";
import {
	readSessionUsageDetails,
	type SessionUsageDetails,
	sessionUsageDetails,
} from "../../core/session-usage-details.ts";
import {
	compareWorktreeSnapshot,
	currentWorktreeSnapshots,
	describeExportedSnapshots,
	describeLastCapture,
	describeSnapshotExport,
	describeWorktreeRestoreStatus,
	describeWorktreeSnapshot,
	worktreeRestoreNotices,
} from "../../core/session-worktree-snapshots.ts";
import { parseSlashCommand } from "../../core/slash-commands.js";
import { formatToolStatus, type ToolStatusReport } from "../../core/tool-status.js";
import { isGitUnavailableError, isWorkspaceError } from "../../core/worktree-snapshot/errors.ts";
import { createChildProcessEnvironment } from "../../utils/child-process.ts";
import { getEngineSessionStats } from "../interactive-engine/engine-session-stats.js";
import { IsolatedInteractiveRuntime } from "../interactive-engine/isolated-runtime.js";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	BorderedLoader,
	type Component,
	Container,
	copyToClipboard,
	DynamicBorder,
	fs,
	getChangelogPath,
	getShareViewerUrl,
	hyperlink,
	MissingSessionCwdError,
	normalizeChangelogLinks,
	os,
	parseChangelogAsync,
	path,
	SessionImportFileNotFoundError,
	Spacer,
	setRegisteredThemes,
	spawn,
	Text,
	theme,
} from "./interactive-mode-deps.ts";
import { isExpandable } from "./interactive-mode-helpers.ts";
import { showRestartExtensionErrors } from "./interactive-session-runtime.ts";
import { showSessionNotices } from "./session-notices.ts";

InteractiveModeBase.prototype.handleReloadCommand = async function (this: InteractiveModeBase): Promise<void> {
	if (this.session.isStreaming) {
		this.showWarning("Wait for the current response to finish before reloading.");
		return;
	}
	if (this.compactionActive) {
		this.showWarning("Wait for compaction to finish before reloading.");
		return;
	}

	this.resetExtensionUI();

	const reloadBox = new Container();
	const borderColor = (s: string) => theme.fg("border", s);
	reloadBox.addChild(new DynamicBorder(borderColor));
	reloadBox.addChild(new Spacer(1));
	reloadBox.addChild(
		new Text(theme.fg("muted", "Reloading keybindings, extensions, skills, prompts, themes..."), 1, 0),
	);
	reloadBox.addChild(new Spacer(1));
	reloadBox.addChild(new DynamicBorder(borderColor));

	const previousEditor = this.editor;
	this.editorContainer.clear();
	this.editorContainer.addChild(reloadBox);
	this.ui.setFocus(reloadBox);
	this.ui.requestRender(true);
	await new Promise((resolve) => process.nextTick(resolve));

	const dismissReloadBox = (editor: Component) => {
		this.editorContainer.clear();
		this.editorContainer.addChild(editor);
		this.ui.setFocus(editor);
		this.ui.requestRender();
	};

	try {
		if (this.runtimeHost instanceof IsolatedInteractiveRuntime) await this.session.reload();
		else await this.reloadCoordinator.reload(this.session);
		const activeHeader = this.customHeader ?? this.builtInHeader;
		if (isExpandable(activeHeader)) {
			activeHeader.setExpanded(this.toolOutputExpanded);
		}
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.applyRuntimeSettings();
		await this.themeController.applyFromSettings();
		this.setupAutocompleteProvider();
		const runner = this.session.extensionRunner;
		this.setupExtensionShortcuts(runner);
		this.rebuildChatFromMessages({ resetStartupDisclosure: true });
		dismissReloadBox(this.editor as Component);
		const savedImplicitProjectTrust = await this.maybeSaveImplicitProjectTrustAfterReload();
		this.showLoadedResources({
			force: false,
			showDiagnosticsWhenQuiet: true,
		});
		showRestartExtensionErrors(this);
		if (savedImplicitProjectTrust) {
			this.showStatus("Saved project trust for future sessions");
		}
		const modelsJsonError = this.session.modelRuntime.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}
		this.showStatus("Reloaded keybindings, extensions, skills, prompts, themes");
	} catch (error) {
		showRestartExtensionErrors(this);
		dismissReloadBox(previousEditor as Component);
		this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
	}
};

InteractiveModeBase.prototype.handleExportCommand = async function (
	this: InteractiveModeBase,
	text: string,
): Promise<void> {
	const outputPath = this.getPathCommandArgument(text, "/export");

	try {
		if (outputPath?.endsWith(".jsonl")) {
			const filePath = await this.session.exportToJsonl(outputPath);
			this.showStatus(`Session exported to: ${filePath}`);
			// A session holding only its window states what the file carries from the file (#5554).
			const contents =
				this.sessionManager.hasFullHistory?.() === false
					? await describeExportedSnapshots(filePath)
					: describeSnapshotExport(
							this.sessionManager.getBranch(),
							this.sessionManager.getWorktreeSnapshotRecords(),
						);
			if (contents) this.showStatus(contents);
		} else {
			const filePath = await this.session.exportToHtml(outputPath, { themeName: theme.name });
			this.showStatus(`Session exported to: ${filePath}`);
		}
	} catch (error: unknown) {
		this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
};

InteractiveModeBase.prototype.getPathCommandArgument = function (
	this: InteractiveModeBase,
	text: string,
	command: "/export" | "/import",
): string | undefined {
	const { name, args } = parseSlashCommand(text);
	if (`/${name}` !== command) {
		return undefined;
	}

	const argsString = args.trimStart();
	if (!argsString) {
		return undefined;
	}

	const firstChar = argsString[0];
	if (firstChar === '"' || firstChar === "'") {
		const closingQuoteIndex = argsString.indexOf(firstChar, 1);
		if (closingQuoteIndex < 0) {
			return undefined;
		}
		return argsString.slice(1, closingQuoteIndex);
	}

	const firstWhitespaceIndex = argsString.search(/\s/);
	if (firstWhitespaceIndex < 0) {
		return argsString;
	}
	return argsString.slice(0, firstWhitespaceIndex);
};

InteractiveModeBase.prototype.handleImportCommand = async function (
	this: InteractiveModeBase,
	text: string,
): Promise<void> {
	const inputPath = this.getPathCommandArgument(text, "/import");
	if (!inputPath) {
		this.showError("Usage: /import <path.jsonl>");
		return;
	}

	const confirmed = await this.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
	if (!confirmed) {
		this.showStatus("Import cancelled");
		return;
	}

	const importStartedAt = new Date().toISOString();
	const finishSuccessfulImport = () => {
		this.renderCurrentSessionState();
		if (this.firstRunNoticeVisible) {
			this.clearFirstRunOnboardingUi();
		}
		this.showStatus(`Session imported from: ${inputPath}`);
		showSessionNotices(this, [
			...worktreeRestoreNotices(this.sessionManager, importStartedAt),
			...this.runtimeHost.takeResumeNotices(),
		]);
	};

	try {
		InteractiveModeBase.prototype.clearWorkingLoader.call(this);
		const result = await this.runtimeHost.importFromJsonl(inputPath);
		if (result.cancelled) {
			this.showStatus("Import cancelled");
			return;
		}
		finishSuccessfulImport();
	} catch (error: unknown) {
		if (error instanceof MissingSessionCwdError) {
			switch (await this.promptForMissingSessionCwd(error)) {
				case "continue": {
					const result = await this.runtimeHost.importFromJsonl(inputPath, error.issue.fallbackCwd);
					if (result.cancelled) {
						this.showStatus("Import cancelled");
						return;
					}
					finishSuccessfulImport();
					return;
				}
				case "fork": {
					const result = await this.switchToForkedSession({ exportPath: inputPath }, error.issue.fallbackCwd);
					if (result.cancelled) this.showStatus("Import cancelled");
					return;
				}
				case undefined:
					this.showStatus("Import cancelled");
					return;
			}
		}
		if (error instanceof SessionImportFileNotFoundError) {
			this.showError(`Failed to import session: ${error.message}`);
			return;
		}
		if (isWorkspaceError(error) || isGitUnavailableError(error)) {
			this.showError(error.message);
			return;
		}
		await this.handleFatalRuntimeError("Failed to import session", error);
	}
};

const GH_AUTH_STATUS_TIMEOUT_MS = 30_000;
/** How long a cancelled gh process gets to exit after it is asked to before it is killed. */
const GH_CANCEL_GRACE_MS = 2_000;

/** Stop a gh process the user cancelled: ask it to exit, and kill it if it is still running after the grace period. */
function stopGh(child: ReturnType<typeof spawn>): void {
	child.kill();
	const timer = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}, GH_CANCEL_GRACE_MS);
	timer.unref?.();
	child.once("close", () => clearTimeout(timer));
}

/** The session id in the header, the first line, of the exported session file `file`. */
async function exportedSessionId(file: string): Promise<string | undefined> {
	const handle = await fs.promises.open(file, "r");
	try {
		const { buffer, bytesRead } = await handle.read(Buffer.alloc(16_384), 0, 16_384, 0);
		const header = JSON.parse(buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0] ?? "") as { id?: unknown };
		return typeof header.id === "string" ? header.id : undefined;
	} catch {
		return undefined;
	} finally {
		await handle.close();
	}
}

/** Run `gh auth status`; `started` receives the child, so a cancel can stop it. */
function ghAuthStatus(started: (child: ReturnType<typeof spawn>) => void): Promise<number | null> {
	return new Promise((resolve) => {
		const child = spawn("gh", ["auth", "status"], {
			env: createChildProcessEnvironment(),
			stdio: "ignore",
			timeout: GH_AUTH_STATUS_TIMEOUT_MS,
		});
		started(child);
		child.once("error", () => resolve(null));
		child.once("close", (code) => resolve(code));
	});
}

InteractiveModeBase.prototype.handleShareCommand = async function (this: InteractiveModeBase): Promise<void> {
	// The session to share is the one shown when the command was given.
	const session = this.session;
	const sessionId = session.sessionManager.getSessionId();
	// The cancellable loader takes the prompt's place at once: checking gh and exporting the session take a while.
	const loader = new BorderedLoader(this.ui, theme, "Creating gist...");
	this.editorContainer.clear();
	this.editorContainer.addChild(loader);
	this.ui.setFocus(loader);
	this.ui.requestRender();

	let restored = false;
	const restoreEditor = () => {
		if (restored) return;
		restored = true;
		loader.dispose();
		// A view that has taken the loader's place since keeps it.
		if (!this.editorContainer.children.includes(loader)) return;
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	};

	// The gh process running now, which a cancel stops.
	let proc: ReturnType<typeof spawn> | undefined;
	loader.onAbort = () => {
		if (proc !== undefined) stopGh(proc);
		restoreEditor();
		this.showStatus("Share cancelled");
	};
	const cancelled = () => loader.signal.aborted;
	// Another session took this one's place before it was exported, or while it was: neither is shared.
	const sessionChanged = () => {
		restoreEditor();
		this.showStatus("Share cancelled: the session changed");
	};
	const replaced = () => {
		if (cancelled() || (this.session === session && session.sessionManager.getSessionId() === sessionId))
			return false;
		sessionChanged();
		return true;
	};

	// Each step is awaited before the next, also after a cancel, so the directory is removed only once nothing writes
	// into it any more.
	let tempDir: string | undefined;
	try {
		// Check if gh is available and logged in
		try {
			const status = await ghAuthStatus((child) => {
				proc = child;
			});
			proc = undefined;
			if (cancelled() || replaced()) return;
			if (status !== 0) {
				restoreEditor();
				this.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				return;
			}
		} catch {
			proc = undefined;
			if (cancelled()) return;
			restoreEditor();
			this.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		// Share an export-only JSONL copy carrying context for the viewer. The
		// persisted session is not mutated.
		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "atomic-share-"));
		if (cancelled() || replaced()) return;
		const tmpFile = path.join(tempDir, "session.jsonl");
		try {
			await session.exportToJsonl(tmpFile, {
				includeShareContext: true,
				snapshotContent: false,
				toolOutputContent: false,
			});
		} catch (error: unknown) {
			if (cancelled()) return;
			restoreEditor();
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}
		if (cancelled() || replaced()) return;
		// The file holds the session asked for, whatever changed on the way: another never leaves under its name.
		const exportedId = await exportedSessionId(tmpFile);
		if (cancelled()) return;
		if (exportedId !== sessionId) {
			sessionChanged();
			return;
		}

		// Create a secret gist
		try {
			const result = await new Promise<{
				stdout: string;
				stderr: string;
				code: number | null;
			}>((resolve) => {
				const child = spawn("gh", ["gist", "create", "--public=false", tmpFile], {
					env: createChildProcessEnvironment(),
				});
				proc = child;
				let stdout = "";
				let stderr = "";
				child.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				child.stderr?.on("data", (data) => {
					stderr += data.toString();
				});
				child.on("error", (error) => resolve({ stdout, stderr: stderr || error.message, code: null }));
				child.on("close", (code) => resolve({ stdout, stderr, code }));
			});
			proc = undefined;

			if (cancelled()) return;

			restoreEditor();

			if (result.code !== 0) {
				const errorMsg = result.stderr?.trim() || "Unknown error";
				this.showError(`Failed to create gist: ${errorMsg}`);
				return;
			}

			// Extract gist ID from the URL returned by gh
			// gh returns something like: https://gist.github.com/username/GIST_ID
			const gistUrl = result.stdout?.trim();
			const gistId = gistUrl?.split("/").pop();
			if (!gistId) {
				this.showError("Failed to parse gist ID from gh output");
				return;
			}

			// Create the preview URL
			const previewUrl = getShareViewerUrl(gistId);
			this.showStatus(`Share URL: ${hyperlink(previewUrl, previewUrl)}\nGist: ${hyperlink(gistUrl, gistUrl)}`);
		} catch (error: unknown) {
			proc = undefined;
			if (!cancelled()) {
				restoreEditor();
				this.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		}
	} finally {
		// Whatever ended the share, the prompt comes back once.
		restoreEditor();
		if (tempDir !== undefined) {
			await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {
				// Ignore cleanup errors
			});
		}
	}
};

InteractiveModeBase.prototype.handleCopyCommand = async function (this: InteractiveModeBase): Promise<void> {
	const text = this.session.getLastAssistantText();
	if (!text) {
		this.showError("No agent messages to copy yet.");
		return;
	}

	try {
		await copyToClipboard(text);
		this.showStatus("Copied last agent message to clipboard");
	} catch (error) {
		this.showError(error instanceof Error ? error.message : String(error));
	}
};

InteractiveModeBase.prototype.handleNameCommand = async function (
	this: InteractiveModeBase,
	text: string,
): Promise<void> {
	const name = text.replace(/^\/name\s*/, "").trim();
	if (!name) {
		const currentName = this.sessionManager.getSessionName();
		if (currentName) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
		} else {
			this.showWarning("Usage: /name <name>");
		}
		this.ui.requestRender();
		return;
	}

	await this.session.setSessionName(name);
	this.chatContainer.addChild(new Spacer(1));
	this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${name}`), 1, 0));
	this.ui.requestRender();
};

InteractiveModeBase.prototype.handleToolsCommand = async function (this: InteractiveModeBase): Promise<void> {
	let report: ToolStatusReport;
	try {
		report =
			this.runtimeHost instanceof IsolatedInteractiveRuntime
				? await this.runtimeHost.getToolStatus()
				: await this.session.getToolStatusAsync();
	} catch (error) {
		this.showError(`Could not read tool status: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	const text = formatToolStatus(report, {
		heading: (value) => theme.bold(value),
		dim: (value) => theme.fg("dim", value),
		warning: (value) => theme.fg("warning", value),
	});
	this.chatContainer.addChild(new Spacer(1));
	this.chatContainer.addChild(new Text(`${theme.bold("Tools")}\n\n${text}`, 1, 0));
	this.ui.requestRender();
};

InteractiveModeBase.prototype.handleSessionSnapshotCommand = async function (this: InteractiveModeBase): Promise<void> {
	const latest = await currentWorktreeSnapshots(this.sessionManager);
	if (latest.size === 0) {
		this.showStatus("No worktree snapshots recorded in this session");
		return;
	}
	const settings = this.settingsManager.getWorktreeSnapshotSettings();
	const lines = [theme.bold("Worktree Snapshots"), ""];
	for (const [root, snapshot] of latest) {
		lines.push(...describeWorktreeSnapshot(root, snapshot));
		const restoreStatus = describeWorktreeRestoreStatus(this.sessionManager, root);
		if (restoreStatus) lines.push(theme.fg("warning", `  ${restoreStatus}`));
		const capture = await describeLastCapture(this.sessionManager, root);
		if (capture) lines.push(theme.fg("dim", `  ${capture}`));
		const comparison = await compareWorktreeSnapshot(snapshot, root, settings);
		if (comparison.status === "match")
			lines.push(
				theme.fg(
					"success",
					`  matches the current tree${comparison.head ? ` at ${comparison.head.slice(0, 12)}` : ""}`,
				),
			);
		else if (comparison.status === "missing") lines.push(theme.fg("warning", `  ${comparison.reason.message}`));
		else {
			lines.push(
				theme.fg(
					"warning",
					`  differs from the current tree ${comparison.tree.slice(0, 12)} at ${comparison.head.slice(0, 12)}`,
				),
			);
			if (comparison.stat) lines.push(...comparison.stat.split("\n").map((line) => `  ${line}`));
		}
		lines.push("");
	}
	const timings = latestResumeTimings(this.sessionManager);
	if (timings !== undefined) {
		lines.push(theme.bold("Last resume"), "", ...formatResumeTimings(timings).map((line) => `  ${line}`));
	}
	this.chatContainer.addChild(new Text(lines.join("\n").trimEnd(), 1, 0));
	this.ui.requestRender();
};

InteractiveModeBase.prototype.handleSessionCommand = function (this: InteractiveModeBase): void | Promise<void> {
	// getSessionStats combines the window with the store's omitted-history totals.
	showSessionInfo.call(this);
};

const NO_USAGE_DETAILS: SessionUsageDetails = {
	breakdown: [],
	promptTokens: 0,
	cacheRead: 0,
	cacheWaste: { missedTokens: 0, missedCost: 0, missCount: 0, unpricedCount: 0 },
};

function showSessionInfo(this: InteractiveModeBase): void {
	const engineStats = getEngineSessionStats(this.session);
	const stats = engineStats ?? this.session.getSessionStats();
	const sessionName = this.session.sessionName;

	let info = `${theme.bold("Session Info")}\n\n`;
	if (sessionName) {
		info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
	}
	const location =
		stats.sessionFile ??
		(this.sessionManager.isPersisted() ? this.sessionManager.getSessionStore().descriptor.location : "In-memory");
	info += `${theme.fg("dim", "File:")} ${location}\n`;
	info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
	info += `${theme.bold("Messages")}\n`;
	info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
	info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
	info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
	info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
	info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
	info += `${theme.bold("Tokens")}\n`;
	info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
	info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
	if (stats.tokens.cacheRead > 0) {
		info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
	}
	if (stats.tokens.cacheWrite > 0) {
		info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
	}
	info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;
	const mirrorStats = engineStats ? this.session.getSessionStats() : stats;
	const mirrorMatchesEngine =
		mirrorStats.sessionId === stats.sessionId &&
		mirrorStats.totalMessages === stats.totalMessages &&
		mirrorStats.cost === stats.cost &&
		mirrorStats.tokens.input === stats.tokens.input &&
		mirrorStats.tokens.output === stats.tokens.output &&
		mirrorStats.tokens.cacheRead === stats.tokens.cacheRead &&
		mirrorStats.tokens.cacheWrite === stats.tokens.cacheWrite;
	const head = info;
	const block = new Text("", 1, 0);
	/** Fill the block; without `details`, only with the lines that do not need them, and `note` when there is one. */
	const show = (details: SessionUsageDetails | undefined, note?: string) => {
		let text = head;
		const promptTokens = engineStats
			? engineStats.tokens.input + engineStats.tokens.cacheRead + engineStats.tokens.cacheWrite
			: (details?.promptTokens ?? 0);
		const cacheRead = engineStats ? engineStats.tokens.cacheRead : (details?.cacheRead ?? 0);
		if (promptTokens > 0)
			text += `${theme.fg("dim", "Cache Hit Rate:")} ${((cacheRead / promptTokens) * 100).toFixed(1)}%\n`;
		if (details && details.cacheWaste.missCount > 0)
			text += `${theme.fg("dim", "Wasted Cache Cost:")} ${formatCacheWaste(details.cacheWaste)}\n`;

		if (stats.cost > 0) {
			text += `\n${theme.bold("Cost")}\n`;
			text += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}`;
			for (const item of details?.breakdown ?? []) {
				text += `\n${theme.fg("dim", `${item.key}:`)} $${item.cost.toFixed(4)}`;
			}
		}
		if (note) text += `\n${theme.fg("warning", note)}`;
		block.setText(text);
	};
	const manager = this.sessionManager;
	const models = createCacheMissModelSource(this.session.modelRuntime);
	// An isolated host's mirror that is behind its engine lists nothing it would have to guess.
	const mirrorBehind = engineStats !== undefined && (this.session.isStreaming || !mirrorMatchesEngine);
	const paged = !mirrorBehind && manager.hasFullHistory?.() === false;
	if (mirrorBehind) show(NO_USAGE_DETAILS);
	else if (!paged) show(sessionUsageDetails(manager.getEntries(), models));
	else show(undefined);

	this.chatContainer.addChild(new Spacer(1));
	this.chatContainer.addChild(block);
	this.ui.requestRender();
	if (!paged) return;
	// The per-model cost and cache lines cover the whole session (#5554). A manager holding only its window reads the
	// rest a page at a time and keeps none of it; the block is shown at once and those lines appear when the read ends.
	void readSessionUsageDetails(manager, models).then(
		(details) => {
			show(details);
			this.ui.requestRender();
		},
		(error: unknown) => {
			show(
				undefined,
				`Could not read the earlier history for the per-model cost and cache lines: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.ui.requestRender();
		},
	);
}

InteractiveModeBase.prototype.handleChangelogCommand = async function (this: InteractiveModeBase): Promise<void> {
	const changelogPath = getChangelogPath();
	const allEntries = await parseChangelogAsync(changelogPath);

	const changelogMarkdown =
		allEntries.length > 0
			? allEntries
					.reverse()
					.map((e) => normalizeChangelogLinks(e.content, e))
					.join("\n\n")
			: "No changelog entries found.";

	this.chatContainer.addChild(new Spacer(1));
	this.chatContainer.addChild(new DynamicBorder());
	this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
	this.chatContainer.addChild(new Spacer(1));
	this.chatContainer.addChild(this.createChangelogMarkdown(changelogMarkdown, 1, 1));
	this.chatContainer.addChild(new DynamicBorder());
	this.ui.requestRender();
};
