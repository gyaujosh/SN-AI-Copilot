// ServiceNow catalog quirk handling. ServiceNow's REST API silently drops or
// mishandles certain fields (catalog_variable, cat_variable, catalog_conditions),
// so creates on those tables go through a restricted server-side Script Include
// plus hidden-iframe form fills. This module also carries pre-create validation
// (mandatory + conditionally-required fields), dedup, and instance calibration.

import type { CalibrationData } from "../shared/types";
import { isSecretKey } from "../shared/redaction";
import type { SnBridge, SnResponse } from "./snBridge";

function records(resp: SnResponse): any[] {
  const r = resp?.data?.result;
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

// ─── Pre-create validation ───────────────────────────────────────────────────

const AUTO_FIELDS = [
  "sys_id", "sys_created_on", "sys_updated_on", "sys_created_by", "sys_updated_by",
  "sys_mod_count", "sys_class_name", "sys_tags", "sys_domain", "sys_scope",
];

export async function checkMandatoryFields(
  sn: SnBridge,
  table: string,
  data: Record<string, any>
): Promise<{ missing: { name: string; label: string; reason?: string }[] }> {
  try {
    const resp = await sn.query({
      table: "sys_dictionary",
      query: `name=${table}^mandatory=true^internal_type!=collection`,
      fields: "element,column_label",
      limit: 100,
      display_value: false,
    });
    const fields = records(resp);
    const missing: { name: string; label: string }[] = [];
    for (const f of fields) {
      const name = f.element;
      if (!name || AUTO_FIELDS.includes(name)) continue;
      if (!data || data[name] === undefined || String(data[name]).trim() === "") {
        missing.push({ name, label: f.column_label || name });
      }
    }
    return { missing };
  } catch {
    return { missing: [] };
  }
}

/** Variable types that read from a table, and the item_option_new field that
 * names it. Each type has its own: a List Collector's table set as `reference`
 * leaves "List table" empty, and the catalog item can't be opened. */
const TABLE_VARIABLES = [
  { type: "Reference", value: "8", field: "reference", label: "Reference" },
  { type: "Lookup Select Box", value: "18", field: "lookup_table", label: "Lookup from table", lookup: true },
  { type: "List Collector", value: "21", field: "list_table", label: "List table" },
  { type: "Lookup Multiple Choice", value: "22", field: "lookup_table", label: "Lookup from table", lookup: true },
] as const;

/** The table field a variable of this type needs, by the instance's own type values when calibrated. */
export function tableFieldFor(varType: string, cal: CalibrationData | null) {
  const map = cal?.variableTypeMap;
  return TABLE_VARIABLES.find((t) => {
    if (map?.[t.type] !== undefined) return map[t.type] === varType;
    // Not on the instance's list: the standard value, unless it means another type there.
    return t.value === varType && !Object.values(map ?? {}).includes(t.value);
  }) ?? null;
}

const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === "";

export async function checkConditionalFields(
  sn: SnBridge,
  table: string,
  data: Record<string, any>
): Promise<{ missing: { name: string; label: string; reason: string }[] }> {
  const missing: { name: string; label: string; reason: string }[] = [];
  if (table !== "item_option_new" || !data) return { missing };

  const cal = await getCalibration(sn.getPreferredHost());
  const varType = String(data.type || "");

  const needs = tableFieldFor(varType, cal);
  if (needs && blank(data[needs.field])) {
    missing.push({
      name: needs.field,
      label: needs.label,
      reason: `A ${needs.type} variable (type ${varType}) must name the table it reads from in "${needs.field}" (e.g. sys_user, cmdb_ci)` +
        (needs.field === "reference" ? "" : `; "reference" doesn't apply to it`) +
        ". Without it the catalog item can't be opened.",
    });
  }
  if (needs && "lookup" in needs && blank(data.lookup_value)) {
    missing.push({
      name: "lookup_value",
      label: "Lookup value field",
      reason: `A ${needs.type} variable must say which field of its table is stored as the value in "lookup_value" — usually sys_id.`,
    });
  }
  if ((varType === "1" || varType === "5") && data.include_none !== "true") {
    missing.push({
      name: "include_none",
      label: "Include None option",
      reason: 'Dropdown variables should set include_none="true" so users aren\'t shown a misleading pre-selected value.',
    });
  }
  return { missing };
}

// ─── Dedup ───────────────────────────────────────────────────────────────────
// catalog_ui_policy_action isn't listed: its variable is stored as IO:<sys_id>,
// never the name the model passes, so createUiPolicyAction matches it itself.

const DEDUP_KEYS: Record<string, string[]> = {
  sc_cat_item: ["name"],
  item_option_new: ["name", "cat_item"],
  catalog_ui_policy: ["short_description", "catalog_item"],
  catalog_script_client: ["name", "cat_item"],
  question_choice: ["question", "value"],
  sys_script: ["name", "collection"],
  sys_script_client: ["name", "table"],
  sys_ui_policy: ["short_description", "table"],
  sys_script_include: ["name"],
  sys_ui_action: ["name", "table"],
  sys_user_group: ["name"],
  sys_user_grmember: ["group", "user"],
};

export function buildAutoDedupQuery(table: string, data: Record<string, any>): string | null {
  const keys = DEDUP_KEYS[table];
  if (!keys) {
    if (data.name) return "name=" + data.name;
    return null;
  }
  const parts: string[] = [];
  for (const k of keys) {
    const v = data[k];
    if (v !== undefined && v !== null && v !== "") parts.push(`${k}=${v}`);
  }
  return parts.length ? parts.join("^") : null;
}

// ─── Helper Script Include ───────────────────────────────────────────────────
// The REST API can't create a catalog UI policy action with its variable set,
// so that one table goes through a small client-callable Script Include. Being
// client-callable, any signed-in user of the instance could call it — so it
// does exactly one thing: it creates catalog_ui_policy_action records from a
// fixed set of fields, only for users with catalog_admin who may create
// actions and edit the policy. It inserts through a plain GlideRecord, because
// ServiceNow locks the ui_policy field with a "nobody" ACL: GlideRecordSecure
// drops that value without an error, leaving an action no policy runs. It
// reads the action back and deletes it again if anything didn't save. Any
// installed copy whose script isn't exactly this one (an earlier helper among
// them) is replaced before the helper is used.

const HELPER_NAME = "SNAICopilotHelper";

export const HELPER_SCRIPT = `// SNAICopilotHelper v3: creates catalog UI policy actions for catalog admins who can edit the policy.
var SNAICopilotHelper = Class.create();
SNAICopilotHelper.prototype = Object.extendsObject(AbstractAjaxProcessor, {
  createRecord: function() {
    if (!gs.hasRole("catalog_admin")) return this._fail("The catalog_admin role is required");
    var table = this.getParameter("sysparm_table");
    if (table != "catalog_ui_policy_action") return this._fail("Unsupported table: " + table);
    var fieldsJson = this.getParameter("sysparm_fields");
    if (!fieldsJson) return this._fail("Missing fields");
    try {
      var fields = JSON.parse(fieldsJson);
      // The caller's own access decides: they must be allowed to create actions and to edit the policy.
      if (!new GlideRecordSecure(table).canCreate()) return this._fail("You are not allowed to create catalog UI policy actions");
      var policy = new GlideRecordSecure("catalog_ui_policy");
      if (!fields.ui_policy || !policy.get(fields.ui_policy)) return this._fail("UI policy not found: " + fields.ui_policy);
      if (!policy.canWrite()) return this._fail("You are not allowed to edit this UI policy");
      // A plain GlideRecord: ServiceNow locks ui_policy with a "nobody" field ACL, and
      // GlideRecordSecure would drop it without an error. The checks above stand in for
      // ACLs, and these are the only fields ever set.
      var gr = new GlideRecord(table);
      gr.initialize();
      gr.setValue("ui_policy", policy.getUniqueValue());
      if (policy.getValue("catalog_item")) gr.setValue("catalog_item", policy.getValue("catalog_item"));
      var settings = ["visible", "mandatory", "disabled"];
      var wanted = {};
      for (var i = 0; i < settings.length; i++) {
        var value = String(fields[settings[i]] || "");
        if (value == "true" || value == "false") {
          gr.setValue(settings[i], value);
          wanted[settings[i]] = value;
        }
      }
      var sysId = gr.insert();
      if (!sysId) return this._fail("Insert failed");
      // Read it back: a value that didn't save is an error, never a success.
      var saved = new GlideRecord(table);
      var lost = [];
      if (!saved.get(sysId)) lost.push("the record");
      else {
        if (saved.getValue("ui_policy") != policy.getUniqueValue()) lost.push("ui_policy");
        for (var name in wanted) {
          if (saved.getValue(name) != wanted[name]) lost.push(name);
        }
      }
      if (lost.length) {
        if (saved.isValidRecord()) saved.deleteRecord();
        return this._fail("The action did not keep " + lost.join(", ") + ", so it was deleted again. Nothing was changed.");
      }
      return JSON.stringify({ sys_id: String(sysId), error: null, needs_form_fill: true, catalog_variable_name: String(fields.catalog_variable || "") });
    } catch (e) {
      return this._fail(e.getMessage ? e.getMessage() : String(e));
    }
  },
  _fail: function(message) {
    return JSON.stringify({ sys_id: null, error: String(message) });
  },
  type: "SNAICopilotHelper"
});`;

const HELPER_DESCRIPTION =
  "Helper for the SN AI Copilot browser extension. Creates catalog UI policy actions (the REST API cannot set their variable) " +
  "for users with catalog_admin who can edit the policy. Safe to delete; the extension asks before installing it again.";

/** Whether the helper is ready to use, or what using it would change first. */
export type HelperStatus = "ready" | "install" | "update" | { error: string };

const normalized = (script: unknown) => String(script ?? "").replace(/\r\n?/g, "\n").trim();

async function findHelper(sn: SnBridge): Promise<{ copies: any[]; outdated: any[] } | { error: string }> {
  const found = await sn.query({
    table: "sys_script_include",
    query: `name=${HELPER_NAME}`,
    fields: "sys_id,script",
    limit: 20,
    display_value: false,
  });
  if (found.error) return { error: found.error };
  const copies = records(found);
  return { copies, outdated: copies.filter((c) => normalized(c.script) !== normalized(HELPER_SCRIPT)) };
}

/** A read, before anything is asked: does creating a catalog UI policy action
 * here first need the helper installed or replaced? */
export async function helperStatus(sn: SnBridge): Promise<HelperStatus> {
  const found = await findHelper(sn);
  if ("error" in found) return { error: found.error };
  if (found.outdated.length) return "update";
  return found.copies.length ? "ready" : "install";
}

/** What the approval card says when the helper is about to be installed or
 * replaced: why it is needed, what it does, and what happens on the instance. */
export function helperExplanation(status: "install" | "update"): { title: string; lines: string[] } {
  return {
    title: status === "install" ? `One-time setup: the ${HELPER_NAME} Script Include` : `Update: the ${HELPER_NAME} Script Include`,
    lines: [
      "Why: ServiceNow's REST API can't set the variable on a catalog UI policy action, so the extension creates those through a small Script Include on this instance.",
      "What it does: creates catalog UI policy actions and nothing else — only from a fixed set of fields, and only for users with the catalog_admin role who can edit the UI policy. It checks each action saved, and deletes it again if not.",
      status === "install"
        ? `What happens: approving adds ${HELPER_NAME} to sys_script_include (this needs the admin role). Your current update set captures it, and later changes reuse it. It is safe to delete; you'll be asked again before it is reinstalled.`
        : `What happens: approving replaces an older ${HELPER_NAME} on this instance with the current version (this needs the admin role). Your current update set captures the change.`,
    ],
  };
}

/** Install the helper, or bring every installed copy up to date, before it is
 * used — only when the user approved that. Returns why it can't be used, or
 * null. Fails closed: if the installed copies can't be read, nothing is
 * installed next to them. */
async function ensureHelper(sn: SnBridge, progress: (s: string) => void, approved: boolean): Promise<string | null> {
  const found = await findHelper(sn);
  if ("error" in found) return `Could not check for the ${HELPER_NAME} Script Include (${found.error}). Nothing was changed.`;
  const { copies, outdated } = found;
  if ((outdated.length || !copies.length) && !approved) {
    return `The ${HELPER_NAME} Script Include must be ${copies.length ? "updated" : "installed"} first, and the user has not approved that. Nothing was changed. ` +
      "Try this step again: the user will be asked to approve the helper.";
  }

  if (outdated.length) {
    progress("Updating the SN AI Copilot helper (one-time)…");
    for (const copy of outdated) {
      const updated = await sn.update("sys_script_include", copy.sys_id, { script: HELPER_SCRIPT, description: HELPER_DESCRIPTION });
      if (updated.error) {
        return `An older ${HELPER_NAME} Script Include is installed and could not be updated (${updated.error}). ` +
          `An admin can delete ${HELPER_NAME} from sys_script_include; the extension then installs the current one.`;
      }
    }
  }
  if (copies.length) return null;

  progress("Installing SN AI Copilot helper (one-time setup)…");
  const created = await sn.createRaw("sys_script_include", {
    name: HELPER_NAME,
    script: HELPER_SCRIPT,
    active: "true",
    client_callable: "true",
    access: "public",
    description: HELPER_DESCRIPTION,
  });
  if (created.error || !created.data?.result?.sys_id) {
    return `Failed to install helper Script Include: ${created.error || "No sys_id returned"}. Admin role is required.`;
  }
  return null;
}

// ─── Smart create ────────────────────────────────────────────────────────────

export interface CreateOptions {
  table: string;
  data: Record<string, any>;
  dedup_query?: string;
  /** True when this table+key combination was already attempted this turn —
   * dedup then waits out a possibly-still-committing earlier insert. */
  attemptedBefore?: boolean;
  onProgress?: (step: string) => void;
  /** The user approved installing or updating the helper Script Include. */
  helperApproved?: boolean;
}

/** A value a write sent that the record didn't keep, and why when known. */
export interface NotSaved {
  field: string;
  reason?: string;
}

/** A create's result: the record or why there is none, and any value it didn't keep. */
export type CreateResult = SnResponse & { skipped?: boolean; reason?: string; notSaved?: NotSaved[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Journal fields take a new entry and read back empty, whatever was written. */
const JOURNAL_FIELDS = new Set(["comments", "work_notes", "comments_and_work_notes"]);

/**
 * The fields a write sent with a value that came back empty or missing. The
 * Table API drops a value without an error when the field is read-only to the
 * user (a field ACL), isn't on the table, or a business rule clears it, so a
 * write is checked against the record it returns. Journal and secret fields
 * never read back as written, so they aren't checked.
 */
export function unsavedFields(sent: Record<string, any> | null | undefined, saved: unknown): NotSaved[] {
  if (!sent || !saved || typeof saved !== "object" || Array.isArray(saved)) return [];
  const record = saved as Record<string, any>;
  // Not the record itself (no sys_id): nothing to compare against.
  if (!record.sys_id) return [];
  return Object.keys(sent)
    .filter((field) => {
      const value = sent[field];
      if (value === null || value === undefined || String(value).trim() === "") return false;
      if (JOURNAL_FIELDS.has(field) || isSecretKey(field)) return false;
      const raw = record[field];
      const back = raw !== null && typeof raw === "object" ? raw.value : raw;
      return back === undefined || back === null || String(back) === "";
    })
    .map((field) => ({ field }));
}

/** What the model is told about values a write didn't keep. */
export function notSavedWarning(notSaved: NotSaved[]): string {
  const list = notSaved.map((n) => (n.reason ? `${n.field} (${n.reason})` : n.field)).join("; ");
  return `The record was saved, but these values did not save as sent: ${list}. ` +
    "ServiceNow drops a value without an error when the field is read-only to the user (a field ACL), isn't a field on this table, or a business rule clears it. " +
    "Tell the user which values are missing; do not report them as set.";
}

/** Dedup lookup that retries on transient errors and, when `settle` is set,
 * re-checks a few times so a just-inserted record has time to commit. */
async function dedupLookup(
  sn: SnBridge,
  table: string,
  query: string,
  settle: boolean
): Promise<{ record?: any; error?: string }> {
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await sn.query({ table, query, limit: 1, display_value: false });
    if (resp.error) {
      lastError = resp.error;
      if (resp.failure === "cancelled") break; // the run was stopped
      await sleep(1500);
      continue;
    }
    lastError = "";
    const recs = records(resp);
    if (recs.length > 0) return { record: recs[0] };
    if (!settle) return {};
    await sleep(2000); // possible uncommitted earlier insert — wait and re-check
  }
  return lastError ? { error: lastError } : {};
}

/** Reads a record back, re-reading for a few seconds until `ready` holds — a
 * hidden-form save can take a moment to land. */
async function readBack(
  sn: SnBridge,
  table: string,
  sysId: string,
  fields: string,
  ready: (record: any) => boolean
): Promise<{ record?: any; error?: string }> {
  let found: any = null;
  let error = "it was not found";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1500);
    const resp = await sn.query({ table, query: "sys_id=" + sysId, fields, limit: 1, display_value: false });
    if (resp.error) error = resp.error;
    else found = records(resp)[0] ?? found;
    if (resp.failure === "cancelled" || (found && ready(found))) break;
  }
  return found ? { record: found } : { error };
}

