import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isLegacyEnvVarNameConfigValue } from "./core/resolve-config-value.ts";
import { stripJsonComments } from "./utils/json.ts";

interface ConfigValueMigration {
	location: string;
	from: string;
	to: string;
}

function migrateLegacyEnvVarString(value: string): string | undefined {
	return isLegacyEnvVarNameConfigValue(value) && process.env[value] !== undefined ? `$${value}` : undefined;
}

function migrateStringProperty(
	record: Record<string, unknown>,
	key: string,
	location: string,
	migrations: ConfigValueMigration[],
): boolean {
	const value = record[key];
	if (typeof value !== "string") return false;
	const migrated = migrateLegacyEnvVarString(value);
	if (migrated === undefined) return false;
	record[key] = migrated;
	migrations.push({ location, from: value, to: migrated });
	return true;
}

function migrateHeadersConfig(headers: unknown, location: string, migrations: ConfigValueMigration[]): boolean {
	if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return false;
	const headerRecord = headers as Record<string, unknown>;
	let migrated = false;
	for (const [key, value] of Object.entries(headerRecord)) {
		if (typeof value !== "string") continue;
		const migratedValue = migrateLegacyEnvVarString(value);
		if (migratedValue === undefined) continue;
		headerRecord[key] = migratedValue;
		migrations.push({ location: `${location}[${JSON.stringify(key)}]`, from: value, to: migratedValue });
		migrated = true;
	}
	return migrated;
}

