/**
 * Compile-time contract for the `[Unreleased]` changelog's removal of automatic model routing: `model: "auto"` is
 * resolved by `resolveAutoModel`, and the routing exports, settings and context members stay removed.
 */
import type { Api, Model } from "@bastani/atomic-ai/compat";
import {
	type AutoModelSelection,
	type AutoModelSettings,
	type ExtensionContext,
	type ResolveAutoModelOptions,
	resolveAutoModel,
	type Settings,
	type SettingsManager,
} from "../../src/index.ts";

declare const availableModels: readonly Model<Api>[];
declare const settings: Settings;

/** Saved settings are what `auto` reads. */
export const fromSettings: AutoModelSelection | undefined = resolveAutoModel({ settings, availableModels });
export const settingsShape: AutoModelSettings = settings;
export const options: ResolveAutoModelOptions = { availableModels, thinkingLevel: "high" };

type RootExports = typeof import("../../src/index.ts");
type RemovedRoutingExportName =
	| "routeExecutionModel"
	| "AutoRoutingInferenceError"
	| "ModelConstraintsSchema"
	| "parseModelConstraints"
	| "eligiblePair"
	| "setsProviders"
	| "TaskNeedsSchema"
	| "parseTaskNeeds"
	| "mergeTaskNeeds"
	| "WORK_KINDS"
	| "DIFFICULTY_LEVELS"
	| "MISTAKE_COST_LEVELS"
	| "reportModelRoutingDebug";
export type NoRemovedRoutingExports = Extract<keyof RootExports, RemovedRoutingExportName> extends never ? true : false;
export const noRemovedRoutingExports: NoRemovedRoutingExports = true;

export type NoModelRoutingSetting = "modelRouting" extends keyof Settings ? false : true;
export const noModelRoutingSetting: NoModelRoutingSetting = true;
export type NoGetModelRouting = "getModelRouting" extends keyof SettingsManager | keyof ExtensionContext ? false : true;
export const noGetModelRouting: NoGetModelRouting = true;
