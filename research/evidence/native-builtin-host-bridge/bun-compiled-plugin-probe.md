# Authoritative compiled-binary host bridge probe

## Environment

- Bun: `1.4.0`
- OS/architecture: `Darwin arm64` (`uname -sm` => `Darwin arm64`)
- Repository branch: `perf/native-builtin-host-bridge`
- Scratch directory: `/tmp/atomic-host-bridge-probe`
- No tracked repository file was modified.

## Result table

| # | Answer | Evidence |
|---|---|---|
| 1 | **NO, for the requested onResolve/onLoad chain.** | In both a single-entry compiled executable and the production-shaped split executable, the plugin setup ran and `onResolve` saw the top-level external file path, but the external file's transitive bare imports bypassed `onResolve`; execution exited 1 with `Cannot find module '@bastani/getter'`. Thus runtime plugin registration exists, but the requested end-to-end external-module bridge does not work through `onResolve`/`onLoad`. |
| 2 | **NO.** | The catch-all `onResolve({filter: /.*/})` printed three resolutions for the external file path and printed no resolution for `@bastani/getter`; Bun then emitted `Cannot find module '@bastani/getter'`. |
| 3 | **N/A for onResolve/onLoad; YES through `build.module`.** | `onLoad` is unreachable because the bare specifier is not sent to `onResolve`. The adjacent supported `build.module` API delivered `named-value` correctly in all compiled shapes. |
| 4 | **N/A for onResolve/onLoad; YES through `build.module`.** | `build.module` surfaced an object literal's `default` key to `import def`, with `sameDefault=true`. Passing the real `node:path` namespace directly also surfaced its default with `pathDefaultIdentity=true`. |
| 5 | **N/A for onResolve/onLoad; YES through `build.module`.** | The external module and host both reported exact reference identity: `sameNamed=true`, `sameDefault=true`, `nsSame=true`, `pathNamedIdentity=true`, `pathDefaultIdentity=true`; host-side checks reported `shared=true default=true getter=true`. |
| 6 | **N/A for onResolve/onLoad; YES through `build.module`.** | After import, host mutation produced `HOST to external=host-mutated`; external mutation produced `EXTERNAL to host=external-mutated`. |
| 7 | **N/A for onResolve/onLoad; YES through `build.module`, without spreading/copying.** | The callback returned the real `await import("node:path")` namespace as `exports` and both named/default identity checks were true. A non-plain object with an enumerable getter also worked; the getter was read once (`getterReads=1`) and yielded the exact shared object. No error occurred and no spread was required. This proves object identity of exported values, not ongoing ESM binding reassignment after registration. |
| 8 | **NO for onResolve/onLoad, with and without bytecode; YES for `build.module`, with and without bytecode.** | Both `final-single-no-bytecode` and `final-single-bytecode` failed identically in onResolve mode and passed identically in builder-module mode. The bytecode split launcher also passed with `build.module`. |
| 9 | **YES, registration ordering matters.** | Import before registration failed with `Cannot find package '@bastani/order'`; a distinct external module imported after registration returned `ORDER after=registered`. Registration from bundled sibling `app.js` worked in the split executable when using `build.module`. |
| 10 | **YES: `build.module` works. `target` does not repair onResolve/onLoad. bunfig preload can embed a working `build.module` registration; `--preload` is not a compile-time embedding surface in the tested forms.** | `build.module` passed in single/split, bytecode/non-bytecode executions. `PROBE_TARGET=bun` still failed under onResolve/onLoad; `build.module` passed with both `target=bun` and `target=node`, so the option was accepted but did not alter observed behavior. A `bunfig.toml` preload was embedded and produced `PRELOAD_RESULT preloaded-module identity=true`. `bun build --compile --preload=<file>` and `bun --preload=<file> build --compile ...` built successfully but their executables did not run the preload and failed resolving `@bastani/preload`. |

## Verdict

**The runtime `Bun.plugin` onResolve/onLoad object-module surface is falsified for this use because, inside Bun 1.4.0 compiled binaries, the catch-all `onResolve` sees the dynamic import of the external file but does not see that external file's transitive bare imports, so `onLoad` cannot supply the host objects.** This is identical in the single-entry and production-shaped split/bytecode executables.

An adjacent supported runtime surface, `build.module(specifier, callback)`, **is proven to work** in the same compiled binaries and provides named/default exports, direct real ESM namespace objects, exact exported-object identity, and bidirectional shared-object mutation. It also works when registered from the bundled `app.js` sidecar and survives `--bytecode`.

