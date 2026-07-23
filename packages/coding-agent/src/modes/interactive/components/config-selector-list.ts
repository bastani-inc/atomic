import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { type Component, type Focusable, getKeybindings, Input, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { CONFIG_DIR_NAME } from "../../../config.ts";
import type { PathMetadata, ResolvedPaths, ResolvedResource } from "../../../core/package-manager.ts";
import type { PackageSource, SettingsManager } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { toggleProjectResource } from "./config-selector-project-scope.ts";

export type ResourceType = "extensions" | "skills" | "prompts" | "themes" | "workflows";

const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
	extensions: "Extensions",
	skills: "Skills",
	prompts: "Prompts",
	themes: "Themes",
	workflows: "Workflows",
};

export interface ResourceItem {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
	resourceType: ResourceType;
	displayName: string;
	groupKey: string;
	subgroupKey: string;
}

interface ResourceSubgroup {
	type: ResourceType;
	label: string;
	items: ResourceItem[];
}

export interface ResourceGroup {
	key: string;
	label: string;
	scope: "user" | "project" | "temporary";
	origin: "package" | "top-level";
	source: string;
	subgroups: ResourceSubgroup[];
}

function formatBaseDir(baseDir: string): string {
	const homeDir = homedir();
	let displayPath: string;

	if (baseDir === homeDir) {
		displayPath = "~";
	} else if (baseDir.startsWith(homeDir)) {
		const rest = baseDir.slice(homeDir.length);
		displayPath = `~${rest.replace(/\\/g, "/")}`;
	} else {
		displayPath = baseDir.replace(/\\/g, "/");
	}

	return displayPath.endsWith("/") ? displayPath : `${displayPath}/`;
}

function getGroupLabel(metadata: PathMetadata, agentDir: string): string {
	if (metadata.origin === "package") {
		return `${metadata.source} (${metadata.scope})`;
	}
	if (metadata.source === "auto") {
		if (metadata.baseDir) {
			return metadata.scope === "user"
				? `User (${formatBaseDir(metadata.baseDir)})`
				: `Project (${formatBaseDir(metadata.baseDir)})`;
		}
		return metadata.scope === "user" ? `User (${formatBaseDir(agentDir)})` : `Project (${CONFIG_DIR_NAME}/)`;
	}
	return metadata.scope === "user" ? "User settings" : "Project settings";
}

export function buildGroups(resolved: ResolvedPaths, agentDir: string): ResourceGroup[] {
	const groupMap = new Map<string, ResourceGroup>();

	const addToGroup = (resources: ResolvedResource[], resourceType: ResourceType) => {
		for (const res of resources) {
			const { path, enabled, metadata } = res;
			const groupKey = `${metadata.origin}:${metadata.scope}:${metadata.source}:${metadata.baseDir ?? ""}`;

			if (!groupMap.has(groupKey)) {
				groupMap.set(groupKey, {
					key: groupKey,
					label: getGroupLabel(metadata, agentDir),
					scope: metadata.scope,
					origin: metadata.origin,
					source: metadata.source,
					subgroups: [],
				});
			}

			const group = groupMap.get(groupKey)!;
			const subgroupKey = `${groupKey}:${resourceType}`;

			let subgroup = group.subgroups.find((sg) => sg.type === resourceType);
			if (!subgroup) {
				subgroup = {
					type: resourceType,
					label: RESOURCE_TYPE_LABELS[resourceType],
					items: [],
				};
				group.subgroups.push(subgroup);
			}

			const fileName = basename(path);
			const parentFolder = basename(dirname(path));
			let displayName: string;
			if (resourceType === "extensions" && parentFolder !== "extensions") {
				displayName = `${parentFolder}/${fileName}`;
			} else if (resourceType === "skills" && fileName === "SKILL.md") {
				displayName = parentFolder;
			} else {
				displayName = fileName;
			}
			subgroup.items.push({
				path,
				enabled,
				metadata,
				resourceType,
				displayName,
				groupKey,
				subgroupKey,
			});
		}
	};

	addToGroup(resolved.extensions, "extensions");
	addToGroup(resolved.skills, "skills");
	addToGroup(resolved.prompts, "prompts");
	addToGroup(resolved.themes, "themes");
	addToGroup(resolved.workflows, "workflows");
	// Sort groups: packages first, then top-level; user before project
	const groups = Array.from(groupMap.values());
	groups.sort((a, b) => {
		if (a.origin !== b.origin) return a.origin === "package" ? -1 : 1;
		if (a.scope !== b.scope) return a.scope === "user" ? -1 : 1;
		return a.source.localeCompare(b.source);
	});
	const typeOrder: Record<ResourceType, number> = { extensions: 0, skills: 1, prompts: 2, themes: 3, workflows: 4 };
	for (const group of groups) {
		group.subgroups.sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);
		for (const subgroup of group.subgroups) {
			subgroup.items.sort((a, b) => a.displayName.localeCompare(b.displayName));
		}
	}
	return groups;
}
type FlatEntry =
	| { type: "group"; group: ResourceGroup }
	| { type: "subgroup"; subgroup: ResourceSubgroup; group: ResourceGroup }
	| { type: "item"; item: ResourceItem };
