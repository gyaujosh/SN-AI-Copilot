import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Settings2 } from "lucide-react";
import { CONNECTION_LABELS, INITIAL_CONNECTION } from "../../shared/connection";
import type { ConnectionState } from "../../shared/connection";
import type { PublicSettings, SnContext, SnInstance } from "../../shared/types";
import { ROLE_LABELS, isWritableRole } from "../../shared/types";
import type { AgentApi } from "../hooks/useAgent";

/** Where the agent works: a host, and the instance the user added for it —
 * null when they haven't. Only an instance marked Production is read-only. */
export interface Target {
  host: string | null;
  instance: SnInstance | null;
}

/** The short name a target goes by: the instance's label, else its subdomain. */
export function targetName(target: Target | null | undefined): string {
  if (target?.instance) return target.instance.label;
  return target?.host ? target.host.split(".")[0] : "No tab";
}

/** "Development · changes allowed", "Production · read-only", "Not added · changes allowed". */
export function targetAccess(target: Target | null | undefined): string {
  if (!target?.instance) return "Not added · changes allowed";
  return `${ROLE_LABELS[target.instance.role]} · ${isWritableRole(target.instance.role) ? "changes allowed" : "read-only"}`;
}

/**
 * Which instance the header speaks for. While a run works it is the run's
 * instance — a new selection only applies to the next message. Otherwise the
 * pin, else the ServiceNow tab being viewed (added in Settings or not), else
 * the last selection.
 */
export function shownTarget(agent: AgentApi, settings: PublicSettings, ctx: SnContext | null): Target {
  const at = (host: string): Target => {
    const h = host.toLowerCase();
    return { host: h, instance: settings.instances.find((i) => i.host === h) ?? null };
  };
  const pinned = settings.pinnedInstanceId ? settings.instances.find((i) => i.id === settings.pinnedInstanceId) ?? null : null;
  const active = settings.instances.find((i) => i.id === settings.activeInstanceId) ?? null;
  const viewedHost = agent.connection?.host ?? ctx?.hostname ?? null;
  if (agent.running && agent.run?.host) return at(agent.run.host);
  if (pinned) return { host: pinned.host, instance: pinned };
  if (viewedHost) return at(viewedHost);
  return { host: active?.host ?? null, instance: active };
}

export type StatusTone = "ok" | "pending" | "attention" | "off";
export function statusTone(connection: ConnectionState): StatusTone {
  switch (connection.phase) {
    case "ready": return "ok";
    case "checking":
    case "reconnecting": return "pending";
    case "sign_in_required": return "attention";
    default: return "off";
  }
}

/**
 * The instance control: a readiness dot, the instance's name and a menu.
 * Connection, environment and follow/pin details live in its accessible name,
 * its tooltip and the menu — not in permanently visible text. Green means the
 * browser helper answered; it never claims API permissions were verified.
 */
export function InstancePicker({ ctx, settings, agent, onManage }: {
  ctx: SnContext | null;
  settings: PublicSettings;
  agent: AgentApi;
  /** Opens instance settings; offered at the foot of the menu. */
  onManage?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    firstOptionRef.current?.focus();
    const away = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  const connection = agent.connection || INITIAL_CONNECTION;
  const pinned = settings.pinnedInstanceId ? settings.instances.find((i) => i.id === settings.pinnedInstanceId) ?? null : null;
  const shown = shownTarget(agent, settings, ctx);
  // The tab on screen — what Auto would follow — which may differ from a pinned instance.
  const viewedHost = agent.viewedHost?.toLowerCase() ?? null;
  const viewed: Target | null = viewedHost ? { host: viewedHost, instance: settings.instances.find((i) => i.host === viewedHost) ?? null } : null;
  const name = targetName(shown);
  const tone = statusTone(connection);
  const statusText = `${CONNECTION_LABELS[connection.phase]}${connection.host ? ` on ${connection.host}` : ""}`;
  const followText = agent.running && agent.run?.host
    ? `This response works on ${agent.run.host}; a new selection applies to the next message`
    : pinned ? `Pinned to ${pinned.label}` : "Following your tab";
  const access = shown.host ? targetAccess(shown) : null;

  const pick = (id: string | null) => {
    agent.patchSettings({ pinnedInstanceId: id });
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="instance-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`instance-trigger ${shown.instance ? `instance-role-${shown.instance.role}` : shown.host ? "instance-unadded" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Instance ${name}${access ? ` (${access})` : ""}. ${statusText}. ${followText}. Change instance`}
        title={`${access ? `${access}\n` : ""}${statusText}\n${followText}`}
      >
        <span className={`status-dot status-dot-${tone}`} aria-hidden="true" />
        <span className="instance-code">{name}</span>
        <ChevronDown size={15} className="instance-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="instance-menu" role="dialog" aria-label="Choose an instance">
          <div className="instance-menu-status">
            <span className={`status-dot status-dot-${tone}`} aria-hidden="true" />
            <span>
              <span className="instance-menu-status-line">{statusText}</span>
              <span className="instance-menu-status-sub">{followText}</span>
            </span>
          </div>
          <div className="instance-menu-options">
            <button ref={firstOptionRef} type="button" className="instance-option" aria-pressed={!pinned} onClick={() => pick(null)}>
              <span className="instance-option-check" aria-hidden="true">{!pinned && <Check size={14} />}</span>
              <span className="instance-option-text">
                Auto — follow my tab
                <span className="instance-option-sub">
                  {viewed ? `Now on ${targetName(viewed)}${viewed.instance ? "" : " · not added"}` : "No ServiceNow tab in view"}
                </span>
              </span>
            </button>
            {settings.instances.map((inst) => (
              <button
                key={inst.id}
                type="button"
                className="instance-option"
                aria-pressed={pinned?.id === inst.id}
                title={inst.host}
                onClick={() => pick(inst.id)}
              >
                <span className="instance-option-check" aria-hidden="true">{pinned?.id === inst.id && <Check size={14} />}</span>
                <span className="instance-option-text">
                  {inst.label}
                  <span className="instance-option-sub">{ROLE_LABELS[inst.role]} · {inst.host}</span>
                </span>
              </button>
            ))}
          </div>
          {onManage && (
            <button type="button" className="instance-option instance-option-manage" onClick={() => { setOpen(false); onManage(); }}>
              <span className="instance-option-check" aria-hidden="true"><Settings2 size={14} /></span>
              <span className="instance-option-text">{settings.instances.length ? "Manage instances…" : "Add instances to pin one…"}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