If a build-time alternative were nevertheless required, the smallest identity-preserving form demonstrated by these semantics would be to rewrite the extension bundle's host-package imports at extension build time to embedded shim modules whose exported constants read references from a host-populated `globalThis[Symbol.for(...)]` registry before the external bundle is imported. That preserves reference identity and shared-object mutation without copying package state. This build-time alternative was not implemented or executed because the supported runtime `build.module` surface succeeded.

No numbered question remains unanswered. The one limitation explicitly distinguished above is that mutation testing covers properties of shared exported objects; it does not claim that reassigning a host ESM binding after `build.module` registration becomes a live ESM binding in the external module.

## Fixture files (full text)

### `entry.ts`

```ts
void (async () => {
const external = process.argv[2];
if (!external) throw new Error("missing external path");
const shared = { value: "initial" };
const defaultValue = { label: "default-object" };
const hostNamespace = await import("node:path");
let getterReads = 0;
const getterExports = Object.defineProperty({}, "getterShared", { enumerable: true, get() { getterReads++; return shared; } });
Object.assign(globalThis, {
  __probeHostShared: shared,
  __probeHostDefault: defaultValue,
  __probeHostNamespace: hostNamespace,
});
const mode = process.env.PROBE_MODE ?? "plugin";
const plugin = {
  name: "atomic-host-bridge",
  ...(process.env.PROBE_TARGET ? { target: process.env.PROBE_TARGET } : {}),
  setup(build: any) {
    console.log(`PLUGIN setup target=${process.env.PROBE_TARGET ?? "unset"}`);
    if (mode === "builder-module") {
      build.module("@bastani/atomic", () => ({
        exports: { default: defaultValue, shared, named: "named-value", hostNamespace },
        loader: "object",
      }));
      build.module("@bastani/path-namespace", () => ({ exports: hostNamespace, loader: "object" }));
      build.module("@bastani/getter", () => ({ exports: getterExports, loader: "object" }));
      return;
    }
    build.onResolve({ filter: /.*/ }, (args: any) => {
      console.log(`RESOLVE ${args.path}`);
      if (["@bastani/atomic", "@bastani/path-namespace", "@bastani/late"].includes(args.path)) return { path: args.path, namespace: "atomic-host" };
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "atomic-host" }, (args: any) => {
      console.log(`LOAD ${args.path}`);
      if (args.path === "@bastani/path-namespace") return { exports: hostNamespace, loader: "object" };
      return { exports: { default: defaultValue, shared, named: "named-value", hostNamespace }, loader: "object" };
    });
  },
};
Bun.plugin(plugin);
const extension = await import(`${external}?mode=${mode}&target=${process.env.PROBE_TARGET ?? ""}`);
console.log(`HOST identities shared=${Object.is(extension.importedShared, shared)} default=${Object.is(extension.importedDefault, defaultValue)} getter=${Object.is(extension.importedGetter, shared)} getterReads=${getterReads}`);
shared.value = "host-mutated";
console.log(`HOST to external=${extension.readShared()}`);
extension.mutateShared("external-mutated");
console.log(`EXTERNAL to host=${shared.value}`);
})();
```

### `external.mjs`

```js
import { getterShared } from "@bastani/getter";
import bridgeDefault, { shared, named, hostNamespace } from "@bastani/atomic";
import pathDefault, { posix, delimiter } from "@bastani/path-namespace";

console.log(`EXT named=${named} default=${bridgeDefault.label} sameNamed=${Object.is(shared, globalThis.__probeHostShared)} sameDefault=${Object.is(bridgeDefault, globalThis.__probeHostDefault)} nsSame=${Object.is(hostNamespace, globalThis.__probeHostNamespace)} pathPosix=${posix.sep} pathNamedIdentity=${Object.is(posix, globalThis.__probeHostNamespace.posix)} pathDefaultIdentity=${Object.is(pathDefault, globalThis.__probeHostNamespace.default)} delimiter=${delimiter}`);
export function readShared() { return shared.value; }
export function mutateShared(value) { shared.value = value; }
export const importedDefault = bridgeDefault;
export const importedShared = shared;
export const importedGetter = getterShared;
```

### `app-entry.ts`

```ts
void import("./entry.ts");
```

### `split-loader.ts`

```ts
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
void import(pathToFileURL(join(dirname(process.execPath), "app.js")).href);
```

### `ordering.ts`

