import { dirname, join, relative } from "node:path";
import { CONFIG_DIR_NAME } from "../../../config.ts";
import type { PackageSource, SettingsManager } from "../../../core/settings-manager.ts";
import { isLocalPath, resolvePath } from "../../../utils/paths.ts";
import type { ResourceItem, ResourceType } from "./config-selector-list.ts";

function stripPrefix(pattern: string): string {
	return /^[!+-]/.test(pattern) ? pattern.slice(1) : pattern;
}

function setProjectPaths(settings: SettingsManager, type: ResourceType, paths: string[]): void {
	if (type === "extensions") settings.setProjectExtensionPaths(paths);
	else if (type === "skills") settings.setProjectSkillPaths(paths);
	else if (type === "prompts") settings.setProjectPromptTemplatePaths(paths);
	else if (type === "themes") settings.setProjectThemePaths(paths);
	else settings.setProjectWorkflowPaths(paths);
}

function packagePattern(item: ResourceItem): string {
	return relative(item.metadata.baseDir ?? dirname(item.path), item.path);
}

function toggleProjectPackage(settings: SettingsManager, item: ResourceItem, cwd: string, enabled: boolean): void {
	const packages = [...(settings.getProjectSettings().packages ?? [])] as PackageSource[];
	const projectBase = join(cwd, CONFIG_DIR_NAME);
	const itemRoot = item.metadata.baseDir;
	let index = packages.findIndex((pkg) => {
		const source = typeof pkg === "string" ? pkg : pkg.source;
		if (source === item.metadata.source) return true;
		return itemRoot !== undefined && isLocalPath(source) && resolvePath(source, projectBase, { trim: true }) === itemRoot;
	});
	if (index < 0) {
		const source = isLocalPath(item.metadata.source) && itemRoot
			? relative(projectBase, itemRoot) || "."
			: item.metadata.source;
		packages.push({ source, autoload: false });
		index = packages.length - 1;
	}
	let pkg = packages[index];
	if (typeof pkg === "string") pkg = { source: pkg };
	const pattern = packagePattern(item);
	const entries = (pkg[item.resourceType] ?? []).filter((entry) => stripPrefix(entry) !== pattern);
	entries.push(`${enabled ? "+" : "-"}${pattern}`);
	pkg[item.resourceType] = entries;
	packages[index] = pkg;
	settings.setProjectPackages(packages);
}

export function toggleProjectResource(
	settings: SettingsManager,
	item: ResourceItem,
	cwd: string,
	enabled: boolean,
): void {
	if (item.metadata.origin === "package") {
		toggleProjectPackage(settings, item, cwd, enabled);
		return;
	}
	const current = [...(settings.getProjectSettings()[item.resourceType] ?? [])];
	const projectBase = join(cwd, CONFIG_DIR_NAME);
	const pattern = item.metadata.scope === "user" ? item.path : relative(item.metadata.baseDir ?? projectBase, item.path);
	const updated = current.filter((entry) => stripPrefix(entry) !== pattern);
	updated.push(`${enabled ? "+" : "-"}${pattern}`);
	setProjectPaths(settings, item.resourceType, updated);
}