export async function createRecordSmart(sn: SnBridge, opts: CreateOptions): Promise<CreateResult> {
  const { table } = opts;
  const data = { ...opts.data };
  const progress = opts.onProgress || (() => {});

  // Dedup: never create the same record twice. Fails CLOSED — if we cannot
  // verify whether a duplicate exists, we refuse to create blindly.
  const dedupQuery = opts.dedup_query || buildAutoDedupQuery(table, data);
  if (dedupQuery) {
    const check = await dedupLookup(sn, table, dedupQuery, !!opts.attemptedBefore);
    if (check.error) {
      return {
        data: null,
        error:
          `Could not verify duplicates before creating in ${table} (dedup query failed: ${check.error}). ` +
          `NOT creating. Use query_records on ${table} with query "${dedupQuery}" to check whether the record already exists, then retry only if it does not.`,
      };
    }
    if (check.record) {
      return {
        data: { result: check.record },
        error: null,
        skipped: true,
        reason: `Duplicate found (dedup: ${dedupQuery}) — returning existing record`,
      };
    }
  }

  if (table === "catalog_ui_policy_action") {
    return createUiPolicyAction(sn, data, progress, !!opts.helperApproved, !!opts.attemptedBefore);
  }

  // Field-name aliases & well-known footguns.
  if (table === "catalog_ui_policy" && data.cat_item && !data.catalog_item) {
    data.catalog_item = data.cat_item;
    delete data.cat_item;
  }
  if (table === "catalog_ui_policy" && data.condition && !data.catalog_conditions) {
    data.catalog_conditions = data.condition;
    delete data.condition;
  }
  // Yes/No variables: default_value "false" creates a spurious choice.
  if (table === "item_option_new" && data.type === "1" && data.default_value === "false") {
    delete data.default_value;
  }

  // cat_variable on catalog_script_client needs an IO:<sys_id> form fill after create.
  let pendingCatVariable: string | null = null;
  let pendingCatItem: string | null = null;
  if (table === "catalog_script_client" && data.cat_variable) {
    pendingCatVariable = data.cat_variable;
    pendingCatItem = data.cat_item || "";
    delete data.cat_variable;
  }

  // catalog_conditions must be PATCHed after create with names resolved to IO:<sys_id>.
  let pendingConditions: string | null = null;
  let pendingPolicyItem: string | null = null;
  if (table === "catalog_ui_policy" && data.catalog_conditions) {
    pendingConditions = data.catalog_conditions;
    pendingPolicyItem = data.catalog_item || "";
    delete data.catalog_conditions;
  }

  const createResult = await sn.createRaw(table, data);
  const newSysId = createResult.data?.result?.sys_id;
  if (!newSysId) return createResult;
  const notSaved = unsavedFields(data, createResult.data?.result);

  if (pendingConditions) {
    const problem = await resolveAndSetConditions(sn, newSysId, pendingPolicyItem || "", pendingConditions);
    if (problem) notSaved.push({ field: "catalog_conditions", reason: problem });
  }

  if (pendingCatVariable) {
    const problem = pendingCatItem
      ? await linkScriptVariable(sn, newSysId, pendingCatVariable, pendingCatItem, progress)
      : "the script has no cat_item to find the variable on";
    if (problem) notSaved.push({ field: "cat_variable", reason: problem });
  }

  return notSaved.length ? { ...createResult, notSaved } : createResult;
}

