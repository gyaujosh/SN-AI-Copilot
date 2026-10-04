// Settings: AI Access, Instances and Appearance. Changes save automatically.

import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Check, ChevronDown, ChevronRight, Lock, Plus, Trash2 } from "lucide-react";
import type { InstanceOp, InstanceRole, ProviderId, SnInstance } from "../../shared/types";
import { INSTANCE_ROLES, PROVIDERS, PROVIDER_IDS, ROLE_LABELS, displayUrl, isWritableRole, suggestRole } from "../../shared/types";
import { parseInstanceHost } from "../../shared/connection";
import { useView } from "../hooks/useView";
import { arrowKeys } from "../hooks/useArrowKeys";
import type { AgentApi } from "../hooks/useAgent";
import { useTheme, type TextSize } from "../theme/ThemeContext";
import { InstancePicker, shownTarget } from "./InstancePicker";
import { ProviderLogo, familyOf } from "./ProviderLogo";

const TEXT_SIZES: { id: TextSize; label: string }[] = [
  { id: "sm", label: "Small" },
  { id: "md", label: "Default" },
  { id: "lg", label: "Large" },
];
const SECTIONS = [
  { id: "keys", label: "AI Access" },
  { id: "instances", label: "Instances" },
  { id: "appearance", label: "Appearance" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];
const NO_KEYS: Record<ProviderId, string> = { anthropic: "", openai: "", openrouter: "" };

/** Segmented control with radio semantics. */
function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (id: T) => void }) {
  const onKeyDown = arrowKeys(options.map((o) => o.id), value, onChange);
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          tabIndex={value === o.id ? 0 : -1}
          className="segment"
          onClick={() => onChange(o.id)}
          onKeyDown={onKeyDown}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A native select with the panel's chevron, for an added instance's environment. */
function RoleSelect({ label, value, onChange }: { label: string; value: InstanceRole; onChange: (role: InstanceRole) => void }) {
  return (
    <span className="role-select">
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as InstanceRole)}>
        {INSTANCE_ROLES.map((r) => (
          <option key={r} value={r}>{ROLE_LABELS[r]}</option>
        ))}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
    </span>
  );
}

/** Every environment on show at once when adding an instance, with what the
 * chosen one lets the assistant do spelled out underneath. */
function EnvironmentChoice({ value, onChange }: { value: InstanceRole; onChange: (role: InstanceRole) => void }) {
  const onKeyDown = arrowKeys(INSTANCE_ROLES, value, onChange);
  const writable = isWritableRole(value);
  return (
    <div className="inst-add-env">
      <span className="inst-add-env-label" id="inst-env-label">Environment</span>
      <div className="env-options" role="radiogroup" aria-labelledby="inst-env-label">
        {INSTANCE_ROLES.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={value === r}
            tabIndex={value === r ? 0 : -1}
            className="env-chip"
            onClick={() => onChange(r)}
            onKeyDown={onKeyDown}
          >
            {ROLE_LABELS[r]}
          </button>
        ))}
      </div>
      <p className={`env-effect ${writable ? "env-effect-writable" : "env-effect-readonly"}`}>
        {writable ? <Check size={14} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />}
        {writable ? "Changes allowed — the assistant asks you before making any." : "Read-only — the assistant can look, but never change anything."}
      </p>
    </div>
  );
}

