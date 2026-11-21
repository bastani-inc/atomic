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
	// napi's miss message blames an npm bug and advises a reinstall that does not help. When the loader tried one of this
	// package's optional platform packages and it is not installed (an install that omits optional dependencies leaves
	// it out), name it and the install options that leave it out, and tell Atomic, which shows it as a warning
	// (packages/coding-agent/src/utils/native-module-warning.ts). Any other failure, such as a platform Atomic publishes no
	// package for or an installed package whose binary fails to load, keeps its cause and is not reported.
	const misleadingMiss = [
		"    const error = new Error(",
		"      `Cannot find native binding. ` +",
		"        `npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). ` +",
		"        'Please try `npm i` again after removing both package-lock.json and node_modules directory.',",
		"    )",
	].join("\n");
	const platformPackageMiss = `    let platformPackage
    try {
      const optionalPackages = require('../package.json').optionalDependencies || {}
      for (const loadError of loadErrors) {
        const match = /^Cannot find (?:module|package) '(@bastani\\/atomic-natives-[a-z0-9-]+)'/.exec(String(loadError && loadError.message))
        if (match && Object.prototype.hasOwnProperty.call(optionalPackages, match[1])) platformPackage = match[1]
      }
    } catch { /* Without its package metadata the loader names no package. */ }
    let missingPackage
    if (platformPackage) {
      try {
        require.resolve(\`\${platformPackage}/package.json\`)
      } catch (resolveError) {
        if (resolveError && resolveError.code === 'MODULE_NOT_FOUND') missingPackage = platformPackage
      }
    }
    const error = new Error(
      missingPackage
        ? \`Cannot find Atomic's native module: the optional package \${missingPackage} is not installed. \` +
            'Reinstall Atomic without omitting optional dependencies (npm --omit=optional, pnpm --no-optional and ' +
            'bun --omit=optional leave it out).'
        : platformPackage
          ? \`Cannot load Atomic's native module from \${platformPackage}.\`
          : "Cannot load Atomic's native module.",
    )`;
	const reportMiss = `    if (missingPackage) {
      try {
        const report = globalThis[Symbol.for('@bastani/atomic/natives/report-missing-platform-package')]
        if (typeof report === 'function') report(error.message)
        else globalThis[Symbol.for('@bastani/atomic/natives/missing-platform-package')] = error.message
      } catch { /* Reporting is optional. */ }
    }`;
	const missThrow = "    error.cause = createLoadErrorChain(loadErrors)\n    throw error\n  }\n  throw new Error(`Failed to load native binding`)";
	if (!loader.includes(platformPackageMiss)) {
		if (!loader.includes(misleadingMiss)) throw new Error("Review updated napi binding miss message");
		if (!loader.includes(missThrow)) throw new Error("Review updated napi binding miss error");
		loader = loader
			.replace(misleadingMiss, platformPackageMiss)
			.replace(missThrow, missThrow.replace("    throw error\n", `${reportMiss}\n    throw error\n`));
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
