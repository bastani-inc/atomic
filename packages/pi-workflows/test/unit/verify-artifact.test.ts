/**
 * Tests for scripts/verify-artifact.ts logic.
 * Validates that the verifier correctly detects present and missing paths.
 */

import { test, expect, describe } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Helper: create a temp package root with controlled dist layout
// ---------------------------------------------------------------------------

function makePkgRoot(
  distFiles: string[],
  pkg: {
    main?: string;
    types?: string;
    exports?: Record<string, { import?: string; types?: string }>;
    pi?: { extensions?: string[] };
  }
): string {
  const root = resolve(tmpdir(), `pi-verify-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });

  for (const rel of distFiles) {
    const abs = resolve(root, rel);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, "// stub");
  }

  writeFileSync(resolve(root, "package.json"), JSON.stringify(pkg, null, 2));
  return root;
}

// ---------------------------------------------------------------------------
// Inline verifier logic (mirrors scripts/verify-artifact.ts — keeps test
// independent of build state so it runs without dist present).
// ---------------------------------------------------------------------------

interface PkgShape {
  main?: string;
  types?: string;
  exports?: Record<string, { import?: string; types?: string }>;
  pi?: { extensions?: string[] };
}

function collectDeclaredPaths(pkg: PkgShape): string[] {
  const paths: string[] = [];
  if (pkg.main) paths.push(pkg.main);
  if (pkg.types) paths.push(pkg.types);
  if (pkg.exports) {
    for (const condition of Object.values(pkg.exports)) {
      if (condition.import) paths.push(condition.import);
      if (condition.types) paths.push(condition.types);
    }
  }
  if (pkg.pi?.extensions) {
    for (const ext of pkg.pi.extensions) {
      paths.push(ext);
    }
  }
  return paths;
}

function verifyArtifact(pkgRoot: string, pkg: PkgShape): string[] {
  const paths = collectDeclaredPaths(pkg);
  const missing: string[] = [];
  for (const rel of paths) {
    if (!existsSync(resolve(pkgRoot, rel))) {
      missing.push(rel);
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verify-artifact", () => {
  test("returns no missing paths when all declared files exist", () => {
    const pkg: PkgShape = {
      main: "dist/index.js",
      types: "dist/index.d.ts",
      exports: {
        ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
      },
      pi: { extensions: ["./dist/extension/index.js"] },
    };

    const root = makePkgRoot(
      ["dist/index.js", "dist/index.d.ts", "dist/extension/index.js"],
      pkg
    );

    try {
      const missing = verifyArtifact(root, pkg);
      expect(missing).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports missing dist/index.d.ts", () => {
    const pkg: PkgShape = {
      main: "dist/index.js",
      types: "dist/index.d.ts",
    };
    const root = makePkgRoot(["dist/index.js"], pkg); // no .d.ts

    try {
      const missing = verifyArtifact(root, pkg);
      expect(missing).toContain("dist/index.d.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports missing dist/extension/index.js from pi.extensions", () => {
    const pkg: PkgShape = {
      main: "dist/index.js",
      pi: { extensions: ["./dist/extension/index.js"] },
    };
    const root = makePkgRoot(["dist/index.js"], pkg); // no extension

    try {
      const missing = verifyArtifact(root, pkg);
      expect(missing).toContain("./dist/extension/index.js");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports all missing paths when dist is empty", () => {
    const pkg: PkgShape = {
      main: "dist/index.js",
      types: "dist/index.d.ts",
      exports: {
        ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
      },
      pi: { extensions: ["./dist/extension/index.js"] },
    };
    const root = makePkgRoot([], pkg);

    try {
      const missing = verifyArtifact(root, pkg);
      expect(missing.length).toBeGreaterThan(0);
      // At minimum: main, types, pi.extensions
      expect(missing).toContain("dist/index.js");
      expect(missing).toContain("dist/index.d.ts");
      expect(missing).toContain("./dist/extension/index.js");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("collectDeclaredPaths deduplicates nothing but collects all slots", () => {
    const pkg: PkgShape = {
      main: "dist/index.js",
      types: "dist/index.d.ts",
      exports: {
        ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
      },
      pi: { extensions: ["./dist/extension/index.js"] },
    };
    const paths = collectDeclaredPaths(pkg);
    // main + types + exports.import + exports.types + pi.extensions[0]
    expect(paths.length).toBe(5);
  });

  test("handles package with no optional fields gracefully", () => {
    const pkg: PkgShape = {};
    const root = makePkgRoot([], pkg);
    try {
      const missing = verifyArtifact(root, pkg);
      expect(missing).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: actual dist output after build
// ---------------------------------------------------------------------------

describe("verify-artifact integration — actual dist", () => {
  test("all paths declared in package.json exist in dist after build", async () => {
    const pkgJsonPath = resolve(import.meta.dir, "../../package.json");
    const pkgRoot = resolve(import.meta.dir, "../..");

    const { default: pkg } = await import(pkgJsonPath, { with: { type: "json" } });

    const missing = verifyArtifact(pkgRoot, pkg as PkgShape);
    expect(missing).toHaveLength(0);
  });
});
