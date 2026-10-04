// Tool surface exposed to Claude. Read tools run freely; write tools are gated
// by the approval flow in agent.ts. Each executor returns a JSON-serializable
// result; errors are returned as { error } so the model can self-correct.

import type Anthropic from "@anthropic-ai/sdk";
import { refusedQuery, type SnBridge, type SnResponse } from "./snBridge";
import { redactForAi } from "../shared/redaction";
import {
  buildAutoDedupQuery,
  checkConditionalFields,
  checkMandatoryFields,
  createRecordSmart,
  notSavedWarning,
  unsavedFields,
} from "./snCatalog";
import type { NotSaved } from "./snCatalog";

export const WRITE_TOOLS = new Set(["create_record", "update_record", "delete_record"]);
export const DESTRUCTIVE_TOOLS = new Set(["delete_record"]);

/** A create that goes through the helper Script Include (see snCatalog). */
export function usesHelper(name: string, input: any): boolean {
  return name === "create_record" && input?.table === "catalog_ui_policy_action";
}

/**
 * Tables where one change can grant access, expose a secret or add server code
 * that others can call: roles and group membership, ACLs, users, system
 * properties, credentials and callable scripts.
 */
export function isSensitiveTable(table: unknown): boolean {
  const t = String(table ?? "");
  return /^(sys_user|sys_user_grmember|sys_user_has_role|sys_group_has_role|sys_user_role|sys_user_role_contains|sys_security_acl|sys_security_acl_role|sys_properties|sys_script_include|sys_processor|sys_ws_operation)$/.test(t) ||
    /credential|oauth|auth_profile|certificate/.test(t);
}

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "query_records",
    description:
      "Query a ServiceNow table via the Table API. READ-ONLY. Supports encoded queries, field selection, ordering, pagination. Use this for research: reading flows (sys_hub_flow), workflows (wf_workflow / wf_activity), business rules (sys_script), client scripts (sys_script_client / catalog_script_client), script includes (sys_script_include), ACLs (sys_security_acl), catalog items (sc_cat_item), variables (item_option_new), users (sys_user), groups (sys_user_group), group members (sys_user_grmember), update sets (sys_update_set), and any other table.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name, e.g. sys_script or incident" },
        query: { type: "string", description: "Encoded query string, e.g. active=true^nameLIKEonboarding" },
        fields: { type: "string", description: "Comma-separated fields to return. Always specify fields to keep results small." },
        limit: { type: "number", description: "Max records (default 20, max 200)" },
        offset: { type: "number", description: "Pagination offset" },
        order_by: { type: "string", description: "Field to sort by; prefix with - for descending, e.g. -sys_updated_on" },
        display_value: { type: "boolean", description: "Return display values (default true). Use false when you need raw sys_ids." },
      },
      required: ["table"],
    },
  },
  {
    name: "get_record",
    description: "Fetch a single ServiceNow record by sys_id with all (or selected) fields. READ-ONLY.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string" },
        sys_id: { type: "string" },
        fields: { type: "string", description: "Comma-separated fields. Omit for all fields." },
      },
      required: ["table", "sys_id"],
    },
  },
  {
    name: "count_records",
    description: "Count records matching an encoded query using the Aggregate API. READ-ONLY. Much cheaper than querying when you only need a count.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string" },
        query: { type: "string", description: "Encoded query string" },
      },
      required: ["table"],
    },
  },
  {
    name: "get_table_schema",
    description:
      "Get the schema of a ServiceNow table from sys_dictionary: field names, labels, types, mandatory flags, reference targets, max lengths. READ-ONLY. Use before creating/updating records on unfamiliar tables.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string" },
      },
      required: ["table"],
    },
  },
  {
    name: "get_field_choices",
    description: "Get the choice list (value + label) for a choice field on a table from sys_choice. READ-ONLY.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string" },
        field: { type: "string", description: "Element name of the choice field, e.g. state" },
      },
      required: ["table", "field"],
    },
  },
  {
    name: "search_code",
    description:
      "Search server-side and client-side script tables for a term (in script body or name). READ-ONLY. Searches: sys_script (business rules), sys_script_include, sys_script_client, catalog_script_client, sys_ui_action, sys_ui_script, sys_processor. Great for finding where a field is set, where an error message comes from, or which script touches a table.",
    input_schema: {
      type: "object",
      properties: {
        term: { type: "string", description: "Search term (matched with LIKE against script and name)" },
        tables: {
          type: "array",
          items: { type: "string" },
          description: "Optional subset of script tables to search. Defaults to all.",
        },
        active_only: { type: "boolean", description: "Only active records (default true)" },
      },
      required: ["term"],
    },
  },
  {
    name: "create_record",
    description:
      "Create a record in any ServiceNow table. Requires user approval (handled automatically by the extension — just call the tool). The extension handles ServiceNow API quirks: catalog_ui_policy_action and cat_variable/catalog_conditions resolution, dedup, mandatory-field validation. For catalog_ui_policy_action pass catalog_variable as the variable NAME. Provide step_label so the user sees a readable progress step.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string" },
        data: { type: "object", description: "Field name → value pairs" },
        dedup_query: { type: "string", description: "Encoded query to detect an existing duplicate before creating" },
        step_label: { type: "string", description: "Short human-readable label, e.g. 'Create variable: laptop_model'" },
      },
      required: ["table", "data"],
    },
  },
  {
    name: "update_record",
    description:
      "Update an existing ServiceNow record by sys_id (PATCH — only send the fields being changed). Requires user approval (handled automatically). Query the record first to confirm it exists and check current values.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string" },
        sys_id: { type: "string" },
        data: { type: "object", description: "Only the fields being changed" },
        step_label: { type: "string", description: "Short human-readable label, e.g. 'Set assignment group on INC0010001'" },
      },
      required: ["table", "sys_id", "data"],
    },
  },
  {
    name: "delete_record",
    description:
      "Delete a ServiceNow record by sys_id. DESTRUCTIVE — list it in your plan so the user sees it before approving. Fetch the record first to confirm it is the right one.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string" },
        sys_id: { type: "string" },
        step_label: { type: "string", description: "Short human-readable label, e.g. 'Delete duplicate variable laptop_model_2'" },
      },
      required: ["table", "sys_id"],
    },
  },
  {
    name: "propose_plan",
    description:
      "Show the user your whole plan on one approval card. Call it once, after the read-only lookups and before any create, update or delete, listing every change. " +
      "If approved, make every change in the plan in this same response without stopping — no other approval is asked. If rejected, make no changes and ask what to change. " +
      "details is what the user reads before approving; steps is the short list on the card.",
    input_schema: {
      type: "object",
      properties: {
        details: {
          type: "string",
          description:
            "The full plan in Markdown, shown right above the approval card. For each record to create, change or delete: the table, the key field values, " +
            "and the names and sys_ids of the records it uses (users, groups, catalog items); then the order, and anything the user should check. Headings, lists and tables are fine.",
        },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "Every change, in order, one plain line each, e.g. 'Create group \"Network\"', 'Add Abel Tuter to \"Network\"'.",
        },
        ui_policy_actions: {
          type: "boolean",
          description: "true if the plan creates catalog UI policy actions. They need the SNAICopilotHelper Script Include; if it must be installed, the user is asked on its own card right after the plan.",
        },
      },
      required: ["details", "steps"],
    },
  },
];