```ts
void (async () => {
try { await import(process.argv[2]); } catch (error) { console.log(`ORDER before=${String(error)}`); }
const shared = { value: "registered" };
Bun.plugin({ name: "order", setup(build) { console.log("ORDER setup"); build.module("@bastani/order", () => ({ exports: { shared }, loader: "object" })); }});
const after = await import(process.argv[3]);
console.log(`ORDER after=${after.value}`);
})();
```

### `order-before.mjs`

```js
import { shared } from "@bastani/order";
export const value = shared.value;
```

### `order-after.mjs`

```js
import { shared } from "@bastani/order";
export const value = shared.value;
```

### `preload-module.ts`

```ts
const shared = { value: "preloaded-module" };
(globalThis as any).__preloadedShared = shared;
Bun.plugin({ name: "preload-module-bridge", setup(build) {
  console.log("PRELOAD_MODULE setup");
  build.module("@bastani/preload", () => ({ exports: { shared }, loader: "object" }));
}});
```

### `preload-entry.ts`

```ts
void (async () => {
const mod = await import(process.argv[2]);
console.log(`PRELOAD_RESULT ${mod.result} identity=${Object.is(mod.shared, (globalThis as any).__preloadedShared)}`);
})();
```

### `preload-external.mjs`

```js
import { shared } from "@bastani/preload";
export { shared };
export const result = shared.value;
```

### `bunfig.toml` (working preload case)

```toml
preload = ["./preload-module.ts"]
```

## Exact commands and observed outputs

All build commands below were run from `/Users/tonystark/Documents/projects/atomic-native-builtin-host-bridge` unless the command explicitly starts with `cd /tmp/atomic-host-bridge-probe`.

### Version/platform

```text
$ bun --version
EXIT 0
STDOUT:
1.4.0
STDERR:

$ uname -sm
EXIT 0
STDOUT:
Darwin arm64
STDERR:
```

### Single-entry compiled executable, onResolve/onLoad, without bytecode

```text
$ bun build --compile --format=cjs --no-compile-autoload-dotenv --no-compile-autoload-bunfig /tmp/atomic-host-bridge-probe/entry.ts --outfile /tmp/atomic-host-bridge-probe/final-single-no-bytecode
EXIT 0
STDOUT:
   [9ms]  bundle  1 modules
  [83ms] compile  /tmp/atomic-host-bridge-probe/final-single-no-bytecode
STDERR:

$ /tmp/atomic-host-bridge-probe/final-single-no-bytecode /tmp/atomic-host-bridge-probe/external.mjs
EXIT 1
STDOUT:
PLUGIN setup target=unset
RESOLVE /tmp/atomic-host-bridge-probe/external.mjs?mode=plugin&target=
RESOLVE /private/tmp/atomic-host-bridge-probe/external.mjs?mode=plugin&target=
RESOLVE /private/tmp/atomic-host-bridge-probe/external.mjs?mode=plugin&target=
STDERR:
error: Cannot find module '@bastani/getter' from '/private/tmp/atomic-host-bridge-probe/external.mjs?mode=plugin&target='

Bun v1.4.0 (macOS arm64)
```

### Single-entry compiled executable, onResolve/onLoad, with bytecode

```text
$ bun build --compile --bytecode --format=cjs --no-compile-autoload-dotenv --no-compile-autoload-bunfig /tmp/atomic-host-bridge-probe/entry.ts --outfile /tmp/atomic-host-bridge-probe/final-single-bytecode
EXIT 0
STDOUT:
   [5ms]  bundle  1 modules
  [64ms] compile  /tmp/atomic-host-bridge-probe/final-single-bytecode
STDERR:

$ /tmp/atomic-host-bridge-probe/final-single-bytecode /tmp/atomic-host-bridge-probe/external.mjs
EXIT 1
STDOUT:
PLUGIN setup target=unset
RESOLVE /tmp/atomic-host-bridge-probe/external.mjs?mode=plugin&target=
RESOLVE /private/tmp/atomic-host-bridge-probe/external.mjs?mode=plugin&target=
RESOLVE /private/tmp/atomic-host-bridge-probe/external.mjs?mode=plugin&target=
STDERR:
error: Cannot find module '@bastani/getter' from '/private/tmp/atomic-host-bridge-probe/external.mjs?mode=plugin&target='

Bun v1.4.0 (macOS arm64)
```

### Single-entry compiled executable, working `build.module`, without and with bytecode

