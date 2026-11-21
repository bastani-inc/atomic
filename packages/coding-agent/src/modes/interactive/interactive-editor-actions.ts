import { formatModelLabel } from "../../core/model-label.ts";
import { StartupIdentityComponent } from "./components/startup-identity.ts";
import { supersedeBlockClicks } from "./components/transcript-block-clicks.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	APP_NAME,
	AssistantMessageComponent,
	CHANGELOG_URL,
	type Component,
	Container,
	DynamicBorder,
	getCapabilities,
	hyperlink,
	openExternalEditorForText,
	Spacer,
	Text,
	theme,
} from "./interactive-mode-deps.ts";
import { ExpandableText, isExpandable } from "./interactive-mode-helpers.ts";
import { forgetChosenSavedExpansions } from "./interactive-saved-tool-calls.ts";

InteractiveModeBase.prototype.refreshBuiltInHeader = function (this: InteractiveModeBase): void {
	if (this.builtInHeader instanceof ExpandableText || this.builtInHeader instanceof StartupIdentityComponent) {
		this.builtInHeader.refresh();
	}
};

InteractiveModeBase.prototype.updateEditorBorderColor = function (this: InteractiveModeBase): void {
	if (this.isBashMode) {
		this.editor.borderColor = theme.getBashModeBorderColor();
	} else {
		const level = this.session.thinkingLevel || "off";
		this.editor.borderColor = theme.getThinkingBorderColor(level);
	}
	this.ui.requestRender();
};

InteractiveModeBase.prototype.cycleThinkingLevel = async function (this: InteractiveModeBase): Promise<void> {
	const newLevel = await this.session.cycleThinkingLevel({ persist: true });
	if (newLevel === undefined) {
		this.showStatus("Current model does not support thinking");
	} else {
		this.footer.invalidate();
		this.updateEditorBorderColor();
		this.showStatus(`Thinking level: ${newLevel}`);
	}
};

