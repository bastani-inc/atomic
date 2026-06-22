/**
 * Workflow authoring contract shared by the runtime type graph and the
 * standalone package typing surface.
 *
 * Keep this file as the stable public barrel; the implementation contracts are
 * split by responsibility to stay within the source file length limit.
 */

export type { Static, TSchema } from "typebox";
export * from "./authoring-contract-stage.js";
export * from "./authoring-contract-ui.js";
