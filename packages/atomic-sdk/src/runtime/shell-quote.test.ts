import { describe, expect, test } from "bun:test";

import { shellQuote } from "./shell-quote.ts";

describe("shellQuote", () => {
  test("single-quotes a plain argument", () => {
    expect(shellQuote(["claude"])).toBe("'claude'");
  });

  test("single-quotes each argument and joins with a single space", () => {
    expect(shellQuote(["claude", "--resume", "abc"])).toBe("'claude' '--resume' 'abc'");
  });

  test("preserves literal whitespace inside an argument", () => {
    expect(shellQuote(["claude", "--resume", "id with spaces"])).toBe(
      "'claude' '--resume' 'id with spaces'",
    );
  });

  test("escapes embedded single quotes via the '\\'' sequence", () => {
    // Input: a single-quote char inside the argument
    // Output: closing quote, literal escaped quote, reopening quote
    expect(shellQuote(["it's"])).toBe("'it'\\''s'");
  });

  test("escapes multiple embedded single quotes independently", () => {
    expect(shellQuote(["a'b'c"])).toBe("'a'\\''b'\\''c'");
  });

  test("returns an empty string for an empty argv", () => {
    expect(shellQuote([])).toBe("");
  });

  test("quotes an empty-string argument as ''", () => {
    expect(shellQuote([""])).toBe("''");
    expect(shellQuote(["claude", ""])).toBe("'claude' ''");
  });

  test("preserves shell metacharacters verbatim inside the quotes", () => {
    // None of `$`, `;`, `|`, `&`, `>`, `<`, `*`, backtick get evaluated under
    // single quotes — the helper just wraps them literally.
    expect(shellQuote(["echo $HOME && rm -rf /"])).toBe("'echo $HOME && rm -rf /'");
    expect(shellQuote(["a;b|c&d"])).toBe("'a;b|c&d'");
  });

  test("accepts a readonly argv (compile-time check)", () => {
    const argv: readonly string[] = ["claude", "--port", "0"] as const;
    expect(shellQuote(argv)).toBe("'claude' '--port' '0'");
  });
});