const SYS_ID = /^[0-9a-f]{32}$/;

/** A policy action's visible, mandatory or read-only setting: "true",
 * "false", or "" to leave it alone. */
function actionSetting(value: unknown): "true" | "false" | "" {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "true" ? "true" : v === "false" ? "false" : "";
}

/**
 * Creates a catalog UI policy action: the helper Script Include inserts it
 * under its policy, a hidden form sets its variable, and it is read back. An
 * action only works linked to its policy with its variable set, so one that
 * isn't is deleted again and reported, never left behind as a success.
 */
async function createUiPolicyAction(
  sn: SnBridge,
  data: Record<string, any>,
  progress: (s: string) => void,
  helperApproved: boolean,
  attemptedBefore: boolean
): Promise<CreateResult> {
  const policyId = String(data.ui_policy ?? "").trim();
  const varName = String(data.catalog_variable ?? "").trim();
  if (!SYS_ID.test(policyId)) return { data: null, error: "catalog_ui_policy_action requires ui_policy: the sys_id of its catalog_ui_policy" };
  if (!varName) return { data: null, error: "catalog_ui_policy_action requires catalog_variable (variable NAME, not sys_id)" };
  const settings = {
    visible: actionSetting(data.visible),
    mandatory: actionSetting(data.mandatory),
    // "Read only" is stored in the disabled field; the table has no read_only field.
    disabled: actionSetting(data.disabled) || actionSetting(data.read_only),
  };

  // What the action hangs on is read before anything is created.
  const policy = await sn.query({ table: "catalog_ui_policy", query: "sys_id=" + policyId, fields: "sys_id,catalog_item", limit: 1, display_value: false });
  if (policy.error) return { data: null, error: `Could not read UI policy ${policyId} (${policy.error}). Nothing was changed.` };
  const found = records(policy)[0];
  if (!found) return { data: null, error: `There is no catalog_ui_policy with sys_id ${policyId}. Nothing was changed.` };
  const catItemId = String(found.catalog_item || "");
  const varSysId = SYS_ID.test(varName) ? varName : catItemId ? await resolveVariableSysId(sn, varName, catItemId) : null;
  const variable = varSysId ? "IO:" + varSysId : varName;

  // One action per variable per policy. The variable is stored as
  // IO:<sys_id>, so that is what an existing action is matched on.
  if (varSysId) {
    const dedup = `ui_policy=${policyId}^catalog_variable=${variable}`;
    const existing = await dedupLookup(sn, "catalog_ui_policy_action", dedup, attemptedBefore);
    if (existing.error) {
      return {
        data: null,
        error: `Could not check for an existing action before creating one (${existing.error}). NOT creating. ` +
          `Use query_records on catalog_ui_policy_action with query "${dedup}" to check, then retry only if there is none.`,
      };
    }
    if (existing.record) {
      return { data: { result: existing.record }, error: null, skipped: true, reason: `Duplicate found (dedup: ${dedup}) — returning existing record` };
    }
  }

  const helperError = await ensureHelper(sn, progress, helperApproved);
  if (helperError) return { data: null, error: helperError };

  const created = await sn.glideAjaxCreate("catalog_ui_policy_action", { ui_policy: policyId, catalog_variable: varName, ...settings });
  if (created.error) return { data: null, error: created.error, outcome: created.outcome };
  const id = String(created.sys_id || "");
  if (!SYS_ID.test(id)) return { data: null, error: "The helper didn't return the new action's sys_id.", outcome: "unknown" };

  progress(`Linking variable to policy action: ${varName}`);
  const fill = await sn.formFillCatalogVariable(id, variable);

  const back = await readBack(sn, "catalog_ui_policy_action", id, "ui_policy,catalog_variable", (r) => !!r.catalog_variable);
  if (!back.record) {
    return {
      data: null,
      outcome: "unknown",
      error: `Created catalog_ui_policy_action ${id}, but could not read it back to check it (${back.error}). Query it before doing anything else; do not create it again.`,
    };
  }
  const saved = String(back.record.catalog_variable || "");
  const lost = [
    back.record.ui_policy !== policyId ? "UI policy link" : "",
    !saved || (varSysId && !saved.includes(varSysId)) ? "variable" : "",
  ].filter(Boolean).join(" and ");
  if (!lost) return { data: { result: { sys_id: id } }, error: null };

  const why = `its ${lost} did not save${fill?.error ? ` (${fill.error})` : ""}`;
  const removed = await sn.remove("catalog_ui_policy_action", id);
  return removed.error
    ? {
        data: null,
        error: `Created catalog_ui_policy_action ${id}, but ${why}, and it could not be deleted again (${removed.error}). ` +
          `It does nothing as it is. Do not create it again; tell the user to delete it, or to set its ${lost} on the form.`,
      }
    : { data: null, error: `The action for ${varName} was created, but ${why}, so it was deleted again. Nothing was changed.` };
}

