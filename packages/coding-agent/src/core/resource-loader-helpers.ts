import type { PackageSource } from "./settings-manager.ts";

function cloneStringArray(values: readonly string[] | undefined): string[] {
	return values === undefined ? [] : [...values];
}

export function mergeInheritedStrings(
	inherited: readonly string[] | undefined,
	current: readonly string[] | undefined,
): string[] {
	return [...cloneStringArray(inherited), ...cloneStringArray(current)];
}

function clonePackageSource(source: PackageSource): PackageSource {
	if (typeof source === "string") {
		return source;
	}
	return {
		source: source.source,
		...(source.autoload === undefined ? {} : { autoload: source.autoload }),
		...(source.extensions === undefined ? {} : { extensions: [...source.extensions] }),
		...(source.skills === undefined ? {} : { skills: [...source.skills] }),
		...(source.prompts === undefined ? {} : { prompts: [...source.prompts] }),
		...(source.themes === undefined ? {} : { themes: [...source.themes] }),
		...(source.workflows === undefined ? {} : { workflows: [...source.workflows] }),
	};
}

export function clonePackageSources(sources: readonly PackageSource[] | undefined): PackageSource[] {
	return sources === undefined ? [] : sources.map((source) => clonePackageSource(source));
}
