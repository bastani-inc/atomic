/** TUI component for managing global and project package resources. */
import { type Component, Container, type Focusable, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CONFIG_DIR_NAME } from "../../../config.ts";
import type { ResolvedPaths } from "../../../core/package-manager.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";
import { ResourceList, buildGroups, type ResourceGroup } from "./config-selector-list.ts";

export type ConfigWriteScope = "global" | "project";
export type ScopedResolvedPaths = Record<ConfigWriteScope, ResolvedPaths>;

class ConfigSelectorHeader implements Component {
	private writeScope: ConfigWriteScope;
	private readonly projectModeAvailable: boolean;
	constructor(writeScope: ConfigWriteScope, projectModeAvailable: boolean) {
		this.writeScope = writeScope;
		this.projectModeAvailable = projectModeAvailable;
	}
	setWriteScope(scope: ConfigWriteScope): void { this.writeScope = scope; }
	invalidate(): void {}
	render(width: number): string[] {
		const title = theme.bold(this.writeScope === "project" ? "Project Local Resources" : "Global Resources");
		const sep = theme.fg("muted", " · ");
		const switchHint = this.projectModeAvailable ? keyHint("tui.input.tab", "switch scope") + sep : "";
		const hint = switchHint + rawKeyHint("space", "toggle") + sep + rawKeyHint("esc", "close");
		const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(hint));
		const scopeFile = this.writeScope === "project"
			? `${CONFIG_DIR_NAME}/settings.json · global resources are inherited`
			: `~/${CONFIG_DIR_NAME}/agent/settings.json`;
		return [truncateToWidth(`${title}${" ".repeat(spacing)}${hint}`, width, ""), theme.fg("muted", scopeFile)];
	}
}

export class ConfigSelectorComponent extends Container implements Focusable {
	private readonly header: ConfigSelectorHeader;
	private readonly resourceList: ResourceList;
	private readonly groups: Record<ConfigWriteScope, ResourceGroup[]>;
	private writeScope: ConfigWriteScope;
	private _focused = false;
	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.resourceList.focused = value; }

	constructor(
		resolvedPaths: ScopedResolvedPaths,
		settingsManager: SettingsManager,
		cwd: string,
		agentDir: string,
		onClose: () => void,
		onExit: () => void,
		requestRender: () => void,
		terminalHeight?: number,
		writeScope: ConfigWriteScope = "global",
		projectModeAvailable = true,
	) {
		super();
		this.writeScope = writeScope;
		this.groups = {
			global: buildGroups(resolvedPaths.global, agentDir),
			project: buildGroups(resolvedPaths.project, agentDir),
		};
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.header = new ConfigSelectorHeader(writeScope, projectModeAvailable);
		this.addChild(this.header);
		this.addChild(new Spacer(1));
		this.resourceList = new ResourceList(this.groups[writeScope], settingsManager, cwd, agentDir, terminalHeight);
		this.resourceList.setWriteScope(writeScope);
		this.resourceList.onCancel = onClose;
		this.resourceList.onExit = onExit;
		this.resourceList.onToggle = requestRender;
		if (projectModeAvailable) this.resourceList.onSwitchMode = () => {
			this.writeScope = this.writeScope === "global" ? "project" : "global";
			this.header.setWriteScope(this.writeScope);
			this.resourceList.setWriteScope(this.writeScope);
			this.resourceList.setGroups(this.groups[this.writeScope]);
			requestRender();
		};
		this.addChild(this.resourceList);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}
	getResourceList(): ResourceList { return this.resourceList; }
}