export function SettingsPanel({
  open,
  section,
  agent,
  onClose,
}: {
  open: boolean;
  /** "keys" (default), "instances" or "appearance". */
  section?: string | null;
  agent: AgentApi;
  onClose: () => void;
}) {
  const viewRef = useView(open, onClose);
  const { theme, setTheme, textSize, setTextSize, navPinned, setNavPinned } = useTheme();
  const [keys, setKeys] = useState<Record<ProviderId, string>>({ ...NO_KEYS });
  const [expandedKey, setExpandedKey] = useState<ProviderId | null>(null);
  const [savedKey, setSavedKey] = useState<ProviderId | null>(null);
  const [active, setActive] = useState<SectionId>("keys");
  const [addOpen, setAddOpen] = useState(false);
  const [instLabel, setInstLabel] = useState("");
  const [instHost, setInstHost] = useState("");
  const [instRole, setInstRole] = useState<InstanceRole>("dev");
  const [roleTouched, setRoleTouched] = useState(false);
  const [instError, setInstError] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyInputs = useRef<Partial<Record<ProviderId, HTMLInputElement | null>>>({});
  /** Keys typed but not yet saved, for the flush when the view or the whole panel closes. */
  const typedKeys = useRef(keys);
  typedKeys.current = keys;
  const { settings } = agent;

  useEffect(() => {
    if (open) {
      setKeys({ ...NO_KEYS });
      setExpandedKey(null);
      setActive(section === "instances" || section === "appearance" ? section : "keys");
      setAddOpen(false);
      setInstError("");
    }
  }, [open, section]);

  // Whether each saved key works: loading its catalog is the check.
  useEffect(() => {
    if (!open || active !== "keys") return;
    for (const p of PROVIDER_IDS) if (settings.keysPresent[p]) agent.listModels(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  // A key typed but not yet committed (no blur, no Enter) is flushed the
  // moment the view closes — or the whole panel does — so leaving
  // mid-keystroke loses nothing.
  const flushTypedKeys = () => {
    for (const p of PROVIDER_IDS) {
      const v = typedKeys.current[p].trim();
      if (v) agent.patchSettings({ apiKeys: { [p]: v } });
    }
  };
  useEffect(() => {
    if (!open) flushTypedKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    window.addEventListener("pagehide", flushTypedKeys);
    return () => window.removeEventListener("pagehide", flushTypedKeys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  /** Commit one provider's typed key immediately (auto-save). */
  function commitKey(p: ProviderId) {
    const v = keys[p].trim();
    if (!v) return;
    agent.patchSettings({ apiKeys: { [p]: v } });
    setKeys((k) => ({ ...k, [p]: "" }));
    setSavedKey(p);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedKey(null), 1800);
  }

  function removeKey(p: ProviderId) {
    agent.patchSettings({ apiKeys: { [p]: "" } });
    setKeys((k) => ({ ...k, [p]: "" }));
    // The button goes away with the key; keep focus in the row.
    keyInputs.current[p]?.focus();
  }

  /** What is known about a saved key: loading its catalog verifies it. */
  function keyStatus(p: ProviderId): { text: string; tone: "unset" | "ok" | "bad" } {
    if (!settings.keysPresent[p]) return { text: "Not set", tone: "unset" };
    const list = agent.modelLists[p];
    if (list?.loading) return { text: "Key saved · checking…", tone: "ok" };
    if (list?.error === "API key was rejected") return { text: "Key rejected — paste a new one", tone: "bad" };
    if (list?.error && list.error !== "no_key") return { text: "Key saved · couldn't list models", tone: "ok" };
    if (list?.models.length) return { text: `Key saved · ${list.models.length} models`, tone: "ok" };
    return { text: "Key saved", tone: "ok" };
  }

  function openAdd(host = "") {
    setInstHost(host);
    setInstLabel(host ? host.split(".")[0] : "");
    setInstRole(host ? suggestRole(host) : "dev");
    setRoleTouched(false);
    setInstError("");
    setAddOpen(true);
  }

  function onHostInput(value: string) {
    setInstHost(value);
    setInstError("");
    // Until the user chooses, the environment follows the host's name.
    const host = parseInstanceHost(value);
    if (host && !roleTouched) setInstRole(suggestRole(host));
  }

  function addInstance() {
    const host = parseInstanceHost(instHost);
    if (!host) {
      setInstError("Enter a ServiceNow host, e.g. dev12345.service-now.com");
      return;
    }
    if (settings.instances.some((i) => i.host === host)) {
      setInstError("That instance is already in the list.");
      return;
    }
    const inst: SnInstance = {
      id: "inst_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      label: instLabel.trim() || host.split(".")[0],
      host,
      role: instRole,
    };
    editInstances({ op: "add", instance: inst });
    setInstLabel("");
    setInstHost("");
    setInstError("");
    setAddOpen(false);
  }

  /** Edits go as operations on the stored list, so quick successive edits never undo each other. */
  function editInstances(...ops: InstanceOp[]) {
    agent.patchSettings({ instanceOps: ops });
  }

  function showSection(id: SectionId) {
    setActive(id);
    bodyRef.current?.scrollTo({ top: 0 });
  }

  const target = shownTarget(agent, settings, agent.ctx);
  // The ServiceNow tab on screen, when it isn't one of the user's instances yet.
  const viewedHost = agent.viewedHost?.toLowerCase() ?? null;
  const unaddedHost = viewedHost && !settings.instances.some((i) => i.host === viewedHost) ? viewedHost : null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="app-view"
          ref={viewRef}
          role="region"
          aria-label="Settings"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.16 }}
        >
          <div className="view-head">
            <button type="button" className="icon-btn view-back" onClick={onClose} aria-label="Back to chat" title="Back to chat">
              <ArrowLeft size={20} />
            </button>
            <h1 className="view-title">Settings</h1>
            <InstancePicker ctx={agent.ctx} settings={settings} agent={agent} onManage={() => showSection("instances")} />
          </div>

          <div className="view-tabs">
            <div className="segmented" role="tablist" aria-label="Settings sections">
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  id={`settings-tab-${s.id}`}
                  type="button"
                  role="tab"
                  aria-selected={active === s.id}
                  aria-controls={`settings-panel-${s.id}`}
                  tabIndex={active === s.id ? 0 : -1}
                  className="segment"
                  onClick={() => showSection(s.id)}
                  onKeyDown={arrowKeys(SECTIONS.map((x) => x.id), active, showSection)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="view-body" ref={bodyRef}>
            {active === "keys" && (
              <section className="settings-section" data-section="keys" id="settings-panel-keys" role="tabpanel" aria-labelledby="settings-tab-keys">
                <h2 className="section-title" id="ai-access-title">AI providers</h2>
                <p className="section-sub">Add an API key for each provider you want to use. Their models are listed live in the chat’s model picker.</p>
                <div className="card card-list">
                  {PROVIDER_IDS.map((id) => {
                    const info = PROVIDERS[id];
                    const present = settings.keysPresent[id];
                    const expanded = expandedKey === id;
                    const status = keyStatus(id);
                    return (
                      <div key={id} className={`key-row ${expanded ? "key-row-open" : ""}`}>
                        <button type="button" className="key-row-head" aria-expanded={expanded} onClick={() => setExpandedKey(expanded ? null : id)}>
                          <ProviderLogo family={familyOf(id)} size={30} />
                          <span className="card-row-text">
                            <span className="card-row-title">
                              {info.label} API
                              {savedKey === id ? (
                                <span className="saved-chip"><Check size={11} aria-hidden="true" /> Saved</span>
                              ) : present && settings.provider === id ? (
                                <span className="inuse-chip">In use</span>
                              ) : null}
                            </span>
                            <span className={`card-row-sub key-status-${status.tone}`}>{status.text}</span>
                          </span>
                          <ChevronRight size={16} className="disclosure-chevron" aria-hidden="true" />
                        </button>
                        {expanded && (
                          <div className="key-row-edit">
                            <input
                              ref={(el) => { keyInputs.current[id] = el; }}
                              type="password"
                              className="field-input"
                              aria-label={`${info.label} API key`}
                              placeholder={present ? "Paste a new key to replace it" : info.keyPlaceholder}
                              value={keys[id]}
                              onChange={(e) => setKeys((k) => ({ ...k, [id]: e.target.value }))}
                              onBlur={() => commitKey(id)}
                              onKeyDown={(e) => { if (e.key === "Enter") commitKey(id); }}
                              autoComplete="off"
                              autoFocus
                            />
                            <p className="field-hint">
                              Get a key at{" "}
                              <a href={info.keyUrl} target="_blank" rel="noreferrer">{displayUrl(info.keyUrl)}</a>.
                              {" "}Saved when you press Enter or leave the field; a stored key is never shown again.
                            </p>
                            {present && (
                              <button type="button" className="btn-line btn-small key-remove" onClick={() => removeKey(id)}>
                                <Trash2 size={14} aria-hidden="true" /> Remove key
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="section-note">Choose your model in chat. Usage is billed by each provider to the account that owns the key.</p>

                <p className="settings-foot-note">
                  <Lock size={12} aria-hidden="true" /> Keys stay in this browser and go only to their own provider. Chat is sent to the AI you select.
                </p>
              </section>
            )}

            {active === "instances" && (
              <section className="settings-section" data-section="instances" id="settings-panel-instances" role="tabpanel" aria-labelledby="settings-tab-instances">
                <div className="section-title-row">
                  <h2 className="section-title" id="instances-title">ServiceNow instances</h2>
                  {!addOpen && (
                    <button type="button" className="link-btn add-btn" onClick={() => openAdd()}>
                      <Plus size={16} aria-hidden="true" /> Add instance
                    </button>
                  )}
                </div>

                {unaddedHost && !addOpen && (
                  <div className="card card-row inst-suggest">
                    <span className="card-row-text">
                      <span className="card-row-title">{unaddedHost.split(".")[0]}</span>
                      <span className="card-row-sub inst-host" title={unaddedHost}>{unaddedHost}</span>
                      <span className="card-row-meta">This tab · not added · changes allowed</span>
                    </span>
                    <button type="button" className="btn-line btn-small" onClick={() => openAdd(unaddedHost)} aria-label={`Add ${unaddedHost}`}>
                      Add
                    </button>
                  </div>
                )}

                {settings.instances.length > 0 ? (
                  <div className="card card-list">
                    {settings.instances.map((inst) => {
                      const isActive = target.instance?.id === inst.id;
                      const writable = isWritableRole(inst.role);
                      return (
                        <div key={inst.id} className="card-row inst-row">
                          <span className="card-row-text">
                            <span className="card-row-title">{inst.label}</span>
                            <span className="card-row-sub inst-host" title={inst.host}>{inst.host}</span>
                            <span className="inst-role">
                              <RoleSelect label={`Environment for ${inst.label}`} value={inst.role} onChange={(role) => editInstances({ op: "role", id: inst.id, role })} />
                              <span className={`card-row-meta ${writable ? "inst-writable" : ""}`}>{writable ? "Changes allowed" : "Read-only"}</span>
                            </span>
                          </span>
                          <span className="inst-actions">
                            {isActive ? (
                              <span className="active-pill">Active</span>
                            ) : (
                              <button type="button" className="btn-line btn-small" onClick={() => agent.switchInstance(inst.id)} aria-label={`Use ${inst.label}`}>
                                Use
                              </button>
                            )}
                            <button type="button" className="icon-btn inst-remove" aria-label={`Remove ${inst.label}`} title="Remove instance" onClick={() => editInstances({ op: "remove", id: inst.id })}>
                              <Trash2 size={16} />
                            </button>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : !addOpen && !unaddedHost ? (
                  <div className="card inst-empty">
                    <p>No instances yet. Open any ServiceNow tab to start — the assistant can work on it right away, asking before every change. Add an instance here to name it and set its environment; Production is read-only.</p>
                  </div>
                ) : null}

                {addOpen && (
                  <div className="card inst-add">
                    <h3 className="inst-add-title">Add an instance</h3>
                    <input className="field-input" placeholder="Name (e.g. Personal PDI)" aria-label="Instance name" value={instLabel} onChange={(e) => setInstLabel(e.target.value)} autoFocus />
                    <input
                      className="field-input"
                      placeholder="dev12345.service-now.com"
                      aria-label="Instance host"
                      value={instHost}
                      onChange={(e) => onHostInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") addInstance(); }}
                    />
                    <EnvironmentChoice value={instRole} onChange={(role) => { setInstRole(role); setRoleTouched(true); }} />
                    {instError && <div className="field-error" role="alert">{instError}</div>}
                    <div className="inst-add-actions">
                      <button type="button" className="btn-line" onClick={() => setAddOpen(false)}>Cancel</button>
                      <button type="button" className="btn-solid" onClick={addInstance}><Plus size={15} aria-hidden="true" /> Add</button>
                    </div>
                  </div>
                )}

                <p className="section-note">
                  Changes are allowed on every instance except those marked Production, including instances not added here. To make an instance read-only, add it as Production.
                  “Use” pins an instance; choose Auto in the instance menu to follow your tab. Sign in through a ServiceNow tab.
                </p>
              </section>
            )}

            {active === "appearance" && (
              <section className="settings-section" data-section="appearance" id="settings-panel-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance">
                <h2 className="section-title" id="appearance-title">Appearance</h2>

                <h3 className="control-label" id="theme-label">Theme</h3>
                <div className="theme-cards" role="radiogroup" aria-labelledby="theme-label">
                  {(["light", "dark"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={theme === t}
                      tabIndex={theme === t ? 0 : -1}
                      className={`theme-card theme-card-${t}`}
                      onClick={() => setTheme(t)}
                      onKeyDown={arrowKeys(["light", "dark"] as const, theme, setTheme)}
                    >
                      <span className="theme-preview" aria-hidden="true">
                        <span className="tp-line" />
                        <span className="tp-bubble" />
                        <span className="tp-input"><span className="tp-send" /></span>
                      </span>
                      <span className="theme-card-label">{t === "light" ? "Light" : "Dark"}</span>
                      <span className="theme-card-check" aria-hidden="true">{theme === t && <Check size={12} strokeWidth={3} />}</span>
                    </button>
                  ))}
                </div>

                <h3 className="control-label">Text size</h3>
                <Segmented label="Text size" value={textSize} options={TEXT_SIZES} onChange={setTextSize} />
                <div className="text-preview message-content">This is how your chat text will look.</div>

                <h3 className="control-label">Bottom navigation</h3>
                <Segmented
                  label="Bottom navigation"
                  value={navPinned ? "pinned" : "auto"}
                  options={[{ id: "auto", label: "Auto-hide" }, { id: "pinned", label: "Pinned" }]}
                  onChange={(v) => setNavPinned(v === "pinned")}
                />
                <p className="field-hint">
                  {navPinned ? "Unpin to hide it when not in use." : "Hover the bottom edge, tap it, or press Tab to show it."}
                </p>
              </section>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
