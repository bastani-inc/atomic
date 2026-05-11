/**
 * Tests for scripts/verify-artifact.ts logic.
 * Validates that the verifier correctly detects present and missing paths,
 * catches src-leaking imports in workflow JS, and handles pi.workflows dirs.
 */

import { test, expect, describe, beforeAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "fs";
import { resolve, dirname, relative, join } from "path";
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
    pi?: { extensions?: string[]; workflows?: string[] };
  },
  workflowFileContents?: Record<string, string>
): string {
  const root = resolve(tmpdir(), `pi-verify-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });

  for (const rel of distFiles) {
    const abs = resolve(root, rel);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    const content = workflowFileContents?.[rel] ?? "// stub";
    writeFileSync(abs, content);
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
  pi?: { extensions?: string[]; workflows?: string[] };
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
  if (pkg.pi?.workflows) {
    for (const wfDir of pkg.pi.workflows) {
      paths.push(wfDir);
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
// Inline helpers mirroring new src-import / relative-import checks
// ---------------------------------------------------------------------------

const FORBIDDEN_SRC_PATTERNS = ["../src/", "/src/index.js"] as const;

function scanWorkflowForSrcImports(content: string): string[] {
  return FORBIDDEN_SRC_PATTERNS.filter((p) => content.includes(p));
}

function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const esmRe = /from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = esmRe.exec(content)) !== null) {
    specifiers.push(m[1]);
  }
  const cjsRe = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = cjsRe.exec(content)) !== null) {
    specifiers.push(m[1]);
  }
  return specifiers;
}

function findLeakyRelativeImports(
  fileAbs: string,
  specifiers: string[],
  pkgRootAbs: string
): string[] {
  const leaky: string[] = [];
  for (const spec of specifiers) {
    if (!spec.startsWith(".")) continue;
    const resolved = resolve(dirname(fileAbs), spec);
    const rel = relative(pkgRootAbs, resolved);
    if (rel.startsWith("..") || rel.startsWith("src/") || rel.includes("/src/")) {
      leaky.push(spec);
    }
  }
  return leaky;
}

// ---------------------------------------------------------------------------
// Tests — path existence checks
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
// Tests — scanWorkflowForSrcImports
// ---------------------------------------------------------------------------

describe("scanWorkflowForSrcImports", () => {
  test("returns empty for clean workflow with bare specifier only", () => {
    const content = `import { defineWorkflow } from "pi-workflows";
var wf = defineWorkflow("test").run(async () => {}).compile();
export { wf };`;
    expect(scanWorkflowForSrcImports(content)).toHaveLength(0);
  });

  test("detects ../src/ pattern", () => {
    const content = `import { defineWorkflow } from "../src/index.js";`;
    const found = scanWorkflowForSrcImports(content);
    expect(found).toContain("../src/");
  });

  test("detects /src/index.js pattern", () => {
    const content = `import { foo } from "/src/index.js";`;
    const found = scanWorkflowForSrcImports(content);
    expect(found).toContain("/src/index.js");
  });

  test("detects both patterns when both present", () => {
    const content = `
import { a } from "../src/something";
import { b } from "/src/index.js";
`;
    const found = scanWorkflowForSrcImports(content);
    expect(found).toContain("../src/");
    expect(found).toContain("/src/index.js");
  });

  test("does not flag require with no src pattern", () => {
    const content = `const x = require("pi-workflows");`;
    expect(scanWorkflowForSrcImports(content)).toHaveLength(0);
  });

  test("does not flag a comment mentioning src/", () => {
    // Only string matching — if a comment contains ../src/ it IS flagged
    // (conservative: any occurrence in JS content is suspicious)
    const content = `// generated from src/workflows/ralph.ts — do not edit`;
    // No forbidden patterns (no ../src/ or /src/index.js)
    expect(scanWorkflowForSrcImports(content)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — extractImportSpecifiers
// ---------------------------------------------------------------------------

describe("extractImportSpecifiers", () => {
  test("extracts ESM import specifier", () => {
    const content = `import { defineWorkflow } from "pi-workflows";`;
    expect(extractImportSpecifiers(content)).toContain("pi-workflows");
  });

  test("extracts multiple ESM imports", () => {
    const content = `
import { a } from "pi-workflows";
import { b } from "pi-workflows";
import { c } from "@scope/pkg";
`;
    const specs = extractImportSpecifiers(content);
    expect(specs).toContain("pi-workflows");
    expect(specs).toContain("@scope/pkg");
  });

  test("extracts CJS require specifier", () => {
    const content = `const x = require("pi-workflows");`;
    expect(extractImportSpecifiers(content)).toContain("pi-workflows");
  });

  test("extracts relative specifiers", () => {
    const content = `import { x } from "../src/index.js";`;
    expect(extractImportSpecifiers(content)).toContain("../src/index.js");
  });

  test("returns empty for content with no imports", () => {
    const content = `var x = 42;`;
    expect(extractImportSpecifiers(content)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — findLeakyRelativeImports
// ---------------------------------------------------------------------------

describe("findLeakyRelativeImports", () => {
  const pkgRoot = "/fake/pkg";
  const fileInDist = "/fake/pkg/dist/workflows/ralph.js";

  test("bare specifier not flagged", () => {
    const leaky = findLeakyRelativeImports(fileInDist, ["pi-workflows"], pkgRoot);
    expect(leaky).toHaveLength(0);
  });

  test("relative import within dist/ not flagged", () => {
    const leaky = findLeakyRelativeImports(
      fileInDist,
      ["./define-workflow.js"],
      pkgRoot
    );
    expect(leaky).toHaveLength(0);
  });

  test("relative import going into src/ is flagged", () => {
    const leaky = findLeakyRelativeImports(
      fileInDist,
      ["../../src/index.js"],
      pkgRoot
    );
    expect(leaky).toContain("../../src/index.js");
  });

  test("relative import escaping pkgRoot is flagged", () => {
    const leaky = findLeakyRelativeImports(
      fileInDist,
      ["../../../outside.js"],
      pkgRoot
    );
    expect(leaky).toContain("../../../outside.js");
  });

  test("multiple specifiers — only leaky ones returned", () => {
    const leaky = findLeakyRelativeImports(
      fileInDist,
      ["pi-workflows", "../../src/helper.js", "./define-workflow.js"],
      pkgRoot
    );
    expect(leaky).toContain("../../src/helper.js");
    expect(leaky).not.toContain("pi-workflows");
    expect(leaky).not.toContain("./define-workflow.js");
  });
});

// ---------------------------------------------------------------------------
// Tests — pi.workflows directory verification
// ---------------------------------------------------------------------------

describe("verify-artifact — pi.workflows", () => {
  test("passes when pi.workflows directory exists", () => {
    const pkg: PkgShape = {
      main: "dist/index.js",
      pi: { extensions: ["./dist/extension/index.js"], workflows: ["./dist/workflows"] },
    };
    const root = makePkgRoot(
      ["dist/index.js", "dist/extension/index.js", "dist/workflows/index.js"],
      pkg
    );

    try {
      const missing = verifyArtifact(root, pkg);
      expect(missing).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports missing when pi.workflows dir absent", () => {
    const pkg: PkgShape = {
      main: "dist/index.js",
      pi: { workflows: ["./dist/workflows"] },
    };
    const root = makePkgRoot(["dist/index.js"], pkg);

    try {
      const missing = verifyArtifact(root, pkg);
      expect(missing).toContain("./dist/workflows");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("collectDeclaredPaths includes pi.workflows entries", () => {
    const pkg: PkgShape = {
      main: "dist/index.js",
      pi: { extensions: ["./dist/extension/index.js"], workflows: ["./dist/workflows"] },
    };
    const paths = collectDeclaredPaths(pkg);
    expect(paths).toContain("./dist/workflows");
    expect(paths).toContain("./dist/extension/index.js");
    expect(paths).toContain("dist/index.js");
  });

  test("collectDeclaredPaths counts all slots including pi.workflows", () => {
    const pkg: PkgShape = {
      main: "dist/index.js",
      types: "dist/index.d.ts",
      exports: {
        ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
      },
      pi: { extensions: ["./dist/extension/index.js"], workflows: ["./dist/workflows"] },
    };
    const paths = collectDeclaredPaths(pkg);
    // main + types + exports.import + exports.types + pi.extensions[0] + pi.workflows[0]
    expect(paths.length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Tests — scanWorkflowForSrcImports on simulated dist workflow files
// ---------------------------------------------------------------------------

describe("verify-artifact — workflow src-leak scan on simulated dist files", () => {
  test("clean workflow using bare 'pi-workflows' specifier passes scan", () => {
    const content = `// @bun
// dist/workflows/ralph.js
import { defineWorkflow } from "pi-workflows";
var ralph_default = defineWorkflow("ralph").description("Iterative planner-critic loop").run(async (ctx) => {
  const result = await ctx.stage("plan").prompt("Plan: " + ctx.inputs.prompt);
  return { result, plan: result, approved: false };
}).compile();
export { ralph_default as default };`;

    const leaked = scanWorkflowForSrcImports(content);
    expect(leaked).toHaveLength(0);
  });

  test("workflow using ../src/index.js is flagged", () => {
    const content = `import { defineWorkflow } from "../src/index.js";
var wf = defineWorkflow("bad").run(async () => ({})).compile();
export { wf as default };`;

    const leaked = scanWorkflowForSrcImports(content);
    expect(leaked).toContain("../src/");
  });

  test("workflow using /src/index.js absolute path is flagged", () => {
    const content = `import { defineWorkflow } from "/src/index.js";
export default {};`;

    const leaked = scanWorkflowForSrcImports(content);
    expect(leaked).toContain("/src/index.js");
  });

  test("workflow using relative ../index.js within dist does not trigger src pattern", () => {
    // Relative import to parent dist dir — not a src import
    const content = `import { defineWorkflow } from "../index.js";
export default {};`;

    const leaked = scanWorkflowForSrcImports(content);
    expect(leaked).toHaveLength(0);
  });

  test("verifier in temp dir: workflow with src leak is detected via file scan", () => {
    const leakyContent = `import { defineWorkflow } from "../src/index.js";
var wf = defineWorkflow("bad").run(async () => ({})).compile();
export { wf as default };`;
    const cleanContent = `import { defineWorkflow } from "pi-workflows";
var wf = defineWorkflow("ok").run(async () => ({})).compile();
export { wf as default };`;

    const pkg: PkgShape = {
      main: "dist/index.js",
      pi: { workflows: ["./dist/workflows"] },
    };
    const root = makePkgRoot(
      ["dist/index.js", "dist/workflows/ok.js", "dist/workflows/bad.js"],
      pkg,
      {
        "dist/workflows/ok.js": cleanContent,
        "dist/workflows/bad.js": leakyContent,
      }
    );

    try {
      // Scan all .js files in workflows dir
      const wfDir = resolve(root, "dist/workflows");
      const jsFiles = readdirSync(wfDir)
        .filter((f) => f.endsWith(".js"))
        .map((f) => join(wfDir, f));

      const leakyFiles: string[] = [];
      for (const jsFile of jsFiles) {
        const content = readFileSync(jsFile, "utf-8");
        const leaks = scanWorkflowForSrcImports(content);
        if (leaks.length > 0) leakyFiles.push(jsFile);
      }

      expect(leakyFiles.length).toBe(1);
      expect(leakyFiles[0]).toContain("bad.js");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
