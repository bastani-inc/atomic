import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultEmbeddedBaseDir,
  prepareBinariesForOwner,
  resolveEmbeddedRunContext,
  resolvePrivilegeDrop,
  ROOT_EMBEDDED_BASE_DIR,
  type EmbeddedPostgresRunContext,
  type LocalCommandRunner,
} from "../../packages/workflows/src/durable/dbos-embedded-postgres-root.js";

interface FakeCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly uid?: number;
}

function fakeRunner(
  respond: (command: string, args: readonly string[], uid?: number) => { exitCode: number; stdout?: string },
  calls: FakeCall[] = [],
): LocalCommandRunner {
  return async (command, args, options) => {
    calls.push({ command, args, uid: options?.uid });
    const result = respond(command, args, options?.uid);
    return { exitCode: result.exitCode, stdout: result.stdout ?? "", stderr: "" };
  };
}

const noCommands: LocalCommandRunner = async () => {
  throw new Error("no command expected");
};

/** Answers account lookups and honors the spawn-uid drop like a Node runtime. */
function nodeLikeRunner(accounts: Record<string, number>, calls: FakeCall[] = []): LocalCommandRunner {
  return fakeRunner((command, args, uid) => {
    if (command === "id" && args.length === 2 && args[1] !== undefined) {
      const id = accounts[args[1]];
      return id === undefined ? { exitCode: 1 } : { exitCode: 0, stdout: `${id}\n` };
    }
    if (command === "id" && args[0] === "-u") {
      return { exitCode: 0, stdout: `${uid ?? 0}\n` }; // spawn uid honored
    }
    return { exitCode: 1 };
  }, calls);
}

describe("embedded Postgres root run context", () => {
  test("non-root keeps the home-directory base and pass-through runner", async () => {
    const context = await resolveEmbeddedRunContext(noCommands, 1000, "linux");
    assert.equal(context.baseDir, defaultEmbeddedBaseDir());
    assert.equal(context.owner, undefined);
  });

  test("non-Linux root keeps the default context", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      const context = await resolveEmbeddedRunContext(noCommands, 0, platform);
      assert.equal(context.baseDir, defaultEmbeddedBaseDir());
      assert.equal(context.owner, undefined);
    }
  });

  test("Linux root resolves the first unprivileged candidate account", async () => {
    const context = await resolveEmbeddedRunContext(nodeLikeRunner({ postgres: 70 }), 0, "linux");
    assert.equal(context.baseDir, ROOT_EMBEDDED_BASE_DIR);
    assert.deepEqual(context.owner, { uid: 70, gid: 70, name: "postgres" });
  });

  test("Linux root falls back through candidates and rejects uid 0", async () => {
    const context = await resolveEmbeddedRunContext(
      nodeLikeRunner({ postgres: 0, nobody: 65534 }),
      0,
      "linux",
    );
    assert.deepEqual(context.owner, { uid: 65534, gid: 65534, name: "nobody" });
  });

  test("Linux root without any unprivileged account keeps the default context", async () => {
    const context = await resolveEmbeddedRunContext(fakeRunner(() => ({ exitCode: 1 })), 0, "linux");
    assert.equal(context.baseDir, defaultEmbeddedBaseDir());
    assert.equal(context.owner, undefined);
  });

  test("Linux root without any working privilege drop keeps the default context", async () => {
    // Accounts resolve, but every drop strategy still reports uid 0.
    const runner = fakeRunner((command, args) => {
      if (command === "id" && args.length === 2) return { exitCode: 0, stdout: "65534\n" };
      if (args.includes("-u") || args.includes("id -u") || args.some((a) => a.includes("id"))) {
        return { exitCode: 0, stdout: "0\n" };
      }
      return { exitCode: 0, stdout: "0\n" };
    });
    const context = await resolveEmbeddedRunContext(runner, 0, "linux");
    assert.equal(context.baseDir, defaultEmbeddedBaseDir());
    assert.equal(context.owner, undefined);
  });
});

describe("privilege drop strategy probing", () => {
  const owner = { uid: 65534, gid: 65534, name: "nobody" } as const;

  test("prefers the spawn uid/gid options when the runtime honors them", async () => {
    const calls: FakeCall[] = [];
    const drop = await resolvePrivilegeDrop(nodeLikeRunner({}, calls), owner);
    assert.ok(drop);
    const result = await drop("echo", ["hi"]);
    assert.equal(result.exitCode, 1); // fake runner: non-id commands fail, but…
    const last = calls.at(-1)!;
    assert.equal(last.command, "echo"); // …the command ran directly with uid set
    assert.equal(last.uid, owner.uid);
  });

  test("falls back to setpriv when spawn uid/gid is silently ignored (Bun)", async () => {
    const calls: FakeCall[] = [];
    const runner = fakeRunner((command, args, uid) => {
      if (command === "id" && uid !== undefined) return { exitCode: 0, stdout: "0\n" }; // Bun: drop ignored
      if (command === "setpriv") {
        assert.deepEqual(args.slice(0, 3), ["--reuid=65534", "--regid=65534", "--clear-groups"]);
        return { exitCode: 0, stdout: "65534\n" };
      }
      return { exitCode: 1 };
    }, calls);

    const drop = await resolvePrivilegeDrop(runner, owner);
    assert.ok(drop);
    await drop("initdb", ["-D", "/data"]);
    const last = calls.at(-1)!;
    assert.equal(last.command, "setpriv");
    assert.deepEqual(last.args.slice(-3), ["initdb", "-D", "/data"]);
  });

  test("falls back to runuser and then su, and reports failure when nothing drops", async () => {
    const suRunner = fakeRunner((command) => (
      command === "su" ? { exitCode: 0, stdout: "65534\n" } : { exitCode: 0, stdout: "0\n" }
    ));
    const suDrop = await resolvePrivilegeDrop(suRunner, owner);
    assert.ok(suDrop);

    const nothingWorks = fakeRunner(() => ({ exitCode: 0, stdout: "0\n" }));
    assert.equal(await resolvePrivilegeDrop(nothingWorks, owner), undefined);
  });
});

