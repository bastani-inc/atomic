import { test, expect, describe } from "bun:test";
import { deriveGraphTheme } from "../../../src/sdk/components/graph-theme.ts";
import { resolveTheme } from "../../../src/sdk/runtime/theme.ts";

const fakeTheme = resolveTheme(null);

describe("deriveGraphTheme", () => {
  test("maps background from theme bg", () => {
    const gt = deriveGraphTheme(fakeTheme);
    expect(gt.background).toBe(fakeTheme.bg);
  });

  test("maps backgroundElement from theme surface", () => {
    const gt = deriveGraphTheme(fakeTheme);
    expect(gt.backgroundElement).toBe(fakeTheme.surface);
  });

  test("maps text from theme text", () => {
    const gt = deriveGraphTheme(fakeTheme);
    expect(gt.text).toBe(fakeTheme.text);
  });

  test("maps textMuted from theme textMuted", () => {
    const gt = deriveGraphTheme(fakeTheme);
    expect(gt.textMuted).toBe(fakeTheme.textMuted);
  });

  test("maps textDim from theme dim", () => {
    const gt = deriveGraphTheme(fakeTheme);
    expect(gt.textDim).toBe(fakeTheme.dim);
  });

  test("maps primary from theme accent", () => {
    const gt = deriveGraphTheme(fakeTheme);
    expect(gt.primary).toBe(fakeTheme.accent);
  });

  test("maps success from theme success", () => {
    const gt = deriveGraphTheme(fakeTheme);
    expect(gt.success).toBe(fakeTheme.success);
  });

  test("maps error from theme error", () => {
    const gt = deriveGraphTheme(fakeTheme);
    expect(gt.error).toBe(fakeTheme.error);
  });

  test("maps warning from theme warning", () => {
    const gt = deriveGraphTheme(fakeTheme);
    expect(gt.warning).toBe(fakeTheme.warning);
  });

  test("maps info from theme info", () => {
    const gt = deriveGraphTheme(fakeTheme);
    expect(gt.info).toBe(fakeTheme.info);
  });

  test("maps border from theme borderDim", () => {
    const gt = deriveGraphTheme(fakeTheme);
    expect(gt.border).toBe(fakeTheme.borderDim);
  });

  test("maps borderActive from theme border", () => {
    const gt = deriveGraphTheme(fakeTheme);
    expect(gt.borderActive).toBe(fakeTheme.border);
  });

  test("maps mauve from theme mauve", () => {
    const gt = deriveGraphTheme(fakeTheme);
    expect(gt.mauve).toBe(fakeTheme.mauve);
  });

  test("returns all required GraphTheme keys", () => {
    const gt = deriveGraphTheme(fakeTheme);
    const keys = Object.keys(gt).sort();
    expect(keys).toEqual([
      "background",
      "backgroundElement",
      "border",
      "borderActive",
      "error",
      "info",
      "mauve",
      "primary",
      "success",
      "text",
      "textDim",
      "textMuted",
      "warning",
    ]);
  });
});
