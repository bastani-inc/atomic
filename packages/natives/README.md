# @bastani/atomic-natives

Native Rust bindings for Atomic via N-API.

Rust code lives in `crates/atomic-natives`, while this package contains the generated NAPI-RS JavaScript loader (`native/index.js`), generated TypeScript declarations (`native/index.d.ts`), and release-time optional platform packages.

Native surfaces include the Cursor HTTP/2 transport binding used by the bundled Cursor provider, a Rust-backed PTY session used by the `bash` tool when `pty: true` is requested, and oh-my-pi-derived `glob`/`grep`/`search` bindings used by Atomic's built-in `find` and `search` tools for full-level parity.

## Local development

Generated native binaries (`native/*.node`) are intentionally not committed. After cloning the workspace, build the platform-local binding before exercising native surfaces:

```sh
bun run --cwd packages/natives build
```

That command writes the current platform artifact, such as `native/atomic_natives.darwin-arm64.node` on Apple Silicon macOS, next to the generated NAPI-RS loader. Restart the Atomic process after rebuilding so any cached failed native load is cleared.
