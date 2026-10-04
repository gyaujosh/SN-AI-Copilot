// A catalog variable that reads from a table must name it, in the field its
// type uses: a List Collector's table in "List table" (list_table), a Lookup's
// in "Lookup from table" (lookup_table), a Reference's in reference. Left
// empty, the catalog item can't be opened, so the create is refused first.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calibrationOverlay, checkConditionalFields, tableFieldFor } from "../../src/background/snCatalog";
import { executeTool } from "../../src/background/tools";
import type { CalibrationData } from "../../src/shared/types";
import { DEV_HOST } from "../fixtures/chat";

const ITEM = "c".repeat(32);
function bridge() {
  return {
    getPreferredHost: () => DEV_HOST,
    query: vi.fn(async () => ({ data: { result: [] }, error: null })),
    createRaw: vi.fn(async () => ({ data: { result: { sys_id: "f".repeat(32) } }, error: null })),
  };
}
const variable = (type: string, extra: Record<string, string> = {}) =>
  ({ cat_item: ITEM, name: "pick", question_text: "Pick", type, ...extra });
const missingNames = async (data: Record<string, string>) =>
  (await checkConditionalFields(bridge() as never, "item_option_new", data)).missing.map((m) => m.name);

beforeEach(async () => { await chrome.storage.local.remove("calibration"); });

describe("variables that read from a table", () => {
  it("needs a List Collector's table in list_table, not reference", async () => {
    expect(await missingNames(variable("21"))).toEqual(["list_table"]);
    expect(await missingNames(variable("21", { reference: "sys_user" }))).toEqual(["list_table"]);
    expect(await missingNames(variable("21", { list_table: "sys_user" }))).toEqual([]);
  });

  it("needs a Reference's table in reference", async () => {
    expect(await missingNames(variable("8"))).toEqual(["reference"]);
    expect(await missingNames(variable("8", { reference: "cmdb_ci" }))).toEqual([]);
  });

  it.each(["18", "22"])("needs a Lookup's (type %s) table in lookup_table and its value field in lookup_value", async (type) => {
    expect(await missingNames(variable(type, { reference: "sys_user" }))).toEqual(["lookup_table", "lookup_value"]);
    expect(await missingNames(variable(type, { lookup_table: "sys_user", lookup_value: "sys_id", lookup_label: "name" }))).toEqual([]);
  });

  it("asks nothing more of variables that don't read from a table", async () => {
    expect(await missingNames(variable("6"))).toEqual([]);
    expect(await missingNames(variable("2"))).toEqual([]);
  });

  it("uses the instance's own type values once calibrated", async () => {
    const cal = { variableTypeMap: { Reference: "8", "List Collector": "31", "Single Line Text": "22" } } as unknown as CalibrationData;
    expect(tableFieldFor("31", cal)).toMatchObject({ field: "list_table" });
    expect(tableFieldFor("21", cal)).toBeNull();
    // 22 is another type on this instance, so it isn't taken for Lookup Multiple Choice.
    expect(tableFieldFor("22", cal)).toBeNull();
    expect(tableFieldFor("18", cal)).toMatchObject({ field: "lookup_table" });
  });

  it("refuses the create, sending nothing, and says which field to set", async () => {
    const sn = bridge();
    const result = await executeTool("create_record", { table: "item_option_new", data: variable("21", { reference: "sys_user" }) },
      { sn: sn as never, onProgress: () => {}, trackCreated: () => {}, createLedger: new Map() });
    expect(result).toMatchObject({ success: false, error: "Missing required fields" });
    expect(result.message).toMatch(/List table \(list_table\) — A List Collector variable \(type 21\) must name the table it reads from in "list_table".*can't be opened/);
    expect(sn.createRaw).not.toHaveBeenCalled();
  });

  it("says each type's field in the instance calibration", () => {
    const overlay = calibrationOverlay({
      instanceUrl: DEV_HOST, calibratedAt: 0, categories: {}, defaultCatalog: null, scriptTriggerTypes: ["onLoad"],
      variableTypeMap: { Reference: "8", "Lookup Select Box": "18", "List Collector": "21" },
      conditionalRules: { referenceTypes: ["8", "18", "21"], lookupTypes: ["18", "21"] },
    });
    expect(overlay).toContain("Reference (8) → reference; Lookup Select Box (18) → lookup_table; List Collector (21) → list_table");
    expect(overlay).not.toMatch(/REQUIRE a non-empty "reference"/);
  });
});
