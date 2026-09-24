// napi-rs CLI 3.10.4 emits a redundant first WASI guard and a required marker
// declaration even though its CommonJS loader skips stamping frozen exports.
// Keep these corrections at generation time, without changing binding identity.
export function fixGeneratedBinding(loader: string, declarations: string) {
	const firstGuard = "if (!wasiBindingLoaded && (!__napiWasiFlavorRequested || __napiWasiFlavor === 'wasm32-wasi')) {";
	const correctedGuard = "if (!__napiWasiFlavorRequested || __napiWasiFlavor === 'wasm32-wasi') {";
	const marker = "export declare const __napiBindingTarget: 'native' | 'wasm32-wasi' | 'wasm32-wasip1'";
	if (!loader.includes(correctedGuard)) {
		if (!loader.includes(firstGuard)) throw new Error("Review updated napi WASI loader generation");
		loader = loader.replace(firstGuard, correctedGuard);
	}
	if (!declarations.includes(`${marker} | undefined`)) {
		if (!declarations.includes(marker)) throw new Error("Review updated napi binding marker declaration");
		declarations = declarations.replace(marker, `${marker} | undefined`);
	}
	// The guard exists only in Windows Rust builds. Keep its shared loader and
	// declaration exports when generated on a Unix development or release host.
	if (!loader.includes("module.exports.guardWindowsPostgresProcess")) {
		loader += `\nif (process.platform === 'win32') {\n  module.exports.WindowsPostgresProcessGuard = nativeBinding.WindowsPostgresProcessGuard\n  module.exports.guardWindowsPostgresProcess = nativeBinding.guardWindowsPostgresProcess\n}\n`;
	}
	if (!declarations.includes("export declare class WindowsPostgresProcessGuard")) {
		declarations = declarations.replace(
			"export declare class RunnerLease",
			"/** Available only on Windows. */\nexport declare class WindowsPostgresProcessGuard {\n  get status(): 'live' | 'absent' | 'mismatch'\n  exited(): boolean\n  close(): void\n}\n\nexport declare class RunnerLease",
		);
		declarations += "\n/** Available only on Windows. */\nexport declare function guardWindowsPostgresProcess(pid: number, expectedStartTime: number): WindowsPostgresProcessGuard\n";
	}
	return { loader, declarations };
}
