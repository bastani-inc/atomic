/**
 * Local DBOS database resolution: explicit env URL, embedded Postgres from
 * npm binaries, Docker as the final fallback.
 */
import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { EMBEDDED_DBOS_SYSTEM_DATABASE_URL } from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";
import { effectiveSystemDatabaseUrl } from "../../packages/workflows/src/durable/dbos-backend.js";
import {
  provisionResolvedLocalDbos,
  resetLocalDbosProvisioningForTests,
  resolveDbosSystemDatabaseUrl,
  shouldProvisionLocalDbos,
} from "../../packages/workflows/src/durable/dbos-local-postgres.js";

const originalUrl = process.env.DBOS_SYSTEM_DATABASE_URL;

afterEach(() => {
  resetLocalDbosProvisioningForTests();
  if (originalUrl === undefined) delete process.env.DBOS_SYSTEM_DATABASE_URL;
  else process.env.DBOS_SYSTEM_DATABASE_URL = originalUrl;
});

describe("resolveDbosSystemDatabaseUrl", () => {
  test.serial("defers to an explicit DBOS_SYSTEM_DATABASE_URL without provisioning", async () => {
    process.env.DBOS_SYSTEM_DATABASE_URL = "postgresql://user:pw@db.example:5432/dbos";
    let provisioned = 0;
    resetLocalDbosProvisioningForTests(
      async () => { provisioned += 1; },
      async () => { provisioned += 1; },
    );

    assert.equal(await resolveDbosSystemDatabaseUrl(), undefined);
    assert.equal(provisioned, 0);
  });

  test.serial("prefers the embedded instance and memoizes one resolution", async () => {
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    let embeddedCalls = 0;
    resetLocalDbosProvisioningForTests(
      async () => { embeddedCalls += 1; },
      async () => { throw new Error("docker must not run"); },
    );

    const [first, second] = await Promise.all([
      resolveDbosSystemDatabaseUrl(),
      resolveDbosSystemDatabaseUrl(),
    ]);

    assert.equal(first, EMBEDDED_DBOS_SYSTEM_DATABASE_URL);
    assert.equal(second, EMBEDDED_DBOS_SYSTEM_DATABASE_URL);
    assert.equal(embeddedCalls, 1);
  });

  test.serial("falls back to Docker only when embedded binaries are unavailable", async () => {
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    let dockerCalls = 0;
    resetLocalDbosProvisioningForTests(
      async () => { throw new Error("unsupported platform"); },
      async () => { dockerCalls += 1; },
    );

    assert.equal(await resolveDbosSystemDatabaseUrl(), undefined);
    assert.equal(dockerCalls, 1);
  });

  test.serial("combines both failures into one actionable error and allows retry", async () => {
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    let attempts = 0;
    resetLocalDbosProvisioningForTests(
      async () => { attempts += 1; throw new Error("no binaries"); },
      async () => { throw new Error("no docker"); },
    );

    await assert.rejects(resolveDbosSystemDatabaseUrl(), /no binaries.*no docker.*DBOS_SYSTEM_DATABASE_URL/s);
    await assert.rejects(resolveDbosSystemDatabaseUrl(), /no binaries/);
    assert.equal(attempts, 2, "a failed resolution must not be memoized");
  });

  test.serial("launch-retry reprovisions the provider that was actually resolved", async () => {
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    const calls: string[] = [];
    resetLocalDbosProvisioningForTests(
      async () => { calls.push("embedded"); throw new Error("unsupported"); },
      async () => { calls.push("docker"); },
    );

    await resolveDbosSystemDatabaseUrl();
    await provisionResolvedLocalDbos();

    assert.deepEqual(calls, ["embedded", "docker", "docker"]);
  });
});

describe("shouldProvisionLocalDbos", () => {
  test.serial("matches connection-refused failures only without an explicit URL", () => {
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    assert.equal(shouldProvisionLocalDbos(new Error("connect ECONNREFUSED 127.0.0.1:5439")), true);
    assert.equal(shouldProvisionLocalDbos(new Error("Unable to connect to system database at postgresql://...")), true);
    assert.equal(shouldProvisionLocalDbos(new Error("password authentication failed")), false);

    process.env.DBOS_SYSTEM_DATABASE_URL = "postgresql://user:pw@db.example:5432/dbos";
    assert.equal(shouldProvisionLocalDbos(new Error("connect ECONNREFUSED db.example:5432")), false);
  });
});

describe("effectiveSystemDatabaseUrl", () => {
  test("explicit config wins over the environment variable", () => {
    assert.equal(
      effectiveSystemDatabaseUrl("postgresql://config@db/one", "postgresql://env@db/two"),
      "postgresql://config@db/one",
    );
  });

  test("falls back to DBOS_SYSTEM_DATABASE_URL when no config URL is given", () => {
    assert.equal(
      effectiveSystemDatabaseUrl(undefined, "postgresql://env@db.example:5432/dbos"),
      "postgresql://env@db.example:5432/dbos",
    );
  });

  test("trims env-injected whitespace and trailing newlines", () => {
    assert.equal(
      effectiveSystemDatabaseUrl(undefined, "postgresql://env@db.example:5432/dbos\n"),
      "postgresql://env@db.example:5432/dbos",
    );
    assert.equal(
      effectiveSystemDatabaseUrl("  postgresql://config@db/one  ", undefined),
      "postgresql://config@db/one",
    );
  });

  test("treats unset, empty, and whitespace-only values as not set", () => {
    assert.equal(effectiveSystemDatabaseUrl(undefined, undefined), undefined);
    assert.equal(effectiveSystemDatabaseUrl(undefined, ""), undefined);
    assert.equal(effectiveSystemDatabaseUrl(undefined, "  \n"), undefined);
  });
});
