export interface BundledPatchedPiMarker {
	readonly relativePath: string;
	readonly marker: string;
	readonly description: string;
}

export interface BundledPatchedPiRoot {
	readonly packageName: string;
	readonly issue: string;
	readonly materializeMode: "closure" | "root-only";
	readonly expectedRuntimePackages: readonly string[];
	readonly markerFiles: readonly BundledPatchedPiMarker[];
}

export const bundledPiTuiRootPackageName = "@earendil-works/pi-tui";
export const bundledPiAgentCoreRootPackageName = "@earendil-works/pi-agent-core";

export const bundledPiTuiExpectedRuntimePackages = [
	bundledPiTuiRootPackageName,
	"get-east-asian-width",
	"marked",
] as const;

// Sentinel string lifted from the TEMPORARY #1222 renderer patch: its presence in dist/tui.js is how
// we prove the patched pi-tui (not a stock copy) got bundled. Delete this once an upstream pi-tui
// release ships the fix and the bundling mechanism is removed.
export const bundledPiTuiPatchedRendererMarker = "Strict off-viewport same-count changes are state-only";

export const bundledPiAgentCoreNoActiveRunMarker = 'event.type === "tool_execution_update"';
export const bundledPiAgentCoreLifecycleGateMarker = "acceptingUpdates";

export const bundledPatchedPiRoots = [
	{
		packageName: bundledPiTuiRootPackageName,
		issue: "1222",
		materializeMode: "closure",
		expectedRuntimePackages: bundledPiTuiExpectedRuntimePackages,
		markerFiles: [
			{
				relativePath: "dist/tui.js",
				marker: bundledPiTuiPatchedRendererMarker,
				description: "temporary #1222 patched renderer marker",
			},
		],
	},
	{
		packageName: bundledPiAgentCoreRootPackageName,
		issue: "1273",
		materializeMode: "root-only",
		expectedRuntimePackages: [bundledPiAgentCoreRootPackageName],
		markerFiles: [
			{
				relativePath: "dist/agent.js",
				marker: bundledPiAgentCoreNoActiveRunMarker,
				description: "temporary #1273 no-active-run progress guard marker",
			},
			{
				relativePath: "dist/agent-loop.js",
				marker: bundledPiAgentCoreLifecycleGateMarker,
				description: "temporary #1273 tool progress lifecycle gate marker",
			},
		],
	},
] as const satisfies readonly BundledPatchedPiRoot[];

export function bundledPackageJsonTarPath(packageName: string): string {
	return `package/node_modules/${packageName}/package.json`;
}

export function bundledPackageTarPath(packageName: string, relativePackagePath: string): string {
	return `package/node_modules/${packageName}/${relativePackagePath}`;
}
