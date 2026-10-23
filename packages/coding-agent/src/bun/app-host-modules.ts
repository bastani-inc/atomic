/** The host modules the app bundle shares with the Intercom broker and workflow workers the standalone launcher runs. */
export type AppHostModuleSpecifier =
	| "@bastani/atomic"
	| "@bastani/atomic/storage"
	| "@bastani/atomic-natives"
	| "typebox"
	| "typebox/compile"
	| "typebox/value";

export interface AppHostModules {
	loadHostModule(specifier: AppHostModuleSpecifier): Promise<object>;
}

const HOST_MODULES_ONLY = Symbol.for("atomic.app.host-modules-only");
const flags = globalThis as typeof globalThis & Record<symbol, boolean | undefined>;

/** Marks the next app bundle load as a source of host modules only, so the bundle does not start the CLI. */
export function requestAppHostModulesOnly(): void {
	flags[HOST_MODULES_ONLY] = true;
}

export function isAppHostModulesOnly(): boolean {
	return flags[HOST_MODULES_ONLY] === true;
}