InteractiveModeBase.prototype.cycleModel = async function (
	this: InteractiveModeBase,
	direction: "forward" | "backward",
): Promise<void> {
	try {
		const result = await this.session.cycleModel(direction, { persist: true });
		if (result === undefined) {
			const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
			this.showStatus(msg);
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Switched to ${formatModelLabel(result.model, { thinkingLevel: result.thinkingLevel })}`);
			void this.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
		}
	} catch (error) {
		this.showError(error instanceof Error ? error.message : String(error));
	}
};

InteractiveModeBase.prototype.toggleToolOutputExpansion = function (this: InteractiveModeBase): void {
	this.setToolsExpanded(!this.toolOutputExpanded);
};

InteractiveModeBase.prototype.setToolsExpanded = function (this: InteractiveModeBase, expanded: boolean): void {
	supersedeBlockClicks(this.chatContainer);
	supersedeBlockClicks(this.pendingMessagesContainer);
	if (this.toolOutputExpanded === expanded) return;
	this.toolOutputExpanded = expanded;
	forgetChosenSavedExpansions(this);
	const activeHeader = this.customHeader ?? this.builtInHeader;
	if (isExpandable(activeHeader)) {
		activeHeader.setExpanded(expanded);
	}
	const visited = new Set<Container>();
	const setNestedExpandables = (container: Container): void => {
		if (visited.has(container)) return;
		visited.add(container);
		for (const child of container.children) {
			if (isExpandable(child)) child.setExpanded(expanded);
			if (child instanceof Container) setNestedExpandables(child);
		}
	};
	setNestedExpandables(this.chatContainer);
	setNestedExpandables(this.pendingMessagesContainer);
	// The rendered chat is the feedback; a status line restating it only adds noise.
	this.ui.requestRender();
};

/** Update rendered assistant messages without rebuilding live tool components. */
InteractiveModeBase.prototype.updateThinkingBlockVisibility = function (this: InteractiveModeBase): void {
	for (const child of this.chatContainer.children) {
		if (child instanceof AssistantMessageComponent) {
			child.setHideThinkingBlock(this.hideThinkingBlock);
		}
	}
	this.ui.requestRender();
};

InteractiveModeBase.prototype.toggleThinkingBlockVisibility = function (this: InteractiveModeBase): void {
	this.hideThinkingBlock = !this.hideThinkingBlock;
	this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);
	this.updateThinkingBlockVisibility();
	this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
};

InteractiveModeBase.prototype.openExternalEditor = async function (this: InteractiveModeBase): Promise<void> {
	const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
	const updated = await openExternalEditorForText(currentText, this.ui, {
		editorCommand: this.settingsManager.getExternalEditorCommand(),
		showWarning: (message) => this.showWarning(message),
		showStatus: (message) => this.showStatus(message),
	});
	if (updated !== undefined) this.editor.setText(updated);
};

InteractiveModeBase.prototype.clearEditor = function (this: InteractiveModeBase): void {
	this.editor.setText("");
	this.ui.requestRender();
};

InteractiveModeBase.prototype.showError = function (this: InteractiveModeBase, errorMessage: string): void {
	this.chatContainer.addChild(new Spacer(1));
	this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
	this.chatContainer.addChild(new Spacer(1));
	this.ui.requestRender();
};

/** Each series' latest row, held only while the chat holds it. */
const repeatedErrorRows = new WeakMap<object, WeakRef<Text>>();
/** What each such row shows: its failure's message, and how many failures. Gone with the row. */
const repeatedErrorCounts = new WeakMap<Text, { readonly message: string; count: number }>();
/** The parts every repeated-failure row added to the chat. */
const repeatedErrorParts = new WeakSet<Component>();

/** Whether `text` is in the chat with only rows of repeated failures after it: the bottom of the chat. */
function onlyRepeatedErrorsFrom(container: Container, text: Text): boolean {
	const children = container.children;
	for (let index = children.length - 1; index >= 0; index--) {
		const child = children[index]!;
		if (child === text) return true;
		if (!repeatedErrorParts.has(child)) return false;
	}
	return false;
}

InteractiveModeBase.prototype.showRepeatedError = function (
	this: InteractiveModeBase,
	errorMessage: string,
	series: object,
): void {
	const row = repeatedErrorRows.get(series)?.deref();
	const shown = row && repeatedErrorCounts.get(row);
	if (row !== undefined && shown?.message === errorMessage && onlyRepeatedErrorsFrom(this.chatContainer, row)) {
		shown.count++;
		row.setText(theme.fg("error", `Error: ${errorMessage} (${shown.count} times)`));
		this.ui.requestRender();
		return;
	}
	const text = new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0);
	for (const part of [new Spacer(1), text, new Spacer(1)]) {
		repeatedErrorParts.add(part);
		this.chatContainer.addChild(part);
	}
	repeatedErrorRows.set(series, new WeakRef(text));
	repeatedErrorCounts.set(text, { message: errorMessage, count: 1 });
	this.ui.requestRender();
};

InteractiveModeBase.prototype.showWarning = function (
	this: InteractiveModeBase,
	warningMessage: string,
	targetContainer = this.chatContainer,
): void {
	targetContainer.addChild(new Spacer(1));
	targetContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
	this.ui.requestRender();
};

InteractiveModeBase.prototype.showNewVersionNotification = function (
	this: InteractiveModeBase,
	newVersion: string,
	targetContainer = this.chatContainer,
): void {
	const action = theme.fg("accent", `${APP_NAME} update`);
	const updateInstruction = theme.fg("muted", `New version ${newVersion} is available. Run `) + action;
	const changelogLine = CHANGELOG_URL
		? `\n${theme.fg("muted", "Changelog: ")}${
				getCapabilities().hyperlinks
					? hyperlink(theme.fg("accent", "open changelog"), CHANGELOG_URL)
					: theme.fg("accent", CHANGELOG_URL)
			}`
		: "";

	targetContainer.addChild(new Spacer(1));
	targetContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
	targetContainer.addChild(
		new Text(`${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction}${changelogLine}`, 1, 0),
	);
	targetContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
	this.ui.requestRender();
};

InteractiveModeBase.prototype.showPackageUpdateNotification = function (
	this: InteractiveModeBase,
	packages: string[],
	targetContainer = this.chatContainer,
): void {
	const action = theme.fg("accent", `${APP_NAME} update --extensions`);
	const updateInstruction = theme.fg("muted", "Package updates are available. Run ") + action;
	const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

	targetContainer.addChild(new Spacer(1));
	targetContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
	targetContainer.addChild(
		new Text(
			`${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction}\n${theme.fg("muted", "Packages:")}\n${packageLines}`,
			1,
			0,
		),
	);
	targetContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
	this.ui.requestRender();
};
