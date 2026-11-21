`package-exports.json` lists the keys of each first-party package's `exports` map as released in 0.10.3 (`null` for a
package without one). Node and Bun read a package's `package.json` once per process, so a 0.10.3 process still running
when Atomic is updated in place resolves the updated files' imports of these packages through these maps.

Regenerate from the release tag:

```sh
for d in coding-agent ai agent tui codemode schema telemetry natives; do git show 0.10.3:packages/$d/package.json; done
```
