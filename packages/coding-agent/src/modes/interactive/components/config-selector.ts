/**
 * TUI component for managing package resources (enable/disable)
 */

import { Container, type Focusable, Spacer } from "@earendil-works/pi-tui";
import type { ResolvedPaths } from "../../../core/package-manager.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { DynamicBorder } from "./dynamic-border.ts";

import { ConfigSelectorHeader, ResourceList, buildGroups } from "./config-selector-list.ts";
export class ConfigSelectorComponent extends Container implements Focusable {
	private resourceList: ResourceList;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.resourceList.focused = value;
	}

	constructor(
		resolvedPaths: ResolvedPaths,
		settingsManager: SettingsManager,
		cwd: string,
		agentDir: string,
		onClose: () => void,
		onExit: () => void,
		requestRender: () => void,
	) {
		super();

		const groups = buildGroups(resolvedPaths, agentDir);

		// Add header
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new ConfigSelectorHeader());
		this.addChild(new Spacer(1));

		// Resource list
		this.resourceList = new ResourceList(groups, settingsManager, cwd, agentDir);
		this.resourceList.onCancel = onClose;
		this.resourceList.onExit = onExit;
		this.resourceList.onToggle = () => requestRender();
		this.addChild(this.resourceList);

		// Bottom border
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	getResourceList(): ResourceList {
		return this.resourceList;
	}
}
