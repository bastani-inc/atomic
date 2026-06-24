# @bastani/atomic-natives

Native Rust bindings for Atomic via N-API.

Rust code lives in `crates/atomic-natives`, while this package contains the generated NAPI-RS JavaScript loader (`native/index.js`), generated TypeScript declarations (`native/index.d.ts`), and release-time optional platform packages.

Native surfaces include the Cursor HTTP/2 transport binding used by the bundled Cursor provider, a Rust-backed PTY session used by the `bash` tool when `pty: true` is requested, and oh-my-pi-derived `glob`/`grep`/`search` bindings used by Atomic's built-in `find` and `search` tools for full-level parity.
