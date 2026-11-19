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
	// A clock sample may use an already-loaded binding, but must never trigger package resolution or installation.
	const loadedTemporaryFiles = `if (process.platform === 'win32' && module.exports.createWindowsTemporaryRecord) {
  try { process[Symbol.for('@bastani/atomic/windows-temporary@2')] = new WeakRef(module.exports) } catch { /* Optional on restricted hosts. */ }
}`;
	if (!loader.includes(loadedTemporaryFiles)) loader = `${loader.trimEnd()}\n\n${loadedTemporaryFiles}\n`;
	return { loader, declarations };
}
