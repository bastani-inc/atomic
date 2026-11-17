/** TUI component for managing global and project package resources. */
import { join } from "node:path";
import { type Component, Container, type Focusable, Spacer, truncateToWidth } from "@bastani/atomic-tui";
import { CONFIG_DIR_NAME } from "../../../config.js";
import type { ResolvedPaths } from "../../../core/package-manager.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { shortenHomePath } from "../../../utils/paths.ts";
import { theme } from "../theme/theme.js";
import { buildGroups, type ResourceGroup, ResourceList } from "./config-selector-list.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export type ConfigWriteScope = "global" | "project";
export type ScopedResolvedPaths = Record<ConfigWriteScope, ResolvedPaths>;

class ConfigSelectorHeader implements Component {
	private writeScope: ConfigWriteScope;
	private readonly agentDir: string;
	constructor(writeScope: ConfigWriteScope, agentDir: string) {
		this.writeScope = writeScope;
		this.agentDir = agentDir;
	}
	setWriteScope(scope: ConfigWriteScope): void {
		this.writeScope = scope;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const title = theme.bold(
			theme.fg("text", this.writeScope === "project" ? "Project resources" : "Global resources"),
		);
		const scopeFile =
			this.writeScope === "project"
				? `${CONFIG_DIR_NAME}/settings.json · global resources are inherited`
				: shortenHomePath(join(this.agentDir, "settings.json"));
		return [
			truncateToWidth(`  ${title}`, width, ""),
			truncateToWidth(`  ${theme.fg("muted", scopeFile)}`, width, ""),
		];
	}
}

export class ConfigSelectorComponent extends Container implements Focusable {
	private readonly header: ConfigSelectorHeader;
	private readonly resourceList: ResourceList;
	private readonly groups: Record<ConfigWriteScope, ResourceGroup[]>;
	private writeScope: ConfigWriteScope;
	private readonly getTerminalHeight: () => number;
	private terminalHeight = 0;
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.resourceList.focused = value;
	}

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
		getTerminalHeight?: () => number,
	) {
		super();
		this.writeScope = writeScope;
		this.getTerminalHeight = getTerminalHeight ?? (() => terminalHeight ?? 24);
		this.groups = {
			global: buildGroups(resolvedPaths.global, agentDir),
			project: buildGroups(resolvedPaths.project, agentDir),
		};
		this.resourceList = new ResourceList(this.groups[writeScope], settingsManager, cwd, agentDir, terminalHeight);
		this.header = new ConfigSelectorHeader(writeScope, agentDir);
		this.resourceList.setWriteScope(writeScope);
		this.resourceList.onCancel = onClose;
		this.resourceList.onExit = onExit;
		this.resourceList.onToggle = requestRender;
		if (projectModeAvailable)
			this.resourceList.onSwitchMode = () => {
				this.writeScope = this.writeScope === "global" ? "project" : "global";
				this.header.setWriteScope(this.writeScope);
				this.resourceList.setWriteScope(this.writeScope);
				this.resourceList.setGroups(this.groups[this.writeScope]);
				requestRender();
			};
		this.updateLayout(this.getTerminalHeight());
	}
	private updateLayout(height: number): void {
		this.terminalHeight = height;
		const compactFrame = height < 16;
		this.resourceList.setViewportHeight(height - (compactFrame ? 4 : 8));
		this.clear();
		if (!compactFrame) this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		if (!compactFrame) this.addChild(new Spacer(1));
		this.addChild(this.header);
		if (!compactFrame) this.addChild(new Spacer(1));
		this.addChild(this.resourceList);
		if (!compactFrame) this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}
	override render(width: number): string[] {
		const height = this.getTerminalHeight();
		if (height !== this.terminalHeight) this.updateLayout(height);
		return super.render(width);
	}
	handleInput(data: string): boolean {
		return this.resourceList.handleInput(data);
	}
	getResourceList(): ResourceList {
		return this.resourceList;
	}
}