export class ResourceList implements Component, Focusable {
	private groups: ResourceGroup[];
	private flatItems: FlatEntry[] = [];
	private filteredItems: FlatEntry[] = [];
	private selectedIndex = 0;
	private searchInput: Input;
	private maxVisible = 15;
	private settingsManager: SettingsManager;
	private cwd: string;
	private agentDir: string;
	public onCancel?: () => void;
	private writeScope: "global" | "project" = "global";
	public onExit?: () => void;
	public onToggle?: (item: ResourceItem, newEnabled: boolean) => void;
	public onSwitchMode?: () => void;
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	constructor(groups: ResourceGroup[], settingsManager: SettingsManager, cwd: string, agentDir: string, terminalHeight?: number) {
		this.groups = groups;
		this.settingsManager = settingsManager;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.searchInput = new Input();
		this.maxVisible = Math.max(5, (terminalHeight ?? 24) - 8);
		this.buildFlatList();
		this.filteredItems = [...this.flatItems];
	}
	setWriteScope(scope: "global" | "project"): void { this.writeScope = scope; }
	setGroups(groups: ResourceGroup[]): void {
		this.groups = groups;
		this.buildFlatList();
		this.filterItems(this.searchInput.getValue());
	}
	private buildFlatList(): void {
		this.flatItems = [];
		for (const group of this.groups) {
			this.flatItems.push({ type: "group", group });
			for (const subgroup of group.subgroups) {
				this.flatItems.push({ type: "subgroup", subgroup, group });
				for (const item of subgroup.items) {
					this.flatItems.push({ type: "item", item });
				}
			}
		}
		// Start selection on first item (not header)
		this.selectedIndex = this.flatItems.findIndex((e) => e.type === "item");
		if (this.selectedIndex < 0) this.selectedIndex = 0;
	}
	private findNextItem(fromIndex: number, direction: 1 | -1): number {
		let idx = fromIndex + direction;
		while (idx >= 0 && idx < this.filteredItems.length) {
			if (this.filteredItems[idx].type === "item") return idx;
			idx += direction;
		}
		return fromIndex;
	}
	private filterItems(query: string): void {
		if (!query.trim()) {
			this.filteredItems = [...this.flatItems];
			this.selectFirstItem();
			return;
		}
		const lowerQuery = query.toLowerCase();
		const matchingItems = new Set<ResourceItem>();
		const matchingSubgroups = new Set<ResourceSubgroup>();
		const matchingGroups = new Set<ResourceGroup>();
		for (const entry of this.flatItems) {
			if (entry.type === "item") {
				const item = entry.item;
				if (
					item.displayName.toLowerCase().includes(lowerQuery) ||
					item.resourceType.toLowerCase().includes(lowerQuery) ||
					item.path.toLowerCase().includes(lowerQuery)
				) {
					matchingItems.add(item);
				}
			}
		}
		// Find which subgroups and groups contain matching items
		for (const group of this.groups) {
			for (const subgroup of group.subgroups) {
				for (const item of subgroup.items) {
					if (matchingItems.has(item)) {
						matchingSubgroups.add(subgroup);
						matchingGroups.add(group);
					}
				}
			}
		}
		this.filteredItems = [];
		for (const entry of this.flatItems) {
			if (entry.type === "group" && matchingGroups.has(entry.group)) {
				this.filteredItems.push(entry);
			} else if (entry.type === "subgroup" && matchingSubgroups.has(entry.subgroup)) {
				this.filteredItems.push(entry);
			} else if (entry.type === "item" && matchingItems.has(entry.item)) {
				this.filteredItems.push(entry);
			}
		}
		this.selectFirstItem();
	}
	private selectFirstItem(): void {
		const firstItemIndex = this.filteredItems.findIndex((e) => e.type === "item");
		this.selectedIndex = firstItemIndex >= 0 ? firstItemIndex : 0;
	}
	updateItem(item: ResourceItem, enabled: boolean): void {
		item.enabled = enabled;
		for (const group of this.groups) {
			for (const subgroup of group.subgroups) {
				const found = subgroup.items.find((candidate) => candidate.path === item.path && candidate.resourceType === item.resourceType);
				if (found) { found.enabled = enabled; return; }
			}
		}
	}
	invalidate(): void {}
	render(width: number): string[] {
		const lines = [...this.searchInput.render(width), ""];
		if (this.filteredItems.length === 0) return [...lines, theme.fg("muted", "  No resources found")];
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible));
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);
		for (let i = startIndex; i < endIndex; i++) {
			const entry = this.filteredItems[i];
			const selected = i === this.selectedIndex;
			if (entry.type === "group") lines.push(truncateToWidth(`  ${theme.fg("accent", theme.bold(entry.group.label))}`, width, ""));
			else if (entry.type === "subgroup") lines.push(truncateToWidth(`    ${theme.fg("muted", entry.subgroup.label)}`, width, ""));
			else {
				const cursor = selected ? "> " : "  ";
				const checkbox = entry.item.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				const name = selected ? theme.bold(entry.item.displayName) : entry.item.displayName;
				lines.push(truncateToWidth(`${cursor}    ${checkbox} ${name}`, width, "..."));
			}
		}
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const itemCount = this.filteredItems.filter((entry) => entry.type === "item").length;
			const current = this.filteredItems.slice(0, this.selectedIndex).filter((entry) => entry.type === "item").length + 1;
			lines.push(theme.fg("dim", `  (${current}/${itemCount})`));
		}
		return lines;
	}
	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = this.findNextItem(this.selectedIndex, -1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = this.findNextItem(this.selectedIndex, 1);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			// Jump up by maxVisible, then find nearest item
			let target = Math.max(0, this.selectedIndex - this.maxVisible);
			while (target < this.filteredItems.length && this.filteredItems[target].type !== "item") {
				target++;
			}
			if (target < this.filteredItems.length) {
				this.selectedIndex = target;
			}
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			// Jump down by maxVisible, then find nearest item
			let target = Math.min(this.filteredItems.length - 1, this.selectedIndex + this.maxVisible);
			while (target >= 0 && this.filteredItems[target].type !== "item") {
				target--;
			}
			if (target >= 0) {
				this.selectedIndex = target;
			}
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.onExit?.();
			return;
		}
		if (kb.matches(data, "tui.input.tab")) {
			this.onSwitchMode?.();
			return;
		}
		if (data === " " || kb.matches(data, "tui.select.confirm")) {
			const entry = this.filteredItems[this.selectedIndex];
			if (entry?.type === "item") {
				const newEnabled = !entry.item.enabled;
				if (this.writeScope === "project") toggleProjectResource(this.settingsManager, entry.item, this.cwd, newEnabled);
				else this.toggleResource(entry.item, newEnabled);
				this.updateItem(entry.item, newEnabled);
				this.onToggle?.(entry.item, newEnabled);
			}
			return;
		}
		this.searchInput.handleInput(data);
		this.filterItems(this.searchInput.getValue());
	}
	private toggleResource(item: ResourceItem, enabled: boolean): void {
		if (item.metadata.origin === "top-level") {
			this.toggleTopLevelResource(item, enabled);
		} else {
			this.togglePackageResource(item, enabled);
		}
	}
	private toggleTopLevelResource(item: ResourceItem, enabled: boolean): void {
		const scope = item.metadata.scope as "user" | "project";
		const settings = scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const arrayKey = item.resourceType;
		const pattern = this.getResourcePattern(item);
		const updated = (settings[arrayKey] ?? []).filter((entry) => {
			const stripped = /^[!+-]/.test(entry) ? entry.slice(1) : entry;
			return stripped !== pattern;
		});
		updated.push(`${enabled ? "+" : "-"}${pattern}`);
		if (scope === "project") {
			if (arrayKey === "extensions") this.settingsManager.setProjectExtensionPaths(updated);
			else if (arrayKey === "skills") this.settingsManager.setProjectSkillPaths(updated);
			else if (arrayKey === "prompts") this.settingsManager.setProjectPromptTemplatePaths(updated);
			else if (arrayKey === "themes") this.settingsManager.setProjectThemePaths(updated);
			else this.settingsManager.setProjectWorkflowPaths(updated);
		} else {
			if (arrayKey === "extensions") this.settingsManager.setExtensionPaths(updated);
			else if (arrayKey === "skills") this.settingsManager.setSkillPaths(updated);
			else if (arrayKey === "prompts") this.settingsManager.setPromptTemplatePaths(updated);
			else if (arrayKey === "themes") this.settingsManager.setThemePaths(updated);
			else this.settingsManager.setWorkflowPaths(updated);
		}
	}
	private togglePackageResource(item: ResourceItem, enabled: boolean): void {
		const scope = item.metadata.scope as "user" | "project";
		const settings = scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const packages = [...(settings.packages ?? [])] as PackageSource[];
		const pkgIndex = packages.findIndex((pkg) => (typeof pkg === "string" ? pkg : pkg.source) === item.metadata.source);
		if (pkgIndex === -1) return;
		let pkg = packages[pkgIndex];
		if (typeof pkg === "string") pkg = { source: pkg };
		const arrayKey = item.resourceType;
		const pattern = this.getPackageResourcePattern(item);
		const updated = (pkg[arrayKey] ?? []).filter((entry) => (/^[!+-]/.test(entry) ? entry.slice(1) : entry) !== pattern);
		updated.push(`${enabled ? "+" : "-"}${pattern}`);
		pkg[arrayKey] = updated;
		packages[pkgIndex] = pkg;
		if (scope === "project") this.settingsManager.setProjectPackages(packages);
		else this.settingsManager.setPackages(packages);
	}
	private getTopLevelBaseDir(scope: "user" | "project"): string {
		return scope === "project" ? join(this.cwd, CONFIG_DIR_NAME) : this.agentDir;
	}
	private getResourcePattern(item: ResourceItem): string {
		const scope = item.metadata.scope as "user" | "project";
		const baseDir = item.metadata.baseDir ?? this.getTopLevelBaseDir(scope);
		return relative(baseDir, item.path);
	}
	private getPackageResourcePattern(item: ResourceItem): string {
		const baseDir = item.metadata.baseDir ?? dirname(item.path);
		return relative(baseDir, item.path);
	}
}
