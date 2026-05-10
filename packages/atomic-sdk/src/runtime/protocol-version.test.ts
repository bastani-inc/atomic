import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getProtocolVersion } from "./protocol-version";

const expectedVersion: string = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../sdk-protocol-version.json"),
    "utf8"
  )
).protocolVersion;

test("getProtocolVersion returns value matching sdk-protocol-version.json", () => {
  expect(getProtocolVersion()).toBe(expectedVersion);
});

test("getProtocolVersion caches result (referential identity on primitive)", () => {
  const a = getProtocolVersion();
  const b = getProtocolVersion();
  expect(a).toBe(b);
});