```text
$ env PROBE_MODE=builder-module /tmp/atomic-host-bridge-probe/final-single-no-bytecode /tmp/atomic-host-bridge-probe/external.mjs
EXIT 0
STDOUT:
PLUGIN setup target=unset
EXT named=named-value default=default-object sameNamed=true sameDefault=true nsSame=true pathPosix=/ pathNamedIdentity=true pathDefaultIdentity=true delimiter=:
HOST identities shared=true default=true getter=true getterReads=1
HOST to external=host-mutated
EXTERNAL to host=external-mutated
STDERR:

$ env PROBE_MODE=builder-module /tmp/atomic-host-bridge-probe/final-single-bytecode /tmp/atomic-host-bridge-probe/external.mjs
EXIT 0
STDOUT:
PLUGIN setup target=unset
EXT named=named-value default=default-object sameNamed=true sameDefault=true nsSame=true pathPosix=/ pathNamedIdentity=true pathDefaultIdentity=true delimiter=:
HOST identities shared=true default=true getter=true getterReads=1
HOST to external=host-mutated
EXTERNAL to host=external-mutated
STDERR:
```

### Production-shaped split launcher/sidecar, exact flags, with bytecode

```text
$ bun build --target=bun --format=cjs /tmp/atomic-host-bridge-probe/app-entry.ts --outfile /tmp/atomic-host-bridge-probe/app.js
EXIT 0
STDOUT:
Bundled 2 modules in 3ms

  app.js  3.30 KB  (entry point)

STDERR:

$ bun build --compile --bytecode --format=cjs --no-compile-autoload-dotenv --no-compile-autoload-bunfig /tmp/atomic-host-bridge-probe/split-loader.ts --outfile /tmp/atomic-host-bridge-probe/final-split-bytecode
EXIT 0
STDOUT:
   [3ms]  bundle  1 modules
  [57ms] compile  /tmp/atomic-host-bridge-probe/final-split-bytecode
STDERR:

$ /tmp/atomic-host-bridge-probe/final-split-bytecode /tmp/atomic-host-bridge-probe/external.mjs
EXIT 1
STDOUT:
PLUGIN setup target=unset
RESOLVE /tmp/atomic-host-bridge-probe/external.mjs?mode=plugin&target=
RESOLVE /private/tmp/atomic-host-bridge-probe/external.mjs?mode=plugin&target=
RESOLVE /private/tmp/atomic-host-bridge-probe/external.mjs?mode=plugin&target=
STDERR:
error: Cannot find module '@bastani/getter' from '/private/tmp/atomic-host-bridge-probe/external.mjs?mode=plugin&target='

Bun v1.4.0 (macOS arm64)

$ env PROBE_MODE=builder-module /tmp/atomic-host-bridge-probe/final-split-bytecode /tmp/atomic-host-bridge-probe/external.mjs
EXIT 0
STDOUT:
PLUGIN setup target=unset
EXT named=named-value default=default-object sameNamed=true sameDefault=true nsSame=true pathPosix=/ pathNamedIdentity=true pathDefaultIdentity=true delimiter=:
HOST identities shared=true default=true getter=true getterReads=1
HOST to external=host-mutated
EXTERNAL to host=external-mutated
STDERR:
```

The same split sidecar was also run through a launcher compiled without `--bytecode`:

```text
$ bun build --compile --format=cjs --no-compile-autoload-dotenv --no-compile-autoload-bunfig /tmp/atomic-host-bridge-probe/split-loader.ts --outfile /tmp/atomic-host-bridge-probe/split-no-bytecode
EXIT 0
STDOUT:
   [3ms]  bundle  1 modules
  [64ms] compile  /tmp/atomic-host-bridge-probe/split-no-bytecode
STDERR:

$ env PROBE_MODE=builder-module /tmp/atomic-host-bridge-probe/split-no-bytecode /tmp/atomic-host-bridge-probe/external.mjs
EXIT 0
STDOUT:
PLUGIN setup target=unset
EXT named=named-value default=default-object sameNamed=true sameDefault=true nsSame=true pathPosix=/ delimiter=:
HOST identities shared=true default=true
HOST to external=host-mutated
EXTERNAL to host=external-mutated
STDERR:
```

(The no-bytecode split execution preceded the additional namespace-default/getter assertions; the final bytecode and both final single-entry runs include those stronger assertions.)

### Registration ordering

