import { statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getProjectConfigDirs } from "../config.ts";
import type { Extension } from "./extensions/types.ts";
import type { PathMetadata } from "./package-manager.ts";
import { createSourceInfo, type SourceInfo } from "./source-info.ts";
import { resourceInternals } from "./resource-loader-internals.ts";
import { getLoaderAgentDirs } from "./resource-loader-paths.ts";
import type { DefaultResourceLoader } from "./resource-loader-core.ts";

export function applyExtensionSourceInfo(
	loader: DefaultResourceLoader,
	extensions: Extension[],
	metadataByPath: Map<string, PathMetadata>,
): void {
	for (const extension of extensions) {
		const sourceInfo =
			findSourceInfoForPath(loader, extension.path, undefined, metadataByPath) ??
			getDefaultSourceInfoForPath(loader, extension.path);
		extension.sourceInfo = {
			...sourceInfo,
			configurationOrigin: sourceInfo.configurationOrigin ?? extension.sourceInfo.configurationOrigin,
		};
		for (const command of extension.commands.values()) {
			command.sourceInfo = extension.sourceInfo;
		}
		for (const tool of extension.tools.values()) {
			tool.sourceInfo = extension.sourceInfo;
		}
	}
}

export function findSourceInfoForPath(
	loader: DefaultResourceLoader,
	resourcePath: string,
	extraSourceInfos?: Map<string, SourceInfo>,
	metadataByPath?: Map<string, PathMetadata>,
): SourceInfo | undefined {
	if (!resourcePath) {
		return undefined;
	}

	if (resourcePath.startsWith("<")) {
		return getDefaultSourceInfoForPath(loader, resourcePath);
	}

	const normalizedResourcePath = resolve(resourcePath);
	if (extraSourceInfos) {
		for (const [sourcePath, sourceInfo] of extraSourceInfos.entries()) {
			const normalizedSourcePath = resolve(sourcePath);
			if (
				normalizedResourcePath === normalizedSourcePath ||
				normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
			) {
				return { ...sourceInfo, path: resourcePath };
			}
		}
	}

	if (metadataByPath) {
		const exact = metadataByPath.get(normalizedResourcePath) ?? metadataByPath.get(resourcePath);
		if (exact) {
			return createSourceInfo(resourcePath, exact);
		}

		for (const [sourcePath, metadata] of metadataByPath.entries()) {
			const normalizedSourcePath = resolve(sourcePath);
			if (
				normalizedResourcePath === normalizedSourcePath ||
				normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
			) {
				return createSourceInfo(resourcePath, metadata);
			}
		}
	}

	return undefined;
}

export function getDefaultSourceInfoForPath(loader: DefaultResourceLoader, filePath: string): SourceInfo {
	const state = resourceInternals(loader);
	if (filePath.startsWith("<") && filePath.endsWith(">")) {
		return {
			path: filePath,
			source: filePath.slice(1, -1).split(":")[0] || "temporary",
			scope: "temporary",
			origin: "top-level",
		};
	}

	const normalizedPath = resolve(filePath);
	const agentRoots = getLoaderAgentDirs(state.agentDir).flatMap((agentDir) => [
		join(agentDir, "skills"),
		join(agentDir, "prompts"),
		join(agentDir, "themes"),
		join(agentDir, "extensions"),
	]);
	const projectRoots = getProjectConfigDirs(state.cwd).flatMap((configDir) => [
		join(configDir, "skills"),
		join(configDir, "prompts"),
		join(configDir, "themes"),
		join(configDir, "extensions"),
	]);

	for (const root of agentRoots) {
		if (isUnderPath(normalizedPath, root)) {
			return { path: filePath, source: "local", scope: "user", origin: "top-level", baseDir: root };
		}
	}

	for (const root of projectRoots) {
		if (isUnderPath(normalizedPath, root)) {
			return { path: filePath, source: "local", scope: "project", origin: "top-level", baseDir: root };
		}
	}

	return {
		path: filePath,
		source: "local",
		scope: "temporary",
		origin: "top-level",
		baseDir: statSync(normalizedPath).isDirectory() ? normalizedPath : resolve(normalizedPath, ".."),
	};
}

export function isUnderPath(target: string, root: string): boolean {
	const normalizedRoot = resolve(root);
	if (target === normalizedRoot) {
		return true;
	}
	const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
	return target.startsWith(prefix);
}
