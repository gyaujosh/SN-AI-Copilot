// The page context an instance tab reports about itself. Whatever runs on the
// page can write it, so it is taken as untrusted input: only the fields the
// extension uses, each the type it should be, and none of them unbounded —
// a form's values reach the model, and a forged context could otherwise be
// megabytes of tokens.

import type { SnContext, SnField } from "../shared/types";

const TABLE_NAME = /^[a-z0-9_]+$/;
/** A record's sys_id, or -1 for a new record that hasn't been saved. */
const RECORD_ID = /^(?:[0-9a-f]{32}|-1)$/;
const MAX_FIELDS = 200;
/** Long enough for any ordinary field; a long script is still there to read with get_record. */
export const MAX_VALUE_CHARS = 8000;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" ? value.slice(0, max) : undefined;

function clipValue(value: unknown): string {
  const s = typeof value === "string" ? value : value == null ? "" : String(value);
  return s.length > MAX_VALUE_CHARS ? s.slice(0, MAX_VALUE_CHARS) + " …[truncated — read the record for the full value]" : s;
}

function field(value: unknown): SnField | null {
  if (!value || typeof value !== "object") return null;
  const f = value as Record<string, unknown>;
  const name = text(f.name, 100);
  if (!name) return null;
  return {
    name,
    label: text(f.label, 200) ?? name,
    type: text(f.type, 50) ?? "unknown",
    ...(typeof f.mandatory === "boolean" ? { mandatory: f.mandatory } : {}),
    ...(typeof f.visible === "boolean" ? { visible: f.visible } : {}),
  };
}

/** The reported context, reduced to what the extension reads. The host, URL
 * and tab are not taken from here: the caller sets them from Chrome. */
export function pageContext(reported: unknown): Pick<SnContext, "pathname" | "table" | "sysId" | "fields" | "values" | "isForm" | "isList" | "isScriptEditor" | "uiType" | "scope"> {
  const r = reported && typeof reported === "object" ? (reported as Record<string, unknown>) : {};
  const table = typeof r.table === "string" && TABLE_NAME.test(r.table) ? r.table : null;
  const sysId = typeof r.sysId === "string" && RECORD_ID.test(r.sysId) ? r.sysId : null;
  const fields = Array.isArray(r.fields) ? r.fields.slice(0, MAX_FIELDS).map(field).filter((f): f is SnField => !!f) : [];
  const values: Record<string, string> = {};
  if (r.values && typeof r.values === "object" && !Array.isArray(r.values)) {
    // Every field's value, and a reference field's display value beside it.
    for (const [key, value] of Object.entries(r.values as Record<string, unknown>).slice(0, MAX_FIELDS * 2)) {
      values[key.slice(0, 120)] = clipValue(value);
    }
  }
  return {
    ...(text(r.pathname, 500) !== undefined ? { pathname: text(r.pathname, 500) } : {}),
    table,
    sysId,
    fields,
    values,
    isForm: r.isForm === true,
    isList: r.isList === true,
    isScriptEditor: r.isScriptEditor === true,
    ...(text(r.uiType, 40) ? { uiType: text(r.uiType, 40) } : {}),
    scope: text(r.scope, 100) ?? null,
  };
}