/** Shows the user the whole plan and asks once; handled in agent.ts. */
export const PLAN_TOOL = "propose_plan";

const SCRIPT_TABLES: Record<string, { nameField: string; scriptField: string; extra?: string }> = {
  sys_script: { nameField: "name", scriptField: "script", extra: "collection,when" },
  sys_script_include: { nameField: "name", scriptField: "script", extra: "api_name" },
  sys_script_client: { nameField: "name", scriptField: "script", extra: "table,type" },
  catalog_script_client: { nameField: "name", scriptField: "script", extra: "cat_item,type" },
  sys_ui_action: { nameField: "name", scriptField: "script", extra: "table" },
  sys_ui_script: { nameField: "name", scriptField: "script" },
  sys_processor: { nameField: "name", scriptField: "script" },
};

/** The part of a write's result that names values the record didn't keep. */
function notSavedResult(notSaved: NotSaved[] | undefined): { not_saved?: string[]; warning?: string } {
  return notSaved?.length ? { not_saved: notSaved.map((n) => n.field), warning: notSavedWarning(notSaved) } : {};
}

/** A failed read, with the transport's reason so the agent can tell a lapsed
 * sign-in from an unreachable tab from an ordinary error. */
function failed(resp: SnResponse): { error: string; failure?: SnResponse["failure"] } {
  return resp.failure ? { error: resp.error || "ServiceNow request failed.", failure: resp.failure } : { error: resp.error || "ServiceNow request failed." };
}

