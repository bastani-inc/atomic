import { join } from "path";
import { getAgentConfigPaths, getAgentDir, getProjectConfigPaths } from "../config.js";
import { warnDeprecation } from "../utils/deprecation.js";
import { parseJsonFileContent } from "../utils/json.ts";
import { normalizeAzureSettings } from "./azure-provider-compat.js";
import { backgroundCompactionSettingErrors } from "./compaction/background-compaction.ts";
import { isDecisionConfigError } from "./decision/errors.js";
import { deepMergeSettings, isPrototypeKey } from "./settings-merge.js";
import { FileSettingsStorage, InMemorySettingsStorage } from "./settings-storage.ts";
import type {
	PackageSource,
	Settings,
	SettingsError,
	SettingsManagerCreateOptions,
	SettingsScope,
	SettingsStorage,
} from "./settings-types.ts";
import { dropWrongTypedSettings, type InvalidSettingValue, invalidSettingMessage } from "./settings-validation.ts";
import { ownedSettingsManagers, recordSettingsWrite, settingsWriteOwner } from "./settings-write-ownership.ts";

/** A wrong-typed value removed from one settings file, with that file's path when the storage is file-backed. */
interface InvalidLayerValue extends InvalidSettingValue {
	path?: string;
}

interface SettingsLoad {
	settings: Settings;
	invalid: InvalidLayerValue[];
	error: Error | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A nested setting as an object of its keys; list-form `workflows` is its `paths`. */
function nestedEntries(field: keyof Settings, value: unknown): Record<string, unknown> {
	if (field === "workflows" && Array.isArray(value)) return { paths: value };
	return isPlainObject(value) ? value : {};
}

export class SettingsManager {
	/** A defensive snapshot of the effective merged settings. */
	getSettings(): Settings {
		return structuredClone(this.settings);
	}

	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings;
	private projectTrusted: boolean;
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];
	/** Wrong-typed values already reported, so a reload of an unchanged file does not report them again. */
	private reportedInvalidSettings = new Set<string>();
	/** `applyOverrides` calls, in order; they apply over the loaded settings for the rest of the run. */
	private overrides: Settings[] = [];

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.projectTrusted = projectTrusted;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		for (const error of initialErrors)
			this.reportedInvalidSettings.add(SettingsManager.invalidSettingIdentity(error));
		this.settings = this.mergeEffectiveSettings();
		this.touchSplitAccessorMethods();
	}

	private mergeEffectiveSettings(): Settings {
		return this.overrides.reduce(
			(settings, overrides) => deepMergeSettings(settings, overrides),
			deepMergeSettings(this.globalSettings, this.projectSettings),
		);
	}

	/** Create a SettingsManager that loads from files */
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		const storage = new FileSettingsStorage(cwd, agentDir, {
			globalReadPaths:
				agentDir === getAgentDir() ? getAgentConfigPaths("settings.json") : [join(agentDir, "settings.json")],
			projectReadPaths: getProjectConfigPaths(cwd, "settings.json"),
		});
		return SettingsManager.fromStorage(storage, options);
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push({
				scope: "global",
				path: (globalLoad.error as Error & { path?: string }).path,
				error: globalLoad.error,
			});
		} else {
			initialErrors.push(...SettingsManager.validateLoadedSettings("global", globalLoad));
		}
		if (projectLoad.error) {
			initialErrors.push({
				scope: "project",
				path: (projectLoad.error as Error & { path?: string }).path,
				error: projectLoad.error,
			});
		} else {
			initialErrors.push(...SettingsManager.validateLoadedSettings("project", projectLoad));
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage);
	}

	private static loadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; invalid: InvalidLayerValue[] } {
		if (scope === "project" && !projectTrusted) {
			return { settings: {}, invalid: [] };
		}

		// Each file is validated and migrated on its own, highest precedence first, then merged from the lowest up.
		const invalid: InvalidLayerValue[] = [];
		const layers = SettingsManager.readLayers(storage, scope).map(({ path, content }) => {
			let settings: Parameters<typeof dropWrongTypedSettings>[0];
			try {
				settings = parseJsonFileContent(content) as Parameters<typeof dropWrongTypedSettings>[0];
			} catch (error) {
				if (path !== undefined && error instanceof Error) (error as Error & { path?: string }).path = path;
				throw error;
			}
			for (const value of dropWrongTypedSettings(settings)) {
				invalid.push({ ...value, path: path ?? storage.getFieldPath?.(scope, value.setting) });
			}
			return SettingsManager.migrateSettings(settings);
		});
		const settings = layers.reduceRight<Settings>((merged, layer) => deepMergeSettings(merged, layer), {});
		return { settings, invalid };
	}

	private static readLayers(storage: SettingsStorage, scope: SettingsScope): { path?: string; content: string }[] {
		if (storage.readLayers) return storage.readLayers(scope);
		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});
		return content ? [{ content }] : [];
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): SettingsLoad {
		try {
			return { ...SettingsManager.loadFromStorage(storage, scope, projectTrusted), error: null };
		} catch (error) {
			if (isDecisionConfigError(error)) throw error;
			return { settings: {}, invalid: [], error: error as Error };
		}
	}

	private static validateLoadedSettings(scope: SettingsScope, load: SettingsLoad): SettingsError[] {
		const invalid = load.invalid.map(
			(value): SettingsError => ({
				scope,
				path: value.path,
				error: new Error(invalidSettingMessage(value)),
				invalidKey: value.key,
			}),
		);
		const compaction = backgroundCompactionSettingErrors(load.settings.compaction).map((error) => ({ scope, error }));
		return [...invalid, ...compaction];
	}

	private static invalidSettingIdentity({ scope, path, error }: SettingsError): string {
		return `${scope}\0${path}\0${error.message}`;
	}

	/**
	 * Record load-time validation errors, skipping wrong-typed values this manager already reported. A reported value
	 * that is no longer in the scope is forgotten, so it is reported again if it comes back.
	 */
	private recordValidationErrors(scope: SettingsScope, load: SettingsLoad): void {
		const present = new Set<string>();
		for (const error of SettingsManager.validateLoadedSettings(scope, load)) {
			if (error.invalidKey !== undefined) {
				const identity = SettingsManager.invalidSettingIdentity(error);
				present.add(identity);
				if (this.reportedInvalidSettings.has(identity)) continue;
				this.reportedInvalidSettings.add(identity);
			}
			this.errors.push(error);
		}
		for (const identity of this.reportedInvalidSettings) {
			if (identity.startsWith(`${scope}\0`) && !present.has(identity)) this.reportedInvalidSettings.delete(identity);
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// Migrate routerModel -> decisionModel before normalizing provider IDs.
		if ("routerModel" in settings) {
			if ("decisionModel" in settings) {
				warnDeprecation('Ignored legacy "routerModel" because "decisionModel" is already set.');
			} else if (typeof settings.routerModel === "string" && settings.routerModel.trim() === settings.routerModel) {
				settings.decisionModel = settings.routerModel;
			} else {
				warnDeprecation(
					'Ignored invalid legacy "routerModel"; set "decisionModel" to an exact provider/model ID, "auto", or an empty string.',
				);
			}
			delete settings.routerModel;
		}
		// Automatic model routing was removed; its settings are dropped.
		if ("modelRouting" in settings) {
			warnDeprecation(
				'Ignored removed setting "modelRouting": automatic model routing was removed, so "auto" runs your default model and its provider and model restrictions no longer limit "auto" or any fallback model.',
			);
			delete settings.modelRouting;
		}
		settings = normalizeAzureSettings(settings as Settings) as Record<string, unknown>;
		// Migrate queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// Migrate legacy websockets boolean -> transport enum
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// Migrate old skills object format to new array format
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		// Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
		if (
			"retry" in settings &&
			typeof settings.retry === "object" &&
			settings.retry !== null &&
			!Array.isArray(settings.retry)
		) {
			const retrySettings = settings.retry as Record<string, unknown>;
			const providerSettings =
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? (retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				typeof retrySettings.maxDelayMs === "number" &&
				(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
			) {
				retrySettings.provider = {
					...(providerSettings ?? {}),
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			delete retrySettings.maxDelayMs;
		}

		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	isFieldInherited(scope: SettingsScope, field: keyof Settings): boolean {
		return this.storage.getFieldOrigin?.(scope, field) === "legacy";
	}

	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		if (this.projectTrusted === trusted) {
			return;
		}
		const projectLoad = trusted ? SettingsManager.tryLoadFromStorage(this.storage, "project", true) : undefined;

		this.projectTrusted = trusted;
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		if (projectLoad === undefined) {
			this.projectSettings = {};
			this.projectSettingsLoadError = null;
			this.settings = this.mergeEffectiveSettings();
			return;
		}

		this.projectSettings = projectLoad.settings;
		this.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.recordError("project", projectLoad.error);
		} else {
			this.recordValidationErrors("project", projectLoad);
		}
		this.settings = this.mergeEffectiveSettings();
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
			this.recordValidationErrors("global", globalLoad);
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", this.projectTrusted);
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
			this.recordValidationErrors("project", projectLoad);
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.settings = this.mergeEffectiveSettings();
	}
	/** Load a reload candidate without publishing any settings to live readers. */
	async prepareReload(): Promise<{ settingsManager: SettingsManager; commit: () => void }> {
		await this.writeQueue;
		const candidate = new SettingsManager(
			this.storage,
			structuredClone(this.globalSettings),
			structuredClone(this.projectSettings),
			this.globalSettingsLoadError,
			this.projectSettingsLoadError,
			[...this.errors],
			this.projectTrusted,
		);
		candidate.reportedInvalidSettings = new Set(this.reportedInvalidSettings);
		candidate.overrides = [...this.overrides];
		await candidate.reload();
		return {
			settingsManager: candidate,
			commit: () => this.publishReload(candidate),
		};
	}

	private publishReload(candidate: SettingsManager): void {
		this.globalSettings = candidate.globalSettings;
		this.projectSettings = candidate.projectSettings;
		this.settings = candidate.settings;
		this.projectTrusted = candidate.projectTrusted;
		this.modifiedFields = candidate.modifiedFields;
		this.modifiedNestedFields = candidate.modifiedNestedFields;
		this.modifiedProjectFields = candidate.modifiedProjectFields;
		this.modifiedProjectNestedFields = candidate.modifiedProjectNestedFields;
		this.globalSettingsLoadError = candidate.globalSettingsLoadError;
		this.projectSettingsLoadError = candidate.projectSettingsLoadError;
		this.errors = candidate.errors;
		this.reportedInvalidSettings = candidate.reportedInvalidSettings;
		this.overrides = candidate.overrides;
	}

	/**
	 * Apply additional overrides on top of current settings. They are never saved, and they keep applying over the
	 * loaded settings after setting writes, `reload()` and project trust changes for the rest of the run, until a setter
	 * changes the same setting.
	 */
	applyOverrides(overrides: Partial<Settings>): void {
		this.overrides.push(SettingsManager.migrateSettings(structuredClone(overrides) as Record<string, unknown>));
		this.settings = this.mergeEffectiveSettings();
	}

	/** An explicit change to a setting replaces its override; overrides of other settings and keys stay. */
	private dropOverride(field: keyof Settings, nestedKey?: string): void {
		if (isPrototypeKey(field) || (nestedKey !== undefined && isPrototypeKey(nestedKey))) return;
		for (const overrides of this.overrides) {
			if (!Object.hasOwn(overrides, field)) continue;
			const value: unknown = overrides[field];
			if (nestedKey !== undefined && isPlainObject(value)) {
				if (Object.hasOwn(value, nestedKey)) delete value[nestedKey];
			} else {
				const entries = nestedEntries(field, value);
				if (nestedKey === undefined || (Object.hasOwn(entries, nestedKey) && entries[nestedKey] !== undefined))
					delete overrides[field];
			}
		}
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.dropOverride(field, nestedKey);
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	private assertProjectTrustedForWrite(): void {
		if (!this.projectTrusted) {
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.assertProjectTrustedForWrite();
		this.dropOverride(field, nestedKey);
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push({ scope, error: normalizedError });
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		const owner = settingsWriteOwner.getStore() ?? ownedSettingsManagers.get(this);
		this.writeQueue = this.writeQueue
			.then(async () => {
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				await this.storage.prepareWriteLock?.(scope);
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				task();
				this.clearModifiedScope(scope);
				recordSettingsWrite(owner, scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
				recordSettingsWrite(owner, scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		const persist = (currentPrimary: string | undefined): string => {
			const currentFileSettings = currentPrimary
				? SettingsManager.migrateSettings(parseJsonFileContent(currentPrimary) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				if (isPrototypeKey(field)) continue;
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field)) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const inMemoryNested = nestedEntries(field, value);
					const mergedNested = { ...nestedEntries(field, currentFileSettings[field]) };
					for (const nestedKey of nestedModified) {
						if (isPrototypeKey(nestedKey)) continue;
						mergedNested[nestedKey] = Object.hasOwn(inMemoryNested, nestedKey)
							? inMemoryNested[nestedKey]
							: undefined;
					}
					const keys = Object.keys(mergedNested).filter((key) => mergedNested[key] !== undefined);
					// Keep list-form workflow paths a list, and drop an object the setter removed once nothing is left in it.
					(mergedSettings as Record<string, unknown>)[field] =
						Array.isArray(value) && keys.length === 1 && keys[0] === "paths"
							? mergedNested.paths
							: value === undefined && keys.length === 0
								? undefined
								: mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		};

		if (this.storage.withPrimaryWriteLock) {
			this.storage.withPrimaryWriteLock(scope, persist);
		} else {
			this.storage.withLock(scope, persist);
		}
	}

	private save(): void {
		this.settings = this.mergeEffectiveSettings();

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.assertProjectTrustedForWrite();
		this.projectSettings = structuredClone(settings);
		this.settings = this.mergeEffectiveSettings();

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	/**
	 * Replaces the `packages` of one scope with `update(current)`. The write applies `update` again to the packages
	 * in the settings file, read under its lock, so concurrent processes adding or removing packages keep each other's
	 * entries. `update` returns undefined to leave the packages unchanged. Returns whether this process's packages changed.
	 */
	updatePackages(scope: SettingsScope, update: (packages: PackageSource[]) => PackageSource[] | undefined): boolean {
		if (scope === "project") this.assertProjectTrustedForWrite();
		const current = scope === "project" ? this.projectSettings : this.globalSettings;
		const next = update(current.packages ?? []);
		if (next === undefined) return false;
		if (scope === "project") this.projectSettings = { ...this.projectSettings, packages: next };
		else this.globalSettings = { ...this.globalSettings, packages: next };
		this.settings = this.mergeEffectiveSettings();
		if (scope === "project" ? this.projectSettingsLoadError : this.globalSettingsLoadError) return true;

		const persist = (currentPrimary: string | undefined): string | undefined => {
			const fileSettings = currentPrimary
				? SettingsManager.migrateSettings(parseJsonFileContent(currentPrimary) as Record<string, unknown>)
				: {};
			const filePackages = update(fileSettings.packages ?? []);
			return filePackages === undefined
				? undefined
				: JSON.stringify({ ...fileSettings, packages: filePackages }, null, 2);
		};
		this.enqueueWrite(scope, () => {
			if (this.storage.withPrimaryWriteLock) this.storage.withPrimaryWriteLock(scope, persist);
			else this.storage.withLock(scope, persist);
		});
		return true;
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	/** Why the global settings could not be read, so this manager uses the defaults for them; null when they were read. */
	getGlobalSettingsLoadError(): Error | null {
		return this.globalSettingsLoadError;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	private touchSplitAccessorMethods(): void {
		void this.markModified;
		void this.markProjectModified;
		void this.save;
		void this.saveProjectSettings;
	}
}
