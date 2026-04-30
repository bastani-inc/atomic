import { test, expect, describe, beforeEach, afterEach } from "bun:test";

// ── Platform shim ─────────────────────────────────────────────────────────────
// We need to exercise both posix and win32 branches.  We patch
// `process.platform` around each describe block via Object.defineProperty so
// the same test file covers both paths without spawning sub-processes.

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

// Import after platform is set the first time (we re-import via cache busting
// is not needed because the module reads process.platform at call time, not
// module load time).
import { buildLauncherScript } from "../../../../src/commands/cli/chat/index.ts";

// ── Bash branch ──────────────────────────────────────────────────────────────
describe("buildLauncherScript – bash (posix)", () => {
  beforeEach(() => setPlatform("linux"));
  afterEach(() => setPlatform("linux"));

  test("returns ext=sh", () => {
    const { ext } = buildLauncherScript("/usr/bin/agent", [], "/home/user");
    expect(ext).toBe("sh");
  });

  test("script starts with shebang and cd", () => {
    const { script } = buildLauncherScript("/usr/bin/agent", [], "/home/user");
    const lines = script.split("\n");
    expect(lines[0]).toBe("#!/bin/bash");
    expect(lines[1]).toBe('cd "/home/user"');
  });

  test("args are double-quoted", () => {
    const { script } = buildLauncherScript("agent", ["--foo", "bar baz"], "/cwd");
    expect(script).toContain('"--foo" "bar baz"');
  });

  test("special chars in args are escaped", () => {
    const { script } = buildLauncherScript("agent", ['he said "hi"'], "/cwd");
    expect(script).toContain('\\"hi\\"');
  });

  test("env vars exported with valid POSIX keys", () => {
    const { script } = buildLauncherScript("agent", [], "/cwd", {
      MY_VAR: "hello world",
    });
    expect(script).toContain('export MY_VAR="hello world"');
  });

  test("env value with special chars is escaped", () => {
    const { script } = buildLauncherScript("agent", [], "/cwd", {
      TOKEN: 'abc"def$ghi',
    });
    expect(script).toContain('export TOKEN="abc\\"def\\$ghi"');
  });

  test("multiple env vars all exported", () => {
    const { script } = buildLauncherScript("agent", [], "/cwd", {
      A: "1",
      B: "2",
    });
    expect(script).toContain('export A="1"');
    expect(script).toContain('export B="2"');
  });

  test("exits via captured exit code variable", () => {
    const { script } = buildLauncherScript("agent", [], "/cwd");
    expect(script).toContain("atomic_exit_code=$?");
    expect(script).toContain('exit "$atomic_exit_code"');
  });

  test("throws on key starting with digit", () => {
    expect(() =>
      buildLauncherScript("agent", [], "/cwd", { "1BAD": "val" }),
    ).toThrow(/Invalid Bash env key "1BAD"/);
  });

  test("throws on key with hyphen", () => {
    expect(() =>
      buildLauncherScript("agent", [], "/cwd", { "MY-VAR": "val" }),
    ).toThrow(/Invalid Bash env key "MY-VAR"/);
  });

  test("throws on key with parentheses (like ProgramFiles(x86))", () => {
    expect(() =>
      buildLauncherScript("agent", [], "/cwd", { "ProgramFiles(x86)": "C:\\prog" }),
    ).toThrow(/Invalid Bash env key "ProgramFiles\(x86\)"/);
  });

  test("throws on empty key", () => {
    expect(() =>
      buildLauncherScript("agent", [], "/cwd", { "": "val" }),
    ).toThrow(/Invalid Bash env key ""/);
  });

  test("accepts underscore-prefixed key", () => {
    const { script } = buildLauncherScript("agent", [], "/cwd", { _PRIV: "x" });
    expect(script).toContain('export _PRIV="x"');
  });

  test("accepts key with digits after first char", () => {
    const { script } = buildLauncherScript("agent", [], "/cwd", { VAR1: "v" });
    expect(script).toContain('export VAR1="v"');
  });
});

// ── PowerShell branch ─────────────────────────────────────────────────────────
describe("buildLauncherScript – PowerShell (win32)", () => {
  beforeEach(() => setPlatform("win32"));
  afterEach(() => setPlatform("linux"));

  test("returns ext=ps1", () => {
    const { ext } = buildLauncherScript("agent.exe", [], "C:\\proj");
    expect(ext).toBe("ps1");
  });

  test("script starts with Set-Location", () => {
    const { script } = buildLauncherScript("agent.exe", [], "C:\\proj");
    expect(script.split("\n")[0]).toBe('Set-Location "C:\\proj"');
  });

  test("args splatted", () => {
    const { script } = buildLauncherScript("agent.exe", ["--foo", "b"], "C:\\");
    expect(script).toContain('& "agent.exe" @("--foo", "b")');
  });

  test("no-arg invocation omits splatting", () => {
    const { script } = buildLauncherScript("agent.exe", [], "C:\\");
    expect(script).toContain('& "agent.exe"');
    expect(script).not.toContain("@(");
  });

  test("env vars use braced provider syntax", () => {
    const { script } = buildLauncherScript("agent.exe", [], "C:\\", {
      MY_VAR: "hello",
    });
    expect(script).toContain('${env:MY_VAR} = "hello"');
  });

  test("ProgramFiles(x86) key uses braced syntax without throwing", () => {
    const { script } = buildLauncherScript("agent.exe", [], "C:\\", {
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    });
    // Braced syntax: ${env:ProgramFiles(x86)}
    expect(script).toContain("${env:ProgramFiles(x86)}");
    expect(script).toContain('"C:\\Program Files (x86)"');
  });

  test("key containing } is escaped in braced syntax", () => {
    const { script } = buildLauncherScript("agent.exe", [], "C:\\", {
      "KEY}WEIRD": "val",
    });
    // } in key must become `} so it doesn't close the brace early
    expect(script).toContain("${env:KEY`}WEIRD}");
  });

  test("env value with special PS chars is escaped", () => {
    const { script } = buildLauncherScript("agent.exe", [], "C:\\", {
      TOKEN: "ab`cd",
    });
    expect(script).toContain('"ab``cd"');
  });

  test("exits via LASTEXITCODE", () => {
    const { script } = buildLauncherScript("agent.exe", [], "C:\\");
    expect(script).toContain("$atomicExitCode = 0");
    expect(script).toContain("if ($LASTEXITCODE -is [int]) { $atomicExitCode = $LASTEXITCODE }");
    expect(script).toContain("exit $atomicExitCode");
  });

  test("multiple env vars all present", () => {
    const { script } = buildLauncherScript("agent.exe", [], "C:\\", {
      A: "1",
      B: "2",
    });
    expect(script).toContain('${env:A} = "1"');
    expect(script).toContain('${env:B} = "2"');
  });
});
