import { writeSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "path";
import { getAgentConfigPaths, getAgentDir, getProjectConfigPaths } from "../config.js";
import { settingsFileNoticeKey, warnDeprecation } from "../utils/deprecation.js";
import { parseJsonFileContent } from "../utils/json.ts";
import { normalizeAzureSettings } from "./azure-provider-compat.js";
import { isDecisionConfigError } from "./decision/errors.js";
import { deepMergeSettings, isPrototypeKey } from "./settings-merge.js";
import {
	asyncSettingsStorage,
	FileSettingsStorage,
	InMemorySettingsStorage,
	SettingsFileChangedError,
} from "./settings-storage.ts";
import type {
	AsyncSettingsStorage,
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
	/** File paths kept only for the read-only migration catalog, never as active settings. */
	legacyWorkflowPaths?: string[];
	settings: Settings;
	invalid: InvalidLayerValue[];
	error: Error | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedEntries(value: unknown): Record<string, unknown> {
	return isPlainObject(value) ? value : {};
}

type PersistSettings = (currentPrimary: string | undefined) => string | undefined;

/**
 * What a write saves: a top-level setting (`theme`), or one key of a nested setting (`retry\0provider`). A write saves
 * only the keys it still holds, so a newer write that saved a key takes it from an older one that gave up.
 */
type SettingsKey = string;

// Startup itself writes these markers. Reporting an update or generating an ID is not a user's settings choice.
const startupMarkers = new Set<keyof Settings>([
	"lastChangelogVersion",
	"onboardedVersion",
	"firstRunOnboardingStartedVersion",
	"trackingId",
	"deviceId",
]);

function nestedKey(field: string, key: string): SettingsKey {
	return `${field}\0${key}`;
}

/** Whether a write that saved `written` saved `key`: the key itself, or the whole setting a nested key belongs to. */
function savedBy(written: ReadonlySet<SettingsKey>, key: SettingsKey): boolean {
	const nested = key.indexOf("\0");
	return written.has(key) || (nested >= 0 && written.has(key.slice(0, nested)));
}

interface UnsavedWrite {
	readonly manager: SettingsManager;
	readonly scope: SettingsScope;
	readonly persist: PersistSettings;
	/** Enqueue order: a write takes keys only from older writes. */
	readonly sequence: number;
	/** The keys this write still has to save. */
	readonly keys: Set<SettingsKey>;
	/**
	 * For a setting this write saves whole, the keys of it a newer write saved: this write leaves those as the file has
	 * them.
	 */
	readonly kept: Map<string, Set<string>>;
	/**
	 * The write gave up because something kept saving the file without the lock, such as an editor. It stays unsaved:
	 * the next `flush()` tries it again, and so does the save at exit, which reports it on stderr when it fails again.
	 */
	gaveUp?: boolean;
}

const unsavedWrites: UnsavedWrite[] = [];
let unsavedWriteSequence = 0;
let exitSaveRegistered = false;

export class SettingsManager {
	/** A defensive snapshot of the effective merged settings. */
	getSettings(): Settings {
		return structuredClone(this.settings);
	}

	private storage: SettingsStorage;
	private asyncStorage: AsyncSettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings;
	private projectTrusted: boolean;
	private legacyWorkflowPaths: Partial<Record<SettingsScope, string[]>> = {};

	/** Migration input only: recipe paths from settings files this manager was allowed to read. */
	getLegacyWorkflowFilePaths(scope: SettingsScope): string[] {
		return [...(this.legacyWorkflowPaths[scope] ?? [])];
	}
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
	/** Global settings edited while the startup UI is waiting for the folder's settings. */
	private pendingProjectEdits?: Set<SettingsKey>;
	private approvedProjectEdits?: Set<SettingsKey>;

	trackEditsWhileProjectTrustPending(pending: boolean): void {
		if (pending) this.pendingProjectEdits ??= new Set();
		else this.pendingProjectEdits = undefined;
	}

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
		this.asyncStorage = asyncSettingsStorage(storage);
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
		let project = this.projectSettings;
		if (this.approvedProjectEdits?.size) {
			// Ignore just the approved folder's fields that the user already changed. Neither file changes scope;
			// deleting a global setting still means selecting its default, not adopting the project value.
			const filtered: Record<string, unknown> = { ...project };
			for (const key of this.approvedProjectEdits) {
				const split = key.indexOf("\0");
				if (split < 0) delete filtered[key];
				else {
					const field = key.slice(0, split) as keyof Settings;
					if (!Object.hasOwn(filtered, field)) continue;
					const values = nestedEntries(filtered[field]);
					const nested = key.slice(split + 1);
					if (!Object.hasOwn(values, nested)) continue;
					if (filtered[field] === project[field]) filtered[field] = { ...values };
					delete (filtered[field] as Record<string, unknown>)[nested];
				}
			}
			project = filtered;
		}
		return this.overrides.reduce(
			(settings, overrides) => deepMergeSettings(settings, overrides),
			deepMergeSettings(this.globalSettings, project),
		);
	}

	/** Create a SettingsManager that loads from files */
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		return SettingsManager.fromStorage(SettingsManager.fileStorage(cwd, agentDir), options);
	}

	static async createAsync(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): Promise<SettingsManager> {
		const storage = SettingsManager.fileStorage(cwd, agentDir);
		const projectTrusted = options.projectTrusted ?? true;
		await SettingsManager.unsavedWritesSettled();
		const globalLoad = await SettingsManager.tryLoadFromStorageAsync(storage, storage, "global");
		const projectLoad = await SettingsManager.tryLoadFromStorageAsync(storage, storage, "project", projectTrusted);
		return SettingsManager.fromLoads(storage, globalLoad, projectLoad, projectTrusted);
	}

	private static fileStorage(cwd: string, agentDir: string): FileSettingsStorage {
		return new FileSettingsStorage(cwd, agentDir, {
			globalReadPaths:
				agentDir === getAgentDir() ? getAgentConfigPaths("settings.json") : [join(agentDir, "settings.json")],
			projectReadPaths: getProjectConfigPaths(cwd, "settings.json"),
		});
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		return SettingsManager.fromLoads(storage, globalLoad, projectLoad, projectTrusted);
	}

	private static fromLoads(
		storage: SettingsStorage,
		globalLoad: SettingsLoad,
		projectLoad: SettingsLoad,
		projectTrusted: boolean,
	): SettingsManager {
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

		const manager = new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
		);
		manager.legacyWorkflowPaths = {
			global: globalLoad.legacyWorkflowPaths,
			project: projectLoad.legacyWorkflowPaths,
		};
		return manager;
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		const content = JSON.stringify(initialSettings, null, 2);
		storage.withLock("global", () => content);
		const globalLoad = SettingsManager.tryLoad(() => SettingsManager.parseLayers(storage, "global", [{ content }]));
		const projectLoad: SettingsLoad = { settings: {}, invalid: [], error: null };
		return SettingsManager.fromLoads(storage, globalLoad, projectLoad, true);
	}

	private static loadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): Omit<SettingsLoad, "error"> {
		if (scope === "project" && !projectTrusted) {
			return { settings: {}, invalid: [] };
		}
		return SettingsManager.parseLayers(storage, scope, SettingsManager.readLayers(storage, scope));
	}

	private static async loadFromStorageAsync(
		storage: SettingsStorage,
		asyncStorage: AsyncSettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): Promise<Omit<SettingsLoad, "error">> {
		if (scope === "project" && !projectTrusted) {
			return { settings: {}, invalid: [] };
		}
		return SettingsManager.parseLayers(storage, scope, await SettingsManager.readLayersAsync(asyncStorage, scope));
	}

	private static parseLayers(
		storage: SettingsStorage,
		scope: SettingsScope,
		files: { path?: string; content: string }[],
	): Omit<SettingsLoad, "error"> {
		// Each file is validated and migrated on its own, highest precedence first, then merged from the lowest up.
		const invalid: InvalidLayerValue[] = [];
		let legacyWorkflowPaths: string[] | undefined;
		const layers = files.map(({ path, content }) => {
			let settings: Parameters<typeof dropWrongTypedSettings>[0];
			try {
				settings = parseJsonFileContent(content) as Parameters<typeof dropWrongTypedSettings>[0];
			} catch (error) {
				if (path !== undefined && error instanceof Error) (error as Error & { path?: string }).path = path;
				throw error;
			}
			const workflows = settings.workflows;
			const paths = isPlainObject(workflows) ? workflows.paths : workflows;
			if (legacyWorkflowPaths === undefined && Array.isArray(paths)) {
				legacyWorkflowPaths = paths.filter((path): path is string => typeof path === "string");
			}
			for (const value of dropWrongTypedSettings(settings)) {
				invalid.push({ ...value, path: path ?? storage.getFieldPath?.(scope, value.setting) });
			}
			return SettingsManager.migrateSettings(settings, { path });
		});
		const settings = layers.reduceRight<Settings>((merged, layer) => deepMergeSettings(merged, layer), {});
		return { settings, invalid, legacyWorkflowPaths };
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

	private static async readLayersAsync(
		storage: AsyncSettingsStorage,
		scope: SettingsScope,
	): Promise<{ path?: string; content: string }[]> {
		if (storage.readLayersAsync) return storage.readLayersAsync(scope);
		let content: string | undefined;
		await storage.withLockAsync(scope, (current) => {
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
		return SettingsManager.tryLoad(() => SettingsManager.loadFromStorage(storage, scope, projectTrusted));
	}

	private static tryLoad(load: () => Omit<SettingsLoad, "error">): SettingsLoad {
		try {
			return { ...load(), error: null };
		} catch (error) {
			if (isDecisionConfigError(error)) throw error;
			return { settings: {}, invalid: [], error: error as Error };
		}
	}

	private static async tryLoadFromStorageAsync(
		storage: SettingsStorage,
		asyncStorage: AsyncSettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): Promise<SettingsLoad> {
		try {
			return {
				...(await SettingsManager.loadFromStorageAsync(storage, asyncStorage, scope, projectTrusted)),
				error: null,
			};
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
		return invalid;
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

	/**
	 * Migrate old settings format to new format. `path` names the file the settings were read from: a warning about a
	 * setting it ignores is shown once across starts while that setting keeps its value, and a removed routing setting's
	 * warning waits while startup still removes that setting from the file (see `removeSavedModelRoutingSettings`).
	 * `quiet` migrates without warning, for a save, which reports nothing a load has not.
	 */
	private static migrateSettings(
		settings: Record<string, unknown>,
		{ path, quiet = false }: { path?: string; quiet?: boolean } = {},
	): Settings {
		const file = path === undefined ? undefined : settingsFileNoticeKey(path);
		const about = (value: unknown) => (file === undefined ? undefined : `${file}\0${JSON.stringify(value) ?? ""}`);
		const warn = quiet ? () => {} : warnDeprecation;
		// Migrate routerModel -> decisionModel before normalizing provider IDs.
		if ("routerModel" in settings) {
			if ("decisionModel" in settings) {
				warn('Ignored legacy "routerModel" because "decisionModel" is already set.', {
					once: about(settings.routerModel),
				});
			} else if (typeof settings.routerModel === "string" && settings.routerModel.trim() === settings.routerModel) {
				settings.decisionModel = settings.routerModel;
			} else {
				warn(
					'Ignored invalid legacy "routerModel"; set "decisionModel" to an exact provider/model ID, "auto", or an empty string.',
					{ once: about(settings.routerModel) },
				);
			}
			delete settings.routerModel;
		}
		// Automatic model routing was removed; its settings are dropped.
		if ("modelRouting" in settings) {
			warn(
				'Ignored removed setting "modelRouting": automatic model routing was removed, so "auto" runs your default model and its provider and model restrictions no longer limit "auto" or any fallback model.',
				{ hold: file, once: about(settings.modelRouting) },
			);
			delete settings.modelRouting;
		}
		// Leave legacy definitions and path settings on disk. They can still be located and read as text.
		const source = path === undefined ? "" : `${path}: `;
		if ("workflows" in settings) {
			warn(
				`${source}Ignored removed setting "workflows": workflows were removed in 0.10.0; run work with codemode and subagents (see docs/orchestration.md). Your workflow files were not changed.`,
				{
					once: about(settings.workflows),
				},
			);
			delete settings.workflows;
		}
		if (isPlainObject(settings.intercom) && "showUnknownTargetWarnings" in settings.intercom) {
			warn(
				`${source}Ignored removed setting "intercom.showUnknownTargetWarnings": Intercom no longer sends to workflow stages.`,
				{ once: about(settings.intercom.showUnknownTargetWarnings) },
			);
			delete settings.intercom.showUnknownTargetWarnings;
			if (Object.keys(settings.intercom).length === 0) delete settings.intercom;
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
		this.applyProjectTrust(
			trusted,
			trusted ? SettingsManager.tryLoadFromStorage(this.storage, "project", true) : undefined,
		);
	}

	async setProjectTrustedAsync(trusted: boolean): Promise<void> {
		if (this.projectTrusted === trusted) {
			return;
		}
		const projectLoad = trusted
			? await SettingsManager.tryLoadFromStorageAsync(this.storage, this.asyncStorage, "project", true)
			: undefined;
		if (this.projectTrusted === trusted) {
			return;
		}
		this.applyProjectTrust(trusted, projectLoad);
	}

	private applyProjectTrust(trusted: boolean, projectLoad: SettingsLoad | undefined): void {
		if (projectLoad && this.pendingProjectEdits) {
			for (const key of this.pendingProjectEdits) {
				const split = key.indexOf("\0");
				const field = (split < 0 ? key : key.slice(0, split)) as keyof Settings;
				const present =
					split < 0
						? Object.hasOwn(projectLoad.settings, field)
						: Object.hasOwn(nestedEntries(projectLoad.settings[field]), key.slice(split + 1));
				if (!present) this.pendingProjectEdits.delete(key);
			}
			if (this.pendingProjectEdits.size) this.approvedProjectEdits = this.pendingProjectEdits;
			this.pendingProjectEdits = undefined;
		}
		this.projectTrusted = trusted;
		this.legacyWorkflowPaths.project = projectLoad?.legacyWorkflowPaths;
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
		let globalLoad: SettingsLoad;
		let projectLoad: SettingsLoad;
		for (;;) {
			const writes = this.writeQueue;
			await SettingsManager.unsavedWritesSettled();
			globalLoad = await SettingsManager.tryLoadFromStorageAsync(this.storage, this.asyncStorage, "global");
			projectLoad = await SettingsManager.tryLoadFromStorageAsync(
				this.storage,
				this.asyncStorage,
				"project",
				this.projectTrusted,
			);
			if (this.writeQueue === writes) break;
		}
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.legacyWorkflowPaths.global = globalLoad.legacyWorkflowPaths;
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

		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.legacyWorkflowPaths.project = projectLoad.legacyWorkflowPaths;
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
		candidate.legacyWorkflowPaths = { ...this.legacyWorkflowPaths };
		candidate.reportedInvalidSettings = new Set(this.reportedInvalidSettings);
		candidate.overrides = [...this.overrides];
		candidate.approvedProjectEdits = this.approvedProjectEdits;
		await candidate.reload();
		return {
			settingsManager: candidate,
			commit: () => this.publishReload(candidate),
		};
	}

	private publishReload(candidate: SettingsManager): void {
		this.legacyWorkflowPaths = candidate.legacyWorkflowPaths;
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
		if (this.approvedProjectEdits) {
			// A later explicit save uses its offered scope and the ordinary layer order, even for the same value.
			for (const key of this.approvedProjectEdits) {
				if (
					key === field ||
					(nestedKey === undefined ? key.startsWith(`${field}\0`) : key === `${field}\0${nestedKey}`)
				)
					this.approvedProjectEdits.delete(key);
			}
			if (!this.approvedProjectEdits.size) this.approvedProjectEdits = undefined;
		}
		for (const overrides of this.overrides) {
			if (!Object.hasOwn(overrides, field)) continue;
			const value: unknown = overrides[field];
			if (nestedKey !== undefined && isPlainObject(value)) {
				if (Object.hasOwn(value, nestedKey)) delete value[nestedKey];
			} else {
				const entries = nestedEntries(value);
				if (nestedKey === undefined || (Object.hasOwn(entries, nestedKey) && entries[nestedKey] !== undefined))
					delete overrides[field];
			}
		}
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.dropOverride(field, nestedKey);
		if (
			this.pendingProjectEdits &&
			!startupMarkers.has(field) &&
			!isPrototypeKey(field) &&
			(nestedKey === undefined || !isPrototypeKey(nestedKey))
		) {
			this.pendingProjectEdits.add(nestedKey === undefined ? field : `${field}\0${nestedKey}`);
		}
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

	/**
	 * Queue a write of `keys`; `makePersist` writes only the keys still held in the set it is given, and of a setting it
	 * saves whole, leaves the keys in `kept` as the file has them.
	 */
	private enqueueWrite(
		scope: SettingsScope,
		keys: Iterable<SettingsKey>,
		makePersist: (keys: ReadonlySet<SettingsKey>, kept: ReadonlyMap<string, ReadonlySet<string>>) => PersistSettings,
	): void {
		const held = new Set(keys);
		const kept = new Map<string, Set<string>>();
		const unsaved: UnsavedWrite = {
			manager: this,
			scope,
			persist: makePersist(held, kept),
			sequence: ++unsavedWriteSequence,
			keys: held,
			kept,
		};
		unsavedWrites.push(unsaved);
		if (!exitSaveRegistered) {
			exitSaveRegistered = true;
			process.once("exit", () => SettingsManager.saveUnsavedWritesAtExit());
		}
		this.runWrite(unsaved);
	}

	private runWrite(unsaved: UnsavedWrite): void {
		const { scope, persist } = unsaved;
		const owner = settingsWriteOwner.getStore() ?? ownedSettingsManagers.get(this);
		unsaved.gaveUp = false;
		this.writeQueue = this.writeQueue
			.then(async () => {
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				await this.storage.prepareWriteLock?.(scope);
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				const written = new Set(unsaved.keys);
				await SettingsManager.writePrimary(this.asyncStorage, scope, persist);
				this.clearModifiedScope(scope);
				recordSettingsWrite(owner, scope);
				// An older write that gave up no longer saves the keys this one saved; it is done once it holds none.
				for (const earlier of unsavedWrites.filter(
					(write) =>
						write.manager === this && write.scope === scope && write.gaveUp && write.sequence < unsaved.sequence,
				)) {
					SettingsManager.yieldSavedKeys(earlier, written);
					if (earlier.keys.size === 0) unsavedWrites.splice(unsavedWrites.indexOf(earlier), 1);
				}
			})
			.catch((error) => {
				this.recordError(scope, error);
				recordSettingsWrite(owner, scope, error);
				if (error instanceof SettingsFileChangedError) unsaved.gaveUp = true;
			})
			.finally(() => {
				if (unsaved.gaveUp) return;
				const index = unsavedWrites.indexOf(unsaved);
				if (index >= 0) unsavedWrites.splice(index, 1);
			});
	}

	/**
	 * An older write gives up what a newer one saved: a key the newer write saved, or covered by a setting it saved
	 * whole; and of a setting the older write saves whole, the keys of it the newer write saved, which it then leaves
	 * as the file has them.
	 */
	private static yieldSavedKeys(earlier: UnsavedWrite, written: ReadonlySet<SettingsKey>): void {
		for (const key of [...earlier.keys]) {
			if (savedBy(written, key)) {
				earlier.keys.delete(key);
				continue;
			}
			if (key.includes("\0")) continue;
			for (const savedKey of written) {
				if (!savedKey.startsWith(`${key}\0`)) continue;
				const kept = earlier.kept.get(key) ?? new Set<string>();
				kept.add(savedKey.slice(key.length + 1));
				earlier.kept.set(key, kept);
			}
		}
	}

	private static saveUnsavedWritesAtExit(): void {
		for (const { manager, scope, persist } of unsavedWrites.splice(0)) {
			if (scope === "project" && !manager.projectTrusted) continue;
			try {
				if (manager.storage instanceof FileSettingsStorage)
					manager.storage.withPrimaryWriteLockAtExit(scope, persist);
				else if (manager.storage.withPrimaryWriteLock) manager.storage.withPrimaryWriteLock(scope, persist);
				else manager.storage.withLock(scope, persist);
			} catch (error) {
				// The process is exiting: say so synchronously, and never throw from its exit handler.
				const reason = error instanceof Error ? error.message : String(error);
				try {
					writeSync(2, `Warning: Atomic could not save your ${scope} settings before exiting: ${reason}\n`);
				} catch {}
			}
		}
	}

	private static async unsavedWritesSettled(): Promise<void> {
		for (let writing = unsavedWrites.filter((write) => !write.gaveUp); writing.length > 0; ) {
			await Promise.all([...new Set(writing.map(({ manager }) => manager.writeQueue))]);
			writing = unsavedWrites.filter((write) => !write.gaveUp);
		}
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private enqueueScopedSettingsWrite(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		const keys: SettingsKey[] = [];
		for (const field of modifiedFields) {
			if (isPrototypeKey(field)) continue;
			const nested = modifiedNestedFields.get(field);
			if (nested === undefined) keys.push(field);
			else for (const key of nested) if (!isPrototypeKey(key)) keys.push(nestedKey(field, key));
		}
		const makePersist =
			(held: ReadonlySet<SettingsKey>, kept: ReadonlyMap<string, ReadonlySet<string>>) =>
			(currentPrimary: string | undefined) => {
				const { raw, saved, migrated: currentFileSettings } = SettingsManager.readSavedFile(currentPrimary);
				const mergedSettings = { ...saved } as Settings;
				const writtenFields = new Set<string>();
				for (const field of modifiedFields) {
					if (isPrototypeKey(field)) continue;
					const value = snapshotSettings[field];
					if (modifiedNestedFields.has(field)) {
						const nestedModified = [...modifiedNestedFields.get(field)!].filter((key) =>
							held.has(nestedKey(field, key)),
						);
						if (nestedModified.length === 0) continue;
						writtenFields.add(field);
						const inMemoryNested = nestedEntries(value);
						const mergedNested = { ...nestedEntries(currentFileSettings[field]) };
						for (const nestedKey of nestedModified) {
							if (isPrototypeKey(nestedKey)) continue;
							mergedNested[nestedKey] = Object.hasOwn(inMemoryNested, nestedKey)
								? inMemoryNested[nestedKey]
								: undefined;
						}
						const keys = Object.keys(mergedNested).filter((key) => mergedNested[key] !== undefined);
						// Drop an object the setter removed once nothing is left in it.
						(mergedSettings as Record<string, unknown>)[field] =
							value === undefined && keys.length === 0 ? undefined : mergedNested;
					} else {
						if (!held.has(field)) continue;
						writtenFields.add(field);
						const keptKeys = kept.get(field);
						if (keptKeys === undefined || keptKeys.size === 0) {
							(mergedSettings as Record<string, unknown>)[field] = value;
							continue;
						}
						// A newer write saved some keys of this setting: they stay as the file has them.
						const fromFile = nestedEntries(currentFileSettings[field]);
						const mergedNested = { ...nestedEntries(value) };
						for (const key of keptKeys) mergedNested[key] = fromFile[key];
						const present = Object.keys(mergedNested).filter((key) => mergedNested[key] !== undefined);
						(mergedSettings as Record<string, unknown>)[field] =
							present.length === 0
								? undefined
								: Object.fromEntries(present.map((key) => [key, mergedNested[key]]));
					}
				}

				return JSON.stringify(
					SettingsManager.keepDerivedSettings(mergedSettings as Record<string, unknown>, raw, writtenFields),
					null,
					2,
				);
			};

		this.enqueueWrite(scope, keys, makePersist);
	}

	/**
	 * Keep every setting the save did not change: compared as loading reads them, with wrong-typed values dropped and
	 * legacy forms migrated, any other setting whose value would change is written in its current form. A save that
	 * replaces a legacy form, such as the `skills` object that also carried `enableSkillCommands`, so writes the other
	 * values that form held. A key the save leaves on disk stays, even when loading ignores it.
	 */
	private static keepDerivedSettings(
		next: Record<string, unknown>,
		currentRaw: Record<string, unknown>,
		writtenFields: ReadonlySet<string>,
	): Record<string, unknown> {
		const before = SettingsManager.effectiveFileSettings(currentRaw);
		const after = SettingsManager.effectiveFileSettings(next);
		for (const field of Object.keys(before)) {
			if (writtenFields.has(field) || isPrototypeKey(field) || before[field] === undefined) continue;
			if (!isDeepStrictEqual(after[field], before[field])) next[field] = structuredClone(before[field]);
		}
		return next;
	}

	/** A settings file's settings as loading reads them: wrong-typed values dropped, then legacy forms migrated. */
	private static effectiveFileSettings(raw: Record<string, unknown>): Record<string, unknown> {
		const settings = structuredClone(raw) as Parameters<typeof dropWrongTypedSettings>[0];
		dropWrongTypedSettings(settings);
		return SettingsManager.migrateSettings(settings, { quiet: true }) as Record<string, unknown>;
	}

	/**
	 * The settings file a save starts from: `saved` holds every key as it is on disk, legacy and unknown keys included,
	 * except the removed `modelRouting` setting; `migrated` is how loading reads it, to merge a changed field into. A
	 * save rewrites only the fields it changes, so it never drops a key the user saved.
	 */
	private static readSavedFile(currentPrimary: string | undefined): {
		raw: Record<string, unknown>;
		saved: Record<string, unknown>;
		migrated: Settings;
	} {
		const raw = currentPrimary ? (parseJsonFileContent(currentPrimary) as Record<string, unknown>) : {};
		const migrated = SettingsManager.migrateSettings(structuredClone(raw), { quiet: true });
		const { modelRouting: _removed, ...saved } = raw;
		return { raw, saved, migrated };
	}

	private static async writePrimary(
		storage: AsyncSettingsStorage,
		scope: SettingsScope,
		persist: PersistSettings,
	): Promise<void> {
		if (storage.withPrimaryWriteLockAsync) await storage.withPrimaryWriteLockAsync(scope, persist);
		else await storage.withLockAsync(scope, persist);
	}

	private save(): void {
		this.settings = this.mergeEffectiveSettings();

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueScopedSettingsWrite("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
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
		this.enqueueScopedSettingsWrite("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
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

		const makePersist = (held: ReadonlySet<SettingsKey>) => (currentPrimary: string | undefined) => {
			if (!held.has("packages")) return undefined;
			const { raw, saved, migrated } = SettingsManager.readSavedFile(currentPrimary);
			const filePackages = update(migrated.packages ?? []);
			if (filePackages === undefined) return undefined;
			const next = SettingsManager.keepDerivedSettings(
				{ ...saved, packages: filePackages },
				raw,
				new Set(["packages"]),
			);
			return JSON.stringify(next, null, 2);
		};
		this.enqueueWrite(scope, ["packages"], makePersist);
		return true;
	}

	/** Wait for this manager's saves, trying again any that gave up to an editor saving the file meanwhile. */
	async flush(): Promise<void> {
		await this.writeQueue;
		const gaveUp = unsavedWrites.filter((write) => write.manager === this && write.gaveUp);
		if (gaveUp.length === 0) return;
		for (const write of gaveUp) this.runWrite(write);
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