/** Sets a catalog client script's variable through its form, then reads it
 * back. Returns what went wrong, or null. */
async function linkScriptVariable(
  sn: SnBridge,
  scriptId: string,
  varName: string,
  catItemId: string,
  progress: (s: string) => void
): Promise<string | null> {
  const varSysId = await resolveVariableSysId(sn, varName, catItemId);
  if (!varSysId) return `no variable named ${varName} on the catalog item`;
  progress(`Linking client script variable: ${varName}`);
  const fill = await sn.formFillGeneric("catalog_script_client", scriptId, "cat_variable", "IO:" + varSysId);
  const back = await readBack(sn, "catalog_script_client", scriptId, "cat_variable", (r) => !!r.cat_variable);
  if (back.record?.cat_variable) return null;
  return fill?.error || back.error || "the form didn't save it";
}

async function resolveVariableSysId(sn: SnBridge, varName: string, catItemId: string): Promise<string | null> {
  if (/^[0-9a-f]{32}$/.test(varName)) return varName;
  const exact = await sn.query({
    table: "item_option_new",
    query: `name=${varName}^cat_item=${catItemId}`,
    fields: "sys_id,name",
    limit: 1,
    display_value: false,
  });
  const exactHit = records(exact)[0]?.sys_id;
  if (exactHit) return exactHit;

  const all = await sn.query({
    table: "item_option_new",
    query: `cat_item=${catItemId}`,
    fields: "sys_id,name",
    limit: 100,
    display_value: false,
  });
  const vars = records(all);
  const lower = varName.toLowerCase();
  const ci = vars.find((v) => String(v.name).toLowerCase() === lower);
  if (ci) return ci.sys_id;
  const contains = vars.find(
    (v) => String(v.name).toLowerCase().includes(lower) || lower.includes(String(v.name).toLowerCase())
  );
  return contains?.sys_id || null;
}

