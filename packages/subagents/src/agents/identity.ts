import * as path from "node:path";
import type { AgentConfig } from "./agents.js";

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;

function normalizePackageName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	return trimmed
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9.-]/g, "")
		.replace(/-+/g, "-")
		.replace(/\.+/g, ".")
		.replace(/(?:^[-.]+|[-.]+$)/g, "");
}

export function parsePackageName(value: unknown, label = "package"): { packageName?: string; error?: string } {
	if (value === undefined || value === false || value === "") return { packageName: undefined };
	if (typeof value !== "string") return { error: `${label} must be a string or false when provided.` };
	const packageName = normalizePackageName(value);
	if (!packageName || !IDENTIFIER_PATTERN.test(packageName))
		return { error: `${label} is invalid after sanitization.` };
	return { packageName };
}

/**
 * The namespace of an installed package's agents: its package.json `name` with an npm scope as a dotted prefix
 * (`@acme/review-kit` becomes `acme.review-kit`), or the package directory's name when it has no usable name, both
 * normalized like a `package:` frontmatter value. Undefined when neither yields a valid identifier.
 */
export function packageAgentNamespace(packageJsonName: string | undefined, packageRoot: string): string | undefined {
	const scoped = /^@([^/]+)\/(.+)$/.exec(packageJsonName?.trim() ?? "");
	const candidates = [scoped ? `${scoped[1]}.${scoped[2]}` : packageJsonName, path.basename(packageRoot)];
	for (const candidate of candidates) {
		const { packageName } = parsePackageName(candidate);
		if (packageName) return packageName;
	}
	return undefined;
}

export function buildRuntimeName(localName: string, packageName?: string): string {
	const trimmedPackage = packageName?.trim();
	return trimmedPackage ? `${trimmedPackage}.${localName}` : localName;
}

export function frontmatterNameForConfig(config: Pick<AgentConfig, "name" | "localName" | "packageName">): string {
	if (config.localName) return config.localName;
	if (config.packageName && config.name.startsWith(`${config.packageName}.`)) {
		return config.name.slice(config.packageName.length + 1);
	}
	return config.name;
}
