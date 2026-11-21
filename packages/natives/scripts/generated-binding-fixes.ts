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
	// napi's miss message blames an npm bug and advises a reinstall that does not help. Name the platform package that
	// is missing instead, and the install options that leave it out.
	const misleadingMiss = [
		"      `Cannot find native binding. ` +",
		"        `npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). ` +",
		"        'Please try `npm i` again after removing both package-lock.json and node_modules directory.',",
	].join("\n");
	const platformPackageMiss = [
		"      (__atomicNativePackageMissing()",
		"        ? `Cannot find Atomic's native module: the optional package ${__atomicNativePackage()} is not installed. ` +",
		"          'Reinstall Atomic without omitting optional dependencies (npm --omit=optional, pnpm --no-optional and ' +",
		"          'bun --omit=optional leave it out).'",
		"        : `Cannot load Atomic's native module from ${__atomicNativePackage()}.`),",
	].join("\n");
	const platformPackage = `function __atomicNativePackage() {
  const abi = process.platform === 'linux' ? (isMusl() ? '-musl' : '-gnu') : process.platform === 'win32' ? '-msvc' : ''
  return \`@bastani/atomic-natives-\${process.platform}-\${process.arch}\${abi}\`
}

function __atomicNativePackageMissing() {
  try {
    require.resolve(\`\${__atomicNativePackage()}/package.json\`)
    return false
  } catch {
    return true
  }
}`;
	// Atomic shows a missing platform package as a warning: the loader hands it the message, or leaves it for Atomic to
	// find when it sets up its warnings (packages/coding-agent/src/utils/native-module-warning.ts).
	const reportMiss = `    try {
      if (__atomicNativePackageMissing()) {
        const report = globalThis[Symbol.for('@bastani/atomic/natives/report-missing-platform-package')]
        if (typeof report === 'function') report(error.message)
        else globalThis[Symbol.for('@bastani/atomic/natives/missing-platform-package')] = error.message
      }
    } catch { /* Reporting is optional. */ }`;
	const missThrow = "    error.cause = createLoadErrorChain(loadErrors)\n    throw error\n  }\n  throw new Error(`Failed to load native binding`)";
	if (!loader.includes(platformPackageMiss)) {
		if (!loader.includes(misleadingMiss)) throw new Error("Review updated napi binding miss message");
		const missCheck = "if (!nativeBinding) {\n  if (loadErrors.length > 0) {";
		if (!loader.includes(missCheck)) throw new Error("Review updated napi binding miss check");
		loader = loader
			.replace(misleadingMiss, platformPackageMiss)
			.replace(missCheck, `${platformPackage}\n\n${missCheck}`);
	}
	if (!loader.includes(reportMiss)) {
		if (!loader.includes(missThrow)) throw new Error("Review updated napi binding miss error");
		loader = loader.replace(
			missThrow,
			missThrow.replace("    throw error\n", `${reportMiss}\n    throw error\n`),
		);
	}
	// A clock sample may use an already-loaded binding, but must never trigger package resolution or installation.
	const loadedTemporaryFiles = `if (process.platform === 'win32' && module.exports.readWindowsClockProbe && module.exports.windowsClockTick && module.exports.pinWindowsFile) {
  try {
    // Permission-managed hosts must perform their own filesystem checks.
    if (!process.permission) process[Symbol.for('@bastani/atomic/windows-temporary@4')] = new WeakRef(module.exports)
  } catch { /* Optional on restricted hosts. */ }
}`;
	if (!loader.includes(loadedTemporaryFiles)) loader = `${loader.trimEnd()}\n\n${loadedTemporaryFiles}\n`;
	return { loader, declarations };
}