/** Sets a new policy's catalog_conditions with its variable names resolved to
 * IO:<sys_id>, and checks it saved. Returns what went wrong, or null. */
async function resolveAndSetConditions(sn: SnBridge, policySysId: string, catItemId: string, conditions: string): Promise<string | null> {
  const nameToSysId: Record<string, string> = {};
  const nameToType: Record<string, string> = {};
  if (catItemId) {
    const varsResp = await sn.query({
      table: "item_option_new",
      query: `cat_item=${catItemId}`,
      fields: "sys_id,name,type",
      limit: 100,
      display_value: false,
    });
    if (varsResp.error) return `the item's variables could not be read (${varsResp.error})`;
    for (const v of records(varsResp)) {
      nameToSysId[v.name] = v.sys_id;
      nameToType[v.name] = String(v.type);
    }
  }

  const unresolved: string[] = [];
  const resolved = conditions.replace(/([a-zA-Z_][a-zA-Z0-9_]*)=([^^]*)/g, (m, varName: string, value: string, offset: number, whole: string) => {
    // Already a variable reference (IO:<sys_id>=…): leave it as it is.
    if (whole.slice(Math.max(0, offset - 3), offset) === "IO:") return m;
    let name = varName;
    let val = value;
    let matched: string | null = null;
    if (nameToSysId[varName]) {
      name = "IO:" + nameToSysId[varName];
      matched = varName;
    } else {
      const lower = varName.toLowerCase();
      for (const vn of Object.keys(nameToSysId)) {
        if (vn.toLowerCase() === lower) {
          name = "IO:" + nameToSysId[vn];
          matched = vn;
          break;
        }
      }
    }
    if (!matched) unresolved.push(varName);
    // Yes/No variables require display values ("Yes"/"No"), never true/false.
    if (matched && nameToType[matched] === "1") {
      if (val === "true" || val.toLowerCase() === "yes") val = "Yes";
      else if (val === "false" || val.toLowerCase() === "no") val = "No";
    }
    return `${name}=${val}`;
  });

  const patch = await sn.update("catalog_ui_policy", policySysId, { catalog_conditions: resolved });
  if (patch.error) return `it could not be set (${patch.error})`;
  if (unsavedFields({ catalog_conditions: resolved }, patch.data?.result).length) return "ServiceNow did not keep it";
  if (unresolved.length) {
    return `no variable named ${unresolved.join(", ")} on ${catItemId ? "the catalog item" : "the policy (it has no catalog_item)"}, so that part never matches`;
  }
  return null;
}

