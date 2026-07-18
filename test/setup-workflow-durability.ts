import { beforeEach } from "bun:test";
import {
  createInMemoryTestBackend,
  setDurableBackend,
} from "../packages/workflows/src/durable/factory.js";

/**
 * Product runtime always uses DBOS. Unit and integration tests explicitly run
 * against an isolated current-interface backend unless a test installs its own
 * DBOS adapter.
 */
beforeEach(() => {
  setDurableBackend(createInMemoryTestBackend());
});