export function migrateAuthJsonConfigValues(agentDir: string): ConfigValueMigration[] {
	const authPath = join(agentDir, "auth.json");
	if (!existsSync(authPath)) return [];

	try {
		const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
		const authData = parsed as Record<string, unknown>;

		const migrations: ConfigValueMigration[] = [];
		for (const [provider, credential] of Object.entries(authData)) {
			if (typeof credential !== "object" || credential === null || Array.isArray(credential)) continue;
			const credentialRecord = credential as Record<string, unknown>;
			if (credentialRecord.type !== "api_key") continue;
			migrateStringProperty(credentialRecord, "key", `auth.json[${JSON.stringify(provider)}].key`, migrations);
		}

		if (migrations.length === 0) return [];
		writeFileSync(authPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
		chmodSync(authPath, 0o600);
		return migrations;
	} catch {
		return [];
	}
}

interface JsonRewriteContext {
	type: "object" | "array";
	path: string[];
	pendingKey?: string;
}

function isProviderConfigPath(parentPath: string[]): boolean {
	return parentPath.length === 2 && parentPath[0] === "providers";
}

function isMigratableHeadersPath(parentPath: string[]): boolean {
	if (parentPath[0] !== "providers") return false;
	// providers.<provider>.headers
	if (parentPath.length === 3 && parentPath[2] === "headers") return true;
	// providers.<provider>.models[].headers
	if (parentPath.length === 4 && parentPath[2] === "models" && parentPath[3] === "headers") return true;
	// providers.<provider>.modelOverrides.<modelId>.headers
	if (parentPath.length === 5 && parentPath[2] === "modelOverrides" && parentPath[4] === "headers") return true;
	return false;
}

function migrationReplacementForKey(key: string, value: string, parentPath: string[], migrations: ConfigValueMigration[]): string | undefined {
	if (key !== "apiKey" && !isMigratableHeadersPath(parentPath)) return undefined;
	if (key === "apiKey" && !isProviderConfigPath(parentPath)) return undefined;

	for (const migration of migrations) {
		if (migration.from !== value) continue;
		if (key === "apiKey" && migration.location.endsWith(".apiKey")) return migration.to;
		if (isMigratableHeadersPath(parentPath) && migration.location.includes(".headers[") && migration.location.endsWith(`[${JSON.stringify(key)}]`)) {
			return migration.to;
		}
	}
	return undefined;
}

function skipJsoncTrivia(content: string, index: number): number {
	let current = index;
	while (current < content.length) {
		const char = content[current];
		const next = content[current + 1];
		if (char !== undefined && /\s/.test(char)) {
			current++;
			continue;
		}
		if (char === "/" && next === "/") {
			current += 2;
			while (current < content.length && content[current] !== "\n") current++;
			continue;
		}
		if (char === "/" && next === "*") {
			current += 2;
			while (current < content.length && !(content[current] === "*" && content[current + 1] === "/")) current++;
			current = Math.min(content.length, current + 2);
			continue;
		}
		break;
	}
	return current;
}

function replaceMigratedJsonStringValues(content: string, migrations: ConfigValueMigration[]): string {
	if (migrations.length === 0) return content;

	let result = "";
	let index = 0;
	let inLineComment = false;
	let inBlockComment = false;
	const stack: JsonRewriteContext[] = [];

	function consumePendingContainerPath(): string[] {
		const parent = stack[stack.length - 1];
		if (!parent) return [];
		if (parent.type === "object" && parent.pendingKey !== undefined) {
			const path = [...parent.path, parent.pendingKey];
			parent.pendingKey = undefined;
			return path;
		}
		return [...parent.path];
	}

	while (index < content.length) {
		const char = content[index]!;
		const next = content[index + 1];

		if (inLineComment) {
			result += char;
			index++;
			if (char === "\n") inLineComment = false;
			continue;
		}

		if (inBlockComment) {
			result += char;
			if (char === "*" && next === "/") {
				result += next;
				index += 2;
				inBlockComment = false;
			} else {
				index++;
			}
			continue;
		}

		if (char === "/" && next === "/") {
			result += char + next;
			index += 2;
			inLineComment = true;
			continue;
		}

		if (char === "/" && next === "*") {
			result += char + next;
			index += 2;
			inBlockComment = true;
			continue;
		}

		if (char === "{") {
			stack.push({ type: "object", path: consumePendingContainerPath() });
			result += char;
			index++;
			continue;
		}

		if (char === "[") {
			stack.push({ type: "array", path: consumePendingContainerPath() });
			result += char;
			index++;
			continue;
		}

		if (char === "}" || char === "]") {
			stack.pop();
			result += char;
			index++;
			continue;
		}

		if (char !== '"') {
			result += char;
			index++;
			continue;
		}

		const stringStart = index;
		index++;
		let escaped = false;
		while (index < content.length) {
			const current = content[index]!;
			index++;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (current === "\\") {
				escaped = true;
				continue;
			}
			if (current === '"') break;
		}

		const rawString = content.slice(stringStart, index);
		const activeContext = stack[stack.length - 1];
		const afterString = skipJsoncTrivia(content, index);
		const isObjectKey = activeContext?.type === "object" && content[afterString] === ":";

		if (isObjectKey) {
			try {
				activeContext.pendingKey = JSON.parse(rawString) as string;
			} catch {
				activeContext.pendingKey = undefined;
			}
			result += rawString;
			continue;
		}

		try {
			const value = JSON.parse(rawString) as unknown;
			const key = activeContext?.type === "object" ? activeContext.pendingKey : undefined;
			if (typeof value === "string" && key !== undefined) {
				const migrated = migrationReplacementForKey(key, value, activeContext.path, migrations);
				result += migrated === undefined ? rawString : JSON.stringify(migrated);
				activeContext.pendingKey = undefined;
			} else {
				result += rawString;
			}
		} catch {
			result += rawString;
		}
	}

	return result;
}

export function migrateModelsJsonConfigValues(agentDir: string): ConfigValueMigration[] {
	const modelsPath = join(agentDir, "models.json");
	if (!existsSync(modelsPath)) return [];

	try {
		const content = readFileSync(modelsPath, "utf-8");
		const parsed = JSON.parse(stripJsonComments(content)) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
		const modelsData = parsed as Record<string, unknown>;
		const providers = modelsData.providers;
		if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return [];

		const migrations: ConfigValueMigration[] = [];
		for (const [provider, providerConfig] of Object.entries(providers)) {
			if (typeof providerConfig !== "object" || providerConfig === null || Array.isArray(providerConfig)) continue;
			const providerRecord = providerConfig as Record<string, unknown>;
			const providerLocation = `models.json.providers[${JSON.stringify(provider)}]`;
			migrateStringProperty(providerRecord, "apiKey", `${providerLocation}.apiKey`, migrations);
			migrateHeadersConfig(providerRecord.headers, `${providerLocation}.headers`, migrations);

			if (Array.isArray(providerRecord.models)) {
				for (let index = 0; index < providerRecord.models.length; index++) {
					const modelConfig = providerRecord.models[index];
					if (typeof modelConfig !== "object" || modelConfig === null || Array.isArray(modelConfig)) continue;
					const modelRecord = modelConfig as Record<string, unknown>;
					const modelKey = typeof modelRecord.id === "string" ? JSON.stringify(modelRecord.id) : String(index);
					migrateHeadersConfig(modelRecord.headers, `${providerLocation}.models[${modelKey}].headers`, migrations);
				}
			}

			const modelOverrides = providerRecord.modelOverrides;
			if (typeof modelOverrides === "object" && modelOverrides !== null && !Array.isArray(modelOverrides)) {
				for (const [modelId, modelOverride] of Object.entries(modelOverrides)) {
					if (typeof modelOverride !== "object" || modelOverride === null || Array.isArray(modelOverride))
						continue;
					const modelOverrideRecord = modelOverride as Record<string, unknown>;
					migrateHeadersConfig(
						modelOverrideRecord.headers,
						`${providerLocation}.modelOverrides[${JSON.stringify(modelId)}].headers`,
						migrations,
					);
				}
			}
		}

		if (migrations.length === 0) return [];
		writeFileSync(modelsPath, replaceMigratedJsonStringValues(content, migrations), "utf-8");
		return migrations;
	} catch {
		return [];
	}
}