// ─── Calibration ─────────────────────────────────────────────────────────────

/** The calibration recorded for `host` — never another instance's. */
export async function getCalibration(host: string | null | undefined): Promise<CalibrationData | null> {
  if (!host) return null;
  const r = await chrome.storage.local.get(["calibration"]);
  const cal = r.calibration as CalibrationData | undefined;
  return cal && cal.instanceUrl === host ? cal : null;
}

export async function runCalibration(sn: SnBridge, host: string, progress: (s: string) => void): Promise<void> {
  progress("Connecting to instance…");
  const conn = await sn.query({ table: "sys_properties", query: "name=glide.product.name", fields: "sys_id", limit: 1, display_value: false });
  if (conn.error) throw new Error("Could not connect to ServiceNow: " + conn.error);

  progress("Mapping variable types…");
  const typeResult = await sn.query({
    table: "sys_choice",
    query: "name=question^element=type^ORDERBYsequence",
    fields: "value,label,sequence",
    limit: 100,
  });
  if (typeResult.error) throw new Error(typeResult.error);
  const variableTypeMap: Record<string, string> = {};
  for (const r of records(typeResult)) {
    if (r?.label && r.value !== undefined) variableTypeMap[String(r.label)] = String(r.value);
  }

  const refResult = await sn.query({
    table: "sys_choice",
    query: "name=question^element=type^labelINReference,Lookup Select Box,List Collector,Lookup Multiple Choice",
    fields: "value,label",
    limit: 20,
  });
  const refRecords = records(refResult);
  const referenceTypes = refRecords.map((r) => String(r.value)).filter(Boolean);
  const lookupTypes = refRecords
    .filter((r) => /Lookup|List/.test(String(r.label || "")))
    .map((r) => String(r.value))
    .filter(Boolean);

  progress("Loading categories…");
  const catResult = await sn.query({ table: "sc_category", fields: "title,sys_id", limit: 100 });
  const categories: Record<string, string> = {};
  for (const r of records(catResult)) {
    const title = typeof r.title === "object" ? r.title?.display_value : r.title;
    const sysId = typeof r.sys_id === "object" ? r.sys_id?.value : r.sys_id;
    if (title && sysId) categories[String(title)] = String(sysId);
  }

  progress("Checking catalogs…");
  const catalogResult = await sn.query({ table: "sc_catalog", query: "active=true", fields: "sys_id,title", limit: 5 });
  const first = records(catalogResult)[0];
  const defaultCatalog = first
    ? {
        sys_id: String(typeof first.sys_id === "object" ? first.sys_id?.value : first.sys_id),
        title: String(typeof first.title === "object" ? first.title?.display_value : first.title),
      }
    : null;

  progress("Discovering script trigger types…");
  const scriptResult = await sn.query({
    table: "sys_choice",
    query: "name=catalog_script_client^element=type^ORDERBYsequence",
    fields: "value,label",
    limit: 50,
  });
  const scriptTriggerTypes = records(scriptResult).map((r) => String(r.value)).filter(Boolean);

  const calibration: CalibrationData = {
    instanceUrl: host,
    calibratedAt: Date.now(),
    variableTypeMap,
    categories,
    defaultCatalog,
    scriptTriggerTypes: scriptTriggerTypes.length ? scriptTriggerTypes : ["onChange", "onLoad", "onSubmit", "onCellEdit"],
    conditionalRules: {
      referenceTypes: referenceTypes.length ? referenceTypes : ["8", "18", "21"],
      lookupTypes: lookupTypes.length ? lookupTypes : ["18", "21", "22"],
    },
  };
  await chrome.storage.local.set({ calibration });
}

