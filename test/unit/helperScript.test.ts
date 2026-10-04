// The SNAICopilotHelper Script Include, run against a small fake of the
// server-side APIs it uses. ServiceNow locks catalog_ui_policy_action.ui_policy
// with a "nobody" field ACL, and GlideRecordSecure drops a value set on it
// without an error — the fake does the same, so an action inserted that way
// would come out linked to no policy.
import { describe, expect, it } from "vitest";
import { HELPER_SCRIPT } from "../../src/background/snCatalog";

const POLICY = "b".repeat(32);
const ITEM = "c".repeat(32);

interface World {
  roles: string[];
  canCreate: boolean;
  canWrite: boolean;
  /** Fields the database doesn't keep on insert (as a business rule clearing one would). */
  cleared: string[];
  tables: Record<string, Record<string, string>[]>;
}

function run(fields: Record<string, unknown>, world: Partial<World> = {}, table = "catalog_ui_policy_action") {
  const w: World = {
    roles: ["catalog_admin"],
    canCreate: true,
    canWrite: true,
    cleared: [],
    tables: { catalog_ui_policy: [{ sys_id: POLICY, catalog_item: ITEM }], catalog_ui_policy_action: [] },
    ...world,
  };
  let next = 0;
  class GlideRecord {
    protected current: Record<string, string> | null = null;
    protected pending: Record<string, string> = {};
    constructor(readonly table: string) {}
    initialize() { this.current = null; this.pending = {}; }
    setValue(name: string, value: string) { this.pending[name] = String(value); }
    // Like ServiceNow: an empty field reads as null.
    getValue(name: string) { return this.current?.[name] || null; }
    getUniqueValue() { return this.current?.sys_id ?? null; }
    get(sysId: string) {
      this.current = w.tables[this.table]?.find((r) => r.sys_id === sysId) ?? null;
      return !!this.current;
    }
    isValidRecord() { return !!this.current; }
    insert() {
      const row: Record<string, string> = { sys_id: String(++next).padStart(32, "0"), ...this.pending };
      for (const f of w.cleared) delete row[f];
      w.tables[this.table].push(row);
      return row.sys_id;
    }
    deleteRecord() {
      w.tables[this.table] = w.tables[this.table].filter((r) => r !== this.current);
      this.current = null;
      return true;
    }
  }
  class GlideRecordSecure extends GlideRecord {
    setValue(name: string, value: string) { if (name !== "ui_policy") super.setValue(name, value); }
    canCreate() { return w.canCreate; }
    canWrite() { return w.canWrite; }
  }
  function AbstractAjaxProcessor() {}
  AbstractAjaxProcessor.prototype.getParameter = function (this: { params: Record<string, string> }, name: string) {
    return this.params[name];
  };
  const env = {
    Class: { create: () => function () {} },
    Object: { extendsObject: (base: any, props: object) => Object.assign(Object.create(base.prototype), props) },
    AbstractAjaxProcessor,
    gs: { hasRole: (role: string) => w.roles.includes(role) },
    GlideRecord,
    GlideRecordSecure,
  };
  const Helper = new Function(...Object.keys(env), `${HELPER_SCRIPT}\nreturn SNAICopilotHelper;`)(...Object.values(env));
  const processor = new Helper();
  processor.params = { sysparm_table: table, sysparm_fields: JSON.stringify(fields) };
  return { answer: JSON.parse(processor.createRecord()), actions: w.tables.catalog_ui_policy_action };
}

const FIELDS = { ui_policy: POLICY, catalog_variable: "needs_monitor", visible: "true", mandatory: "", disabled: "false" };

describe("the helper Script Include", () => {
  it("links the action to its policy, though the field ACL locks ui_policy", () => {
    const { answer, actions } = run(FIELDS);
    expect(answer).toMatchObject({ error: null, needs_form_fill: true, catalog_variable_name: "needs_monitor" });
    expect(actions).toEqual([{ sys_id: answer.sys_id, ui_policy: POLICY, catalog_item: ITEM, visible: "true", disabled: "false" }]);
  });

  it("sets only its fixed fields, and takes the catalog item from the policy", () => {
    const { actions } = run({ ...FIELDS, catalog_item: "f".repeat(32), script: "gs.log(1)", active: "false", order: "1" });
    expect(Object.keys(actions[0]).sort()).toEqual(["catalog_item", "disabled", "sys_id", "ui_policy", "visible"]);
    expect(actions[0].catalog_item).toBe(ITEM);
  });

  it.each([
    ["without catalog_admin", {}, { roles: [] }, /catalog_admin role is required/],
    ["without create access to actions", {}, { canCreate: false }, /not allowed to create/],
    ["without write access to the policy", {}, { canWrite: false }, /not allowed to edit this UI policy/],
    ["for a policy that doesn't exist", { ui_policy: "9".repeat(32) }, {}, /UI policy not found/],
  ])("creates nothing %s", (_case, fields, world, error) => {
    const { answer, actions } = run({ ...FIELDS, ...fields }, world);
    expect(answer).toMatchObject({ sys_id: null, error: expect.stringMatching(error) });
    expect(actions).toEqual([]);
  });

  it("creates nothing on any other table", () => {
    const { answer, actions } = run(FIELDS, {}, "sys_user_has_role");
    expect(answer.error).toMatch(/Unsupported table: sys_user_has_role/);
    expect(actions).toEqual([]);
  });

  it("deletes an action that didn't keep a value, and says so", () => {
    const { answer, actions } = run(FIELDS, { cleared: ["visible"] });
    expect(answer).toMatchObject({ sys_id: null, error: expect.stringMatching(/did not keep visible, so it was deleted again\. Nothing was changed\./) });
    expect(actions).toEqual([]);
  });
});
