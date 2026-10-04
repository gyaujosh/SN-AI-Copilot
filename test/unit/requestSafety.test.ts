// What the agent can reach, whatever the model asks for: table names and
// record ids are refused before a request is built, and page values reach the
// model redacted.
import { describe, expect, it, vi } from "vitest";
import { SnBridge } from "../../src/background/snBridge";
import { buildContextBlock } from "../../src/background/prompts";
import type { SnContext } from "../../src/shared/types";
import { DEV_HOST, INSTANCES } from "../fixtures/chat";

describe("the ServiceNow bridge", () => {
  it.each([
    ["query", (sn: SnBridge) => sn.query({ table: "../../../cache.do#" })],
    ["count", (sn: SnBridge) => sn.count("incident/../../logout.do")],
    ["getRecord", (sn: SnBridge) => sn.getRecord("incident", "../../xmlhttp.do")],
    ["createRaw", (sn: SnBridge) => sn.createRaw("Incident?x=1", {})],
    ["update", (sn: SnBridge) => sn.update("incident", "abc", { state: "2" })],
    ["remove", (sn: SnBridge) => sn.remove("sys_user", "*")],
  ])("%s refuses a malformed table or id without sending anything", async (_name, call) => {
    const sn = new SnBridge();
    const rest = vi.spyOn(sn, "rest");
    const result = await call(sn);
    expect(result.error).toMatch(/^Invalid (table name|sys_id)/);
    expect(result.error).toContain("Nothing was sent");
    expect(rest).not.toHaveBeenCalled();
  });

  it("clamps paging numbers into the query string", async () => {
    const sn = new SnBridge();
    const rest = vi.spyOn(sn, "rest").mockResolvedValue({ data: null, error: null });
    await sn.query({ table: "incident", limit: "10&sysparm_x=y" as unknown as number, offset: -5 });
    expect(rest.mock.calls[0][0]).toMatch(/^\/api\/now\/table\/incident\?sysparm_limit=20&/);
    expect(rest.mock.calls[0][0]).not.toContain("sysparm_x");
    expect(rest.mock.calls[0][0]).not.toContain("sysparm_offset");
  });
});

describe("page context in the prompt", () => {
  const form = (fields: [string, string, string][]): SnContext => ({
    hostname: DEV_HOST, instance: "exampledev", url: `https://${DEV_HOST}/x.do`, table: "x", isForm: true,
    fields: fields.map(([name, type]) => ({ name, label: name, type })),
    values: Object.fromEntries(fields.map(([name, , value]) => [name, value])),
  });

  it("never shows a password or masked field's value, or a secret-named field's", () => {
    const block = buildContextBlock(form([
      ["short_description", "string", "Printer jam"],
      ["u_password", "password2", "hunter2"],
      ["u_pin", "masked", "1234"],
      ["u_api_token", "string", "tok-abc"],
    ]), null, null, { host: DEV_HOST, instance: INSTANCES[0] });
    expect(block).toContain('short_description (short_description, string) = "Printer jam"');
    expect(block).toContain("u_password (u_password, password2) = [REDACTED]");
    expect(block).toContain("u_pin (u_pin, masked) = [REDACTED]");
    expect(block).not.toMatch(/hunter2|1234|tok-abc/);
  });

  it("redacts a system property's value when its name says it is a secret", () => {
    const block = buildContextBlock(form([["name", "string", "acme.integration.password"], ["value", "string", "s3cret-value"]]), null, null);
    expect(block).toContain('name (name, string) = "acme.integration.password"');
    expect(block).not.toContain("s3cret-value");
  });
});
