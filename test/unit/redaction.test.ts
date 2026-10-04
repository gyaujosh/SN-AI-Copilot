// Redaction: secrets never reach model history or chrome.storage, and the
// tricky cases are exactly the ones under test.

import { describe, expect, it } from "vitest";
import { isSecretKey, redactSecrets, safeDiagnostic } from "../../src/shared/redaction";

describe("isSecretKey", () => {
  it("catches the common shapes, including bare `token` and camelCase", () => {
    for (const key of ["password", "api_key", "apiKey", "client_secret", "g_ck", "token", "access_token", "Authorization"]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it("does not fire on lookalikes", () => {
    for (const key of ["tokenizer", "tokens_used", "brokenness", "passport_number"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe("redactSecrets", () => {
  it("redacts secret-shaped keys at any depth, keeps the rest", () => {
    const out = redactSecrets({
      name: "row",
      nested: { password: "hunter2", note: "fine" },
      list: [{ api_key: "abc" }],
    });
    expect(out).toEqual({
      name: "row",
      nested: { password: "[REDACTED]", note: "fine" },
      list: [{ api_key: "[REDACTED]" }],
    });
  });

  it("understands ServiceNow property records: a secret-like NAME redacts the generic VALUE", () => {
    const out = redactSecrets({ name: "integration.password", value: "s3cret", sys_id: "abc" });
    expect(out).toEqual({ name: "integration.password", value: "[REDACTED]", sys_id: "abc" });
    // …and a harmless property keeps its value.
    expect(redactSecrets({ name: "glide.ui.theme", value: "polaris" })).toEqual({
      name: "glide.ui.theme",
      value: "polaris",
    });
  });

  it("scrubs bearer/basic tokens and cookies out of free text", () => {
    expect(redactSecrets("Authorization: Bearer abc.def-ghi rest")).not.toContain("abc.def");
    expect(redactSecrets("Set-Cookie: JSESSIONID=xyz; Path=/")).not.toContain("xyz");
  });

  it("redacts a hardcoded credential inside script text without eating the script", () => {
    const script = 'var x = 1;\nvar apiKey = "sk-live-123";\nreturn x;';
    const out = redactSecrets(script);
    expect(out).not.toContain("sk-live-123");
    expect(out).toContain("var x = 1;");
  });

  it("survives circular structures", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => redactSecrets(a)).not.toThrow();
  });
});

describe("safeDiagnostic", () => {
  it("stringifies errors with secrets scrubbed", () => {
    expect(safeDiagnostic(new Error("failed: Bearer abc123"))).not.toContain("abc123");
  });
});
