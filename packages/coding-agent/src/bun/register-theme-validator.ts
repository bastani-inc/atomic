import { Compile } from "@bastani/atomic-ai/utils/typebox/compile";
import { Type } from "@bastani/atomic-ai/utils/typebox/index";

// Register bundled TypeBox constructors for theme-parse's invalid-theme slow path without creating a static
// relative import into modules that `split-dist.mjs` bundles and removes from `dist/`.
(globalThis as Record<symbol, unknown>)[Symbol.for("atomic.typeboxThemeDeps.v1")] = { Type, Compile };