/** A table or field name as it goes into a query the extension builds: a
 * plain name, so a crafted one can't add conditions of its own. */
const PLAIN_NAME = /^[a-z0-9_]+$/;
const notPlain = (what: string, value: unknown) =>
  ({ error: `Invalid ${what}: ${JSON.stringify(String(value ?? "")).slice(0, 80)}. Nothing was sent.` });

function recordsOf(resp: any): any[] {
  const r = resp?.data?.result;
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

function snippet(script: string, term: string, radius = 160): string {
  const s = String(script || "");
  const idx = s.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return s.slice(0, radius);
  const start = Math.max(0, idx - radius / 2);
  return (start > 0 ? "…" : "") + s.slice(start, idx + term.length + radius / 2) + "…";
}

export interface ToolContext {
  sn: SnBridge;
  onProgress: (step: string) => void;
  trackCreated: (table: string, record: any, data: Record<string, any>) => void;
  /** Turn-scoped ledger of attempted creates (signature → timestamp). Lets a
   * repeated create call for the same logical record wait for / find the
   * earlier insert instead of producing a duplicate. */
  createLedger: Map<string, number>;
  /** The user approved installing or updating the helper Script Include in this run. */
  helperApproved?: boolean;
}

export async function executeTool(name: string, input: any, ctx: ToolContext): Promise<any> {
  const { sn } = ctx;
  switch (name) {
    case "query_records": {
      const refused = refusedQuery(input?.query);
      if (refused) return failed(refused);
      const resp = await sn.query(input);
      if (resp.error) return failed(resp);
      const recs = recordsOf(resp);
      return { count: recs.length, records: recs };
    }

    case "get_record": {
      const resp = await sn.getRecord(input.table, input.sys_id, input.fields);
      if (resp.error) return failed(resp);
      return resp.data?.result || {};
    }

    case "count_records": {
      const refused = refusedQuery(input?.query);
      if (refused) return failed(refused);
      const resp = await sn.count(input.table, input.query);
      if (resp.error) return failed(resp);
      const count = resp.data?.result?.stats?.count;
      return { table: input.table, query: input.query || "", count: Number(count ?? 0) };
    }

    case "get_table_schema": {
      if (!PLAIN_NAME.test(String(input.table ?? ""))) return notPlain("table name", input.table);
      const resp = await sn.query({
        table: "sys_dictionary",
        query: `name=${input.table}^internal_type!=collection^ORDERBYelement`,
        fields: "element,column_label,internal_type,mandatory,reference,max_length,default_value",
        limit: 200,
        display_value: false,
      });
      if (resp.error) return failed(resp);
      const fields = recordsOf(resp)
        .filter((f) => f.element)
        .map((f) => ({
          name: f.element,
          label: f.column_label,
          type: f.internal_type,
          mandatory: f.mandatory === "true",
          reference: f.reference || undefined,
          max_length: f.max_length || undefined,
        }));
      return { table: input.table, field_count: fields.length, fields };
    }

    case "get_field_choices": {
      if (!PLAIN_NAME.test(String(input.table ?? ""))) return notPlain("table name", input.table);
      if (!PLAIN_NAME.test(String(input.field ?? ""))) return notPlain("field name", input.field);
      const resp = await sn.query({
        table: "sys_choice",
        query: `name=${input.table}^element=${input.field}^inactive=false^ORDERBYsequence`,
        fields: "value,label,sequence",
        limit: 100,
        display_value: false,
      });
      if (resp.error) return failed(resp);
      return {
        table: input.table,
        field: input.field,
        choices: recordsOf(resp).map((c) => ({ value: c.value, label: c.label })),
      };
    }

    case "search_code": {
      const term = String(input.term || "").trim();
      if (!term) return { error: "term is required" };
      // The term goes into an encoded query, where ^ starts another condition.
      if (term.includes("^")) return { error: "term can't contain ^ (it would add conditions to the search). Search for the text around it instead." };
      const tables = (input.tables?.length ? input.tables : Object.keys(SCRIPT_TABLES)).filter(
        (t: string) => SCRIPT_TABLES[t]
      );
      const activeOnly = input.active_only !== false;
      const results: any[] = [];
      // A table that could not be read is not a table with no matches.
      const unreadable: { table: string; response: SnResponse }[] = [];
      for (const table of tables) {
        const meta = SCRIPT_TABLES[table];
        const query =
          `${meta.scriptField}LIKE${term}^OR${meta.nameField}LIKE${term}` + (activeOnly ? "^active=true" : "");
        const resp = await sn.query({
          table,
          query,
          fields: `sys_id,${meta.nameField},${meta.scriptField}${meta.extra ? "," + meta.extra : ""}`,
          limit: 10,
          display_value: false,
        });
        if (resp.error) {
          unreadable.push({ table, response: resp });
          continue;
        }
        for (const r of recordsOf(resp)) {
          results.push({
            table,
            sys_id: r.sys_id,
            name: r[meta.nameField],
            ...(meta.extra
              ? Object.fromEntries(meta.extra.split(",").map((f) => [f, r[f]]))
              : {}),
            // Redacted whole, then cut: a snippet that starts inside a
            // hardcoded credential would otherwise lose the name that marks it.
            snippet: snippet(redactForAi(String(r[meta.scriptField] ?? "")), term),
          });
        }
      }
      if (unreadable.length && unreadable.length === tables.length) return failed(unreadable[unreadable.length - 1].response);
      return {
        term,
        match_count: results.length,
        matches: results,
        ...(unreadable.length ? { failed_tables: unreadable.map((u) => u.table), failed_reason: unreadable[0].response.error } : {}),
      };
    }

    case "create_record": {
      const mandatory = await checkMandatoryFields(sn, input.table, input.data);
      const conditional = await checkConditionalFields(sn, input.table, input.data);
      const allMissing = [...mandatory.missing, ...conditional.missing];
      if (allMissing.length > 0) {
        return {
          success: false,
          error: "Missing required fields",
          missing_fields: allMissing,
          message:
            `Cannot create record in ${input.table}. Missing: ` +
            allMissing.map((f: any) => `${f.label} (${f.name})${f.reason ? " — " + f.reason : ""}`).join("; ") +
            ". Provide values and retry.",
        };
      }

      const dedupQuery = input.dedup_query || buildAutoDedupQuery(input.table, input.data) || undefined;
      const signature = `${input.table}|${dedupQuery || JSON.stringify(input.data)}`;
      const attemptedBefore = ctx.createLedger.has(signature);
      ctx.createLedger.set(signature, Date.now());

      const result = await createRecordSmart(sn, {
        table: input.table,
        data: input.data,
        dedup_query: dedupQuery,
        attemptedBefore,
        onProgress: ctx.onProgress,
        helperApproved: ctx.helperApproved,
      });
      if (result.error) {
        // A timed-out create may still have succeeded server-side — make the
        // ambiguity explicit so the model verifies instead of blindly retrying.
        if (result.outcome === "unknown" || /timed out/i.test(result.error)) {
          return {
            success: false,
            outcome: "unknown",
            error: result.error,
            table: input.table,
            message:
              `The create result is uncertain — the record in ${input.table} MAY still have been created. ` +
              `Use query_records on ${input.table}` +
              (dedupQuery ? ` with query "${dedupQuery}"` : "") +
              ` to check before retrying. Do NOT call create_record again without checking.`,
          };
        }
        return { success: false, error: result.error, table: input.table };
      }
      if (result.data?.error) {
        return { success: false, error: result.data.error.message || JSON.stringify(result.data.error), table: input.table };
      }
      const rec = result.data?.result || {};
      if (rec.sys_id) ctx.trackCreated(input.table, rec, input.data);
      return {
        success: true,
        skipped: result.skipped || undefined,
        reason: result.reason || undefined,
        sys_id: rec.sys_id,
        table: input.table,
        ...notSavedResult(result.notSaved),
      };
    }

    case "update_record": {
      const result = await sn.update(input.table, input.sys_id, input.data);
      if (result.error) return { success: false, error: result.error, outcome: result.outcome, failure: result.failure, table: input.table, sys_id: input.sys_id };
      if (result.data?.error) {
        return {
          success: false,
          error: result.data.error.message || JSON.stringify(result.data.error),
          table: input.table,
          sys_id: input.sys_id,
        };
      }
      return {
        success: true,
        table: input.table,
        sys_id: input.sys_id,
        updated_fields: Object.keys(input.data || {}),
        ...notSavedResult(unsavedFields(input.data, result.data?.result)),
      };
    }

    case "delete_record": {
      const result = await sn.remove(input.table, input.sys_id);
      if (result.error) return { success: false, error: result.error, outcome: result.outcome, failure: result.failure, table: input.table, sys_id: input.sys_id };
      if (result.data?.error) {
        return { success: false, error: result.data.error.message || JSON.stringify(result.data.error) };
      }
      return { success: true, deleted: true, table: input.table, sys_id: input.sys_id };
    }

    default:
      return { error: "Unknown tool: " + name };
  }
}

/** Human-readable label for the tool activity feed. */
export function toolLabel(name: string, input: any): { label: string; detail?: string } {
  switch (name) {
    case "query_records":
      return { label: `Query ${input.table}`, detail: input.query || "all records" };
    case "get_record":
      return { label: `Read ${input.table} record`, detail: input.sys_id };
    case "count_records":
      return { label: `Count ${input.table}`, detail: input.query };
    case "get_table_schema":
      return { label: `Read ${input.table} schema` };
    case "get_field_choices":
      return { label: `Read ${input.table}.${input.field} choices` };
    case "search_code":
      return { label: `Search scripts`, detail: `"${input.term}"` };
    case "create_record":
      return { label: input.step_label || `Create ${input.table}`, detail: input.data?.name || input.data?.short_description };
    case "update_record":
      return { label: input.step_label || `Update ${input.table}`, detail: input.sys_id };
    case "delete_record":
      return { label: input.step_label || `Delete ${input.table}`, detail: input.sys_id };
    case PLAN_TOOL: {
      const n = Array.isArray(input?.steps) ? input.steps.length : 0;
      return { label: "Plan", detail: `${n} change${n === 1 ? "" : "s"}` };
    }
    default:
      return { label: name };
  }
}

/** One field for the approval card: its name and a short, quoted value. */
function fieldFact(field: string, value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  if (text.length > 60 || /\n/.test(text)) return `${field} = ‹${text.length} characters›`;
  return `${field} = "${text}"`;
}

/** The fields a change sets, code and conditions first — the parts that decide what a record does. */
function fieldFacts(data: unknown, limit = 6): string {
  if (!data || typeof data !== "object") return "no fields";
  const entries = Object.entries(data as Record<string, unknown>);
  const weighty = (k: string) => /script|condition|query|role|password|active|admin/i.test(k);
  const shown = [...entries.filter(([k]) => weighty(k)), ...entries.filter(([k]) => !weighty(k))].slice(0, limit);
  const more = entries.length - shown.length;
  return shown.map(([k, v]) => fieldFact(k, v)).join(", ") + (more > 0 ? `, and ${more} more field${more === 1 ? "" : "s"}` : "") || "no fields";
}

/**
 * A write op for the approval card, described from what the call will
 * actually do — table, record and fields — never from the model's own label,
 * so the card can't be worded to look like something else.
 */
export function describeWriteOp(name: string, input: any): string {
  const table = String(input?.table ?? "?");
  if (name === "delete_record") return `Delete ${table} record ${input?.sys_id ?? "?"}`;
  if (name === "update_record") return `Update ${table} record ${input?.sys_id ?? "?"}: ${fieldFacts(input?.data)}`;
  return `Create ${table}: ${fieldFacts(input?.data)}`;
}
