# @bastani/atomic-natives

Native Rust bindings for Atomic via N-API.

This package follows the same layout as `can1357/oh-my-pi`'s `packages/natives`: Rust code lives in `crates/atomic-natives`, while this package contains the generated NAPI-RS JavaScript loader (`native/index.js`), generated TypeScript declarations (`native/index.d.ts`), and release-time optional platform packages.

The first native surface is the Cursor HTTP/2 transport binding used by the bundled Cursor provider.
