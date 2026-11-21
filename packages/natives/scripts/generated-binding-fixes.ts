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
	// napi's miss message blames an npm bug and advises a reinstall that does not help. Say why the module did not load,
	// from the loader's own attempts: the platform package an install left out (one of this package's optional
	// dependencies) and how to reinstall Atomic with it, an installed platform package whose binary fails to load, a
	// platform Atomic publishes no package for (such as Android, FreeBSD or Windows under a MinGW build of Node), or a
	// NAPI_RS_NATIVE_LIBRARY_PATH override that fails. Atomic stops at startup with this message
	// (packages/coding-agent/src/utils/native-module.ts).
	const misleadingMiss = [
		"    const error = new Error(",
		"      `Cannot find native binding. ` +",
		"        `npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). ` +",
		"        'Please try `npm i` again after removing both package-lock.json and node_modules directory.',",
		"    )",
	].join("\n");
	const platformPackageMiss = `    const firstLine = (loadError) => String(loadError && loadError.message).split('\\n')[0]
    let publishedPackages = []
    try {
      publishedPackages = Object.keys(require('../package.json').optionalDependencies || {})
    } catch { /* Without its package metadata the loader knows of no platform package. */ }
    // The platform package this loader tried, as its own failure names it: the package, or a path inside it, on the
    // failure's first line (the lines after it list the modules that required it).
    let attempted
    let attemptError
    for (const loadError of loadErrors) {
      const match = /@bastani[\\\\/](atomic-natives-[a-z0-9-]+)/.exec(firstLine(loadError))
      if (match && !match[1].includes('wasm32-wasi') && attempted === undefined) {
        attempted = \`@bastani/\${match[1]}\`
        attemptError = loadError
      }
    }
    let installed = true
    if (attempted && publishedPackages.includes(attempted)) {
      try {
        require.resolve(\`\${attempted}/package.json\`)
      } catch (resolveError) {
        installed = !(resolveError && resolveError.code === 'MODULE_NOT_FOUND')
      }
    }
    const platformOf = (name) => name.slice('@bastani/atomic-natives-'.length)
    const error = new Error(
      process.env.NAPI_RS_NATIVE_LIBRARY_PATH
        ? \`Cannot load Atomic's native module from NAPI_RS_NATIVE_LIBRARY_PATH (\${process.env.NAPI_RS_NATIVE_LIBRARY_PATH}): \${firstLine(loadErrors[0])}\`
        : attempted && publishedPackages.includes(attempted)
          ? installed
            ? \`Cannot load Atomic's native module from \${attempted}: \${firstLine(attemptError)}\`
            : \`Atomic's native module is not installed: this install of Atomic omitted optional dependencies, which leaves out \${attempted}. \` +
              'Reinstall Atomic with optional dependencies: npm install -g @bastani/atomic, pnpm add -g @bastani/atomic or ' +
              'bun add -g @bastani/atomic, without --omit=optional (npm, Bun) or --no-optional (pnpm); in a project, run its ' +
              'install without those options.'
          : attempted && publishedPackages.length > 0
            ? \`Atomic has no native module for \${platformOf(attempted)}: it is published for \${publishedPackages.map(platformOf).join(', ')}.\`
            : \`Cannot load Atomic's native module: \${firstLine(loadErrors[0])}\`,
    )`;
	if (!loader.includes(platformPackageMiss)) {
		if (!loader.includes(misleadingMiss)) throw new Error("Review updated napi binding miss message");
		loader = loader.replace(misleadingMiss, platformPackageMiss);
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
