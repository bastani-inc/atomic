import { warnDeprecation } from "./deprecation.js";

/**
 * Where `@bastani/atomic-natives` reports that this platform's native package is missing, which installs that omit
 * optional dependencies leave out: a function set here, or the message it left before one was set. Its loader writes
 * them (packages/natives/scripts/generated-binding-fixes.ts).
 */
const REPORT_MISSING_PLATFORM_PACKAGE = Symbol.for("@bastani/atomic/natives/report-missing-platform-package");
const MISSING_PLATFORM_PACKAGE = Symbol.for("@bastani/atomic/natives/missing-platform-package");

type NativesRegistry = typeof globalThis & {
	[REPORT_MISSING_PLATFORM_PACKAGE]?: (message: string) => void;
	[MISSING_PLATFORM_PACKAGE]?: string;
};

/**
 * Warn once, in the UI when one shows it, the first time Atomic cannot load its native module because the platform
 * package is not installed. Atomic keeps running on its fallbacks.
 */
export function installNativeModuleWarning(): void {
	const state = globalThis as NativesRegistry;
	const warn = (message: string): void => warnDeprecation(message, { label: "Warning", showInUi: true });
	state[REPORT_MISSING_PLATFORM_PACKAGE] = warn;
	const reported = state[MISSING_PLATFORM_PACKAGE];
	if (reported === undefined) return;
	delete state[MISSING_PLATFORM_PACKAGE];
	warn(reported);
}