export function calibrationOverlay(cal: CalibrationData | null): string {
  if (!cal || !cal.variableTypeMap || Object.keys(cal.variableTypeMap).length === 0) return "";
  return [
    "--- INSTANCE CALIBRATION (auto-discovered) ---",
    `Instance: ${cal.instanceUrl} | Calibrated: ${new Date(cal.calibratedAt).toLocaleDateString()}`,
    "",
    "Variable type values for item_option_new.type on this instance:",
    Object.entries(cal.variableTypeMap).map(([l, v]) => `  ${l} = ${v}`).join("\n"),
    "",
    "Variables that read from a table MUST name it, each type in its own field: " +
      TABLE_VARIABLES.filter((t) => cal.variableTypeMap[t.type]).map((t) => `${t.type} (${cal.variableTypeMap[t.type]}) → ${t.field}`).join("; "),
    "",
    "Available categories (name → sys_id):",
    Object.entries(cal.categories).slice(0, 30).map(([n, id]) => `  ${n}: ${id}`).join("\n"),
    "",
    cal.defaultCatalog ? `Default catalog: "${cal.defaultCatalog.title}" (sys_id: ${cal.defaultCatalog.sys_id})` : "",
    "",
    "Valid catalog_script_client type values: " + cal.scriptTriggerTypes.join(", "),
    "--- END CALIBRATION ---",
  ]
    .filter(Boolean)
    .join("\n");
}
