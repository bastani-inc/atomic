# @bastani/atomic-natives

Native Rust bindings for Atomic via N-API.

This package follows the same layout as `can1357/oh-my-pi`'s `packages/natives`: Rust code lives in `crates/atomic-natives`, while this package contains the generated NAPI-RS JavaScript loader (`native/index.js`), generated TypeScript declarations (`native/index.d.ts`), and release-time optional platform packages.

The first native surface is the Cursor HTTP/2 transport binding used by the bundled Cursor provider.

## Local development

Generated native binaries (`native/*.node`) are intentionally not committed. After cloning the workspace, build the platform-local binding before exercising Cursor's native HTTP/2 transport:

```sh
bun run --cwd packages/natives build
```

That command writes the current platform artifact, such as `native/atomic_natives.darwin-arm64.node` on Apple Silicon macOS, next to the generated NAPI-RS loader. Restart the Atomic process after rebuilding so any cached failed native load is cleared.