```text
$ bun build --compile --bytecode --format=cjs --no-compile-autoload-dotenv --no-compile-autoload-bunfig /tmp/atomic-host-bridge-probe/ordering.ts --outfile /tmp/atomic-host-bridge-probe/ordering
EXIT 0
STDOUT:
   [5ms]  bundle  1 modules
  [64ms] compile  /tmp/atomic-host-bridge-probe/ordering
STDERR:

$ /tmp/atomic-host-bridge-probe/ordering /tmp/atomic-host-bridge-probe/order-before.mjs /tmp/atomic-host-bridge-probe/order-after.mjs
EXIT 0
STDOUT:
ORDER before=ResolveMessage: Cannot find package '@bastani/order' imported from /private/tmp/atomic-host-bridge-probe/order-before.mjs
ORDER setup
ORDER after=registered
STDERR:
```

### Plugin `target` option

```text
$ env PROBE_TARGET=bun /tmp/atomic-host-bridge-probe/single-no-bytecode /tmp/atomic-host-bridge-probe/external.mjs
EXIT 1
STDOUT:
PLUGIN setup target=bun
STDERR:
error: Cannot find module '@bastani/atomic' from '/private/tmp/atomic-host-bridge-probe/external.mjs?mode=plugin&target=bun'

Bun v1.4.0 (macOS arm64)

$ env PROBE_MODE=builder-module PROBE_TARGET=bun /tmp/atomic-host-bridge-probe/single-getter /tmp/atomic-host-bridge-probe/external.mjs
EXIT 0
STDOUT:
PLUGIN setup target=bun
EXT named=named-value default=default-object sameNamed=true sameDefault=true nsSame=true pathPosix=/ pathNamedIdentity=true pathDefaultIdentity=true delimiter=:
HOST identities shared=true default=true getter=true getterReads=1
HOST to external=host-mutated
EXTERNAL to host=external-mutated
STDERR:

$ env PROBE_MODE=builder-module PROBE_TARGET=node /tmp/atomic-host-bridge-probe/single-getter /tmp/atomic-host-bridge-probe/external.mjs
EXIT 0
STDOUT:
PLUGIN setup target=node
EXT named=named-value default=default-object sameNamed=true sameDefault=true nsSame=true pathPosix=/ pathNamedIdentity=true pathDefaultIdentity=true delimiter=:
HOST identities shared=true default=true getter=true getterReads=1
HOST to external=host-mutated
EXTERNAL to host=external-mutated
STDERR:
```

### Preload surfaces

Working bunfig preload (build run from the scratch directory):

```text
$ cd /tmp/atomic-host-bridge-probe && bun build --compile --format=cjs ./preload-entry.ts --outfile ./preload-module-bunfig
EXIT 0
STDOUT:
   [4ms]  bundle  1 modules
  [71ms] compile  ./preload-module-bunfig
STDERR:

$ /tmp/atomic-host-bridge-probe/preload-module-bunfig /tmp/atomic-host-bridge-probe/preload-external.mjs
EXIT 0
STDOUT:
PRELOAD_MODULE setup
PRELOAD_RESULT preloaded-module identity=true
STDERR:
```

`--preload` forms did not embed the preload into the resulting executable:

```text
$ bun build --compile --preload=/tmp/atomic-host-bridge-probe/preload-module.ts --format=cjs /tmp/atomic-host-bridge-probe/preload-entry.ts --outfile /tmp/atomic-host-bridge-probe/preload-equals
EXIT 0
STDOUT:
   [8ms]  bundle  1 modules
  [83ms] compile  /tmp/atomic-host-bridge-probe/preload-equals
STDERR:

$ /tmp/atomic-host-bridge-probe/preload-equals /tmp/atomic-host-bridge-probe/preload-external.mjs
EXIT 1
STDOUT:
STDERR:
error: Cannot find module '@bastani/preload' from '/private/tmp/atomic-host-bridge-probe/preload-external.mjs'

Bun v1.4.0 (macOS arm64)

$ bun --preload=/tmp/atomic-host-bridge-probe/preload-module.ts build --compile --format=cjs /tmp/atomic-host-bridge-probe/preload-entry.ts --outfile /tmp/atomic-host-bridge-probe/preload-global
EXIT 0
STDOUT:
   [2ms]  bundle  1 modules
  [58ms] compile  /tmp/atomic-host-bridge-probe/preload-global
STDERR:

$ /tmp/atomic-host-bridge-probe/preload-global /tmp/atomic-host-bridge-probe/preload-external.mjs
EXIT 1
STDOUT:
STDERR:
error: Cannot find module '@bastani/preload' from '/private/tmp/atomic-host-bridge-probe/preload-external.mjs'

Bun v1.4.0 (macOS arm64)
```
