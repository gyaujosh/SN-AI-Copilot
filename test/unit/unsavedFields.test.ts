// A write that ServiceNow accepts can still drop a value without an error: a
// field the user may not write (a field ACL), one the table doesn't have, or
// one a business rule clears. Every create and update is checked against the
// record it returns, and a dropped value is reported, never passed off as set.
import { describe, expect, it, vi } from "vitest";
import { createRecordSmart, unsavedFields } from "../../src/background/snCatalog";
import { executeTool } from "../../src/background/tools";

const ID = "f".repeat(32);
const ok = (result: any) => ({ data: { result }, error: null });

describe("unsavedFields", () => {
  it("names each field sent with a value that came back empty or missing", () => {
    const sent = { short_description: "Printer", assignment_group: "g1", u_missing: "x", state: "2" };
    const saved = { sys_id: ID, short_description: "Printer", assignment_group: { link: "…", value: "" }, state: "2" };
    expect(unsavedFields(sent, saved)).toEqual([{ field: "assignment_group" }, { field: "u_missing" }]);
  });

  it("skips fields sent empty, journal fields and secrets, which never read back as written", () => {
    const sent = { description: "", comments: "Called the user", work_notes: "Checked", password: "hunter2", api_token: "t" };
    expect(unsavedFields(sent, { sys_id: ID })).toEqual([]);
  });

  it("checks nothing when what came back isn't the record", () => {
    expect(unsavedFields({ state: "2" }, {})).toEqual([]);
    expect(unsavedFields({ state: "2" }, null)).toEqual([]);
  });
});

function bridge(overrides: Record<string, any> = {}) {
  return {
    getPreferredHost: vi.fn(() => "example.service-now.com"),
    query: vi.fn(async () => ok([])),
    createRaw: vi.fn(async () => ok({ sys_id: ID })),
    update: vi.fn(async () => ok({ sys_id: ID })),
    ...overrides,
  };
}
const toolContext = (sn: any) => ({ sn, onProgress: () => {}, trackCreated: () => {}, createLedger: new Map() });

describe("writes that drop a value", () => {
  it("an update says which values didn't save", async () => {
    const sn = bridge({ update: vi.fn(async () => ok({ sys_id: ID, state: "2", assigned_to: "" })) });
    const result = await executeTool("update_record", { table: "incident", sys_id: ID, data: { state: "2", assigned_to: "u1" } }, toolContext(sn));
    expect(result).toMatchObject({ success: true, not_saved: ["assigned_to"] });
    expect(result.warning).toMatch(/did not save as sent: assigned_to\. .*field ACL.*do not report them as set/);
  });

  it("a create says which values didn't save", async () => {
    const sn = bridge({ createRaw: vi.fn(async () => ok({ sys_id: ID, name: "Network", u_region: "" })) });
    const result = await executeTool("create_record", { table: "sys_user_group", data: { name: "Network", u_region: "EMEA" } }, toolContext(sn));
    expect(result).toMatchObject({ success: true, sys_id: ID, not_saved: ["u_region"] });
  });

  it("a write that kept everything carries no warning", async () => {
    const sn = bridge({ update: vi.fn(async () => ok({ sys_id: ID, state: "2" })) });
    const result = await executeTool("update_record", { table: "incident", sys_id: ID, data: { state: "2" } }, toolContext(sn));
    expect(result).toEqual({ success: true, table: "incident", sys_id: ID, updated_fields: ["state"] });
  });

  it("a UI policy whose condition names a variable the item doesn't have says so", async () => {
    const sn = bridge({
      query: vi.fn(async (q: any) => ok(q.table === "item_option_new" ? [{ sys_id: "d".repeat(32), name: "admin_rights", type: "7" }] : [])),
      createRaw: vi.fn(async (_t: string, data: any) => ok({ sys_id: ID, ...data })),
      update: vi.fn(async (_t: string, _id: string, data: any) => ok({ sys_id: ID, ...data })),
    });
    const result = await createRecordSmart(sn as any, {
      table: "catalog_ui_policy",
      data: { short_description: "Admin", catalog_item: "c".repeat(32), catalog_conditions: "admin_rights=true^needs_monitor=Yes^EQ" },
    });
    expect(sn.update).toHaveBeenCalledWith("catalog_ui_policy", ID, { catalog_conditions: `IO:${"d".repeat(32)}=true^needs_monitor=Yes^EQ` });
    expect(result.notSaved).toEqual([{ field: "catalog_conditions", reason: expect.stringMatching(/no variable named needs_monitor on the catalog item/) }]);
  });
});
