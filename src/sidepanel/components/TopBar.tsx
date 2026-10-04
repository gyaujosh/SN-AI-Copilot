import React from "react";
import { Plus, ShoppingBag, X } from "lucide-react";
import { INITIAL_CONNECTION } from "../../shared/connection";
import type { CatalogContext, PublicSettings, SnContext } from "../../shared/types";
import type { AgentApi } from "../hooks/useAgent";
import { InstancePicker, shownTarget, targetName } from "./InstancePicker";

const TABLE_NAMES: Record<string, string> = {
  incident: "Incident", problem: "Problem", change_request: "Change", sc_request: "Request",
  sc_req_item: "Requested item", sc_task: "Catalog task", task: "Task", sc_cat_item: "Catalog item",
  kb_knowledge: "Article", sys_user: "User", sys_user_group: "Group", cmdb_ci: "CI",
  sys_script: "Business rule", sys_script_include: "Script include", sys_script_client: "Client script",
  catalog_script_client: "Catalog client script", sys_ui_policy: "UI policy", catalog_ui_policy: "Catalog UI policy",
  item_option_new: "Variable", sys_hub_flow: "Flow", wf_workflow: "Workflow", sys_ui_action: "UI action",
};

/** "Incident · INC0010001", "Incident list", or nothing when the page is not a record. */
export function pageLabel(ctx: SnContext | null): string | null {
  if (!ctx?.table) return null;
  const table = TABLE_NAMES[ctx.table] ?? ctx.table;
  if (ctx.isForm) {
    const id = ctx.values?.number || ctx.values?.name || (ctx.sysId ? ctx.sysId.slice(0, 8) : "");
    return id ? `${table} · ${id}` : table;
  }
  return ctx.isList ? `${table} list` : null;
}

/** The unified chat header: where the agent works, what page it sees, and a new chat. */
export function TopBar({
  ctx,
  catalog,
  settings,
  agent,
  onClearCatalog,
  onNewChat,
  onManageInstances,
}: {
  ctx: SnContext | null;
  catalog: CatalogContext | null;
  settings: PublicSettings;
  agent: AgentApi;
  onClearCatalog: () => void;
  onNewChat: () => void;
  onManageInstances?: () => void;
}) {
  const connection = agent.connection || INITIAL_CONNECTION;
  const shown = shownTarget(agent, settings, ctx);
  // Same instance the picker names, so the name and the host always agree.
  const host = shown.host ?? connection.host ?? ctx?.hostname ?? null;
  const label = pageLabel(ctx && (!host || ctx.hostname?.toLowerCase() === host) ? ctx : null);

  // Quiet unless something needs the user: say what, and offer the one fix.
  let attention: { text: string; action?: { label: string; run: () => void } } | null = null;
  if (connection.phase === "sign_in_required") {
    attention = { text: "Sign-in required", action: host ? { label: "Sign in", run: () => agent.openHostTab(host) } : undefined };
  } else if (connection.phase === "unavailable") {
    // Opening an instance focuses an existing tab and reloads it, so the
    // label says "Reload" whenever there is a tab to reload.
    attention = connection.reason === "incompatible"
      ? { text: "Refresh the ServiceNow tab", action: host ? { label: "Refresh", run: () => agent.openHostTab(host) } : undefined }
      : connection.reason === "no_tab" || !connection.reason
        ? { text: "No ServiceNow tab", action: shown.host ? { label: `Open ${targetName(shown)}`, run: () => agent.openHostTab(shown.host!) } : undefined }
        : { text: "ServiceNow tab not responding", action: host ? { label: "Reload it", run: () => agent.openHostTab(host) } : undefined };
  } else if (connection.phase === "reconnecting") {
    attention = { text: "Reconnecting…" };
  }

  return (
    <header className="chat-header">
      <InstancePicker ctx={ctx} settings={settings} agent={agent} onManage={onManageInstances} />
      <div className="chat-where">
        <div className="chat-host" title={host ?? undefined}>{host ?? "No ServiceNow tab"}</div>
        {(attention || label || catalog) && (
          <div className="chat-context">
            {attention ? (
              <span className={`chat-attention ${connection.phase === "sign_in_required" ? "chat-attention-warn" : ""}`} role="status">
                {attention.text}
                {attention.action && (
                  <button type="button" className="link-btn" onClick={attention.action.run}>{attention.action.label}</button>
                )}
              </span>
            ) : label ? (
              <span className="context-chip" title={ctx?.sysId ? `${ctx.table} · ${ctx.sysId}` : ctx?.table ?? undefined}>{label}</span>
            ) : null}
            {catalog && (
              <span className="context-chip context-chip-catalog" title={`Active catalog item · ${catalog.sys_id}`}>
                <ShoppingBag size={12} aria-hidden="true" />
                <span className="context-chip-text">{catalog.name}</span>
                <button type="button" onClick={onClearCatalog} aria-label="Clear active catalog item" title="Clear active catalog item">
                  <X size={11} />
                </button>
              </span>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        className="new-chat-btn"
        onClick={onNewChat}
        disabled={agent.running}
        aria-label="New chat"
        title={agent.running ? "Stop or finish the current response first" : "New chat (saves this one to History)"}
      >
        <Plus size={20} strokeWidth={2.4} />
      </button>
    </header>
  );
}
