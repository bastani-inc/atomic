import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { BashExecutionComponent, type TruncationResult } from "./interactive-mode-deps.ts";
import { isEngineSendFailure } from "./interactive-prompt-restore.ts";

/** Warning shown when `/compact` is submitted while a compaction is already running. */
export const COMPACTION_ALREADY_IN_PROGRESS_WARNING =
	"Compaction is already in progress. Wait for it to finish before running /compact again.";

InteractiveModeBase.prototype.handleBashCommand = async function (
	this: InteractiveModeBase,
	command: string,
	excludeFromContext = false,
): Promise<void> {
	const extensionRunner = this.session.extensionRunner;

	// Emit user_bash event to let extensions intercept
	const eventResult = await extensionRunner.emitUserBash({
		type: "user_bash",
		command,
		excludeFromContext,
		cwd: this.sessionManager.getCwd(),
	});

	// If extension returned a full result, use it directly
	if (eventResult?.result) {
		const result = eventResult.result;

		// Create UI component for display
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
		if (this.session.isStreaming) {
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			this.chatContainer.addChild(this.bashComponent);
		}

		// Show output and complete
		if (result.output) {
			this.bashComponent.appendOutput(result.output);
		}
		this.bashComponent.setComplete(
			result.exitCode,
			result.cancelled,
			result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
			result.fullOutputPath,
		);

		// Record the result in session
		this.session.recordBashResult(command, result, { excludeFromContext });
		this.bashComponent = undefined;
		this.ui.requestRender();
		return;
	}

	// Normal execution path (possibly with custom operations)
	const isDeferred = this.session.isStreaming;
	this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);

	if (isDeferred) {
		// Show in pending area when agent is streaming
		this.pendingMessagesContainer.addChild(this.bashComponent);
		this.pendingBashComponents.push(this.bashComponent);
	} else {
		// Show in chat immediately when agent is idle
		this.chatContainer.addChild(this.bashComponent);
	}
	this.ui.requestRender();

	try {
		const result = await this.session.executeBash(
			command,
			(chunk) => {
				if (this.bashComponent) {
					this.bashComponent.appendOutput(chunk);
					this.ui.requestRender();
				}
			},
			{ excludeFromContext, operations: eventResult?.operations },
		);

		if (this.bashComponent) {
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);
		}
	} catch (error) {
		if (this.bashComponent) {
			this.bashComponent.setComplete(undefined, false);
		}
		this.bashComponent = undefined;
		this.ui.requestRender();
		// A send the engine never accepted belongs to the submit handler, which
		// restores the `!` draft. Ownership comes from the child's admission
		// frame, not from output: a command can create files and print nothing,
		// and offering that text back invites a second run.
		if (isEngineSendFailure(error)) throw error;
		this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		return;
	}

	this.bashComponent = undefined;
	this.ui.requestRender();
};

InteractiveModeBase.prototype.handleCompactCommand = async function (this: InteractiveModeBase): Promise<void> {
	// Guard every caller, not just the `/compact` input branch: starting a second
	// compaction would race the live one and append a duplicate boundary.
	if (this.session.isCompacting) {
		this.showWarning(COMPACTION_ALREADY_IN_PROGRESS_WARNING);
		return;
	}

	const entries = this.sessionManager.getEntries();
	const messageCount = entries.filter((e) => e.type === "message").length;

	if (messageCount < 2) {
		this.showWarning("Nothing to compact (no messages yet)");
		return;
	}

	if (this.loadingAnimation) {
		this.loadingAnimation.stop();
		this.loadingAnimation = undefined;
	}
	this.statusContainer.clear();

	try {
		await this.session.compact();
	} catch (error) {
		// Compaction failures arrive as events, so they stay ignored here — except
		// a send the engine never accepted, which the submit handler turns back
		// into an editor draft.
		if (isEngineSendFailure(error)) throw error;
	}
};

InteractiveModeBase.prototype.stop = function (this: InteractiveModeBase): void {
	this.disposeInteractiveEngineHost();
	this.disposeInteractiveEngineHost = () => {};
	if (this.settingsManager.getShowTerminalProgress()) {
		this.ui.terminal.setProgress(false);
	}
	if (this.loadingAnimation) {
		this.loadingAnimation.stop();
		this.loadingAnimation = undefined;
	}
	this.themeController.disableAutoSync();
	this.clearExtensionTerminalInputListeners();
	this.footer.dispose();
	this.footerDataProvider.dispose();
	if (this.unsubscribe) {
		this.unsubscribe();
	}
	if (this.isInitialized) {
		this.ui.stop();
		this.isInitialized = false;
	}
	this.unregisterSignalHandlers();
};