describe("embedded Postgres binaries under a drop-privilege owner", () => {
  function contextWith(baseDir: string, runAsOwner: LocalCommandRunner): EmbeddedPostgresRunContext {
    return { baseDir, owner: { uid: 65534, gid: 65534, name: "nobody" }, runAsOwner };
  }

  test("no owner returns the loaded binaries untouched", async () => {
    const binaries = { pg_ctl: "/pkg/native/bin/pg_ctl", initdb: "/pkg/native/bin/initdb" };
    const context: EmbeddedPostgresRunContext = { baseDir: "/anywhere", runAsOwner: noCommands };
    assert.equal(await prepareBinariesForOwner(binaries, context, noCommands), binaries);
  });

  test("owner-accessible binaries are used in place", async () => {
    const calls: FakeCall[] = [];
    const binaries = { pg_ctl: "/pkg/native/bin/pg_ctl", initdb: "/pkg/native/bin/initdb" };
    const result = await prepareBinariesForOwner(
      binaries,
      contextWith("/var/lib/atomic-postgres", fakeRunner(() => ({ exitCode: 0, stdout: "initdb 18.0" }), calls)),
      noCommands,
    );
    assert.equal(result, binaries);
    assert.deepEqual(calls, [{ command: "/pkg/native/bin/initdb", args: ["--version"], uid: undefined }]);
  });

  test("inaccessible binaries are copied into the base dir and chowned to the owner", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-test-"));
    try {
      const packageNative = join(scratch, "pkg", "native");
      mkdirSync(join(packageNative, "bin"), { recursive: true });
      mkdirSync(join(packageNative, "lib"), { recursive: true });
      writeFileSync(join(packageNative, "bin", "initdb"), "#!/bin/sh\n", { mode: 0o755 });
      writeFileSync(join(packageNative, "bin", "pg_ctl"), "#!/bin/sh\n", { mode: 0o755 });
      writeFileSync(join(packageNative, "lib", "libpq.so"), "lib");
      const baseDir = join(scratch, "cluster");
      mkdirSync(baseDir, { recursive: true });

      const rootCalls: FakeCall[] = [];
      const result = await prepareBinariesForOwner(
        { pg_ctl: join(packageNative, "bin", "pg_ctl"), initdb: join(packageNative, "bin", "initdb") },
        contextWith(baseDir, fakeRunner(() => ({ exitCode: 126 }))), // probe: permission denied
        fakeRunner(() => ({ exitCode: 0 }), rootCalls),
      );

      assert.equal(result.initdb, join(baseDir, "pg-runtime", "native", "bin", "initdb"));
      assert.equal(result.pg_ctl, join(baseDir, "pg-runtime", "native", "bin", "pg_ctl"));
      assert.ok(existsSync(result.initdb));
      assert.ok(existsSync(join(baseDir, "pg-runtime", "native", "lib", "libpq.so")));
      const chown = rootCalls.find((call) => call.command === "chown");
      assert.deepEqual(chown?.args, ["-R", "65534:65534", join(baseDir, "pg-runtime")]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("a failed chown handoff surfaces an actionable error", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "atomic-pg-root-test-"));
    try {
      const packageNative = join(scratch, "pkg", "native");
      mkdirSync(join(packageNative, "bin"), { recursive: true });
      writeFileSync(join(packageNative, "bin", "initdb"), "#!/bin/sh\n", { mode: 0o755 });
      writeFileSync(join(packageNative, "bin", "pg_ctl"), "#!/bin/sh\n", { mode: 0o755 });
      const baseDir = join(scratch, "cluster");
      mkdirSync(baseDir, { recursive: true });

      await assert.rejects(
        prepareBinariesForOwner(
          { pg_ctl: join(packageNative, "bin", "pg_ctl"), initdb: join(packageNative, "bin", "initdb") },
          contextWith(baseDir, fakeRunner(() => ({ exitCode: 126 }))),
          fakeRunner(() => ({ exitCode: 1 })),
        ),
        /Could not hand the copied embedded Postgres runtime to nobody/,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
