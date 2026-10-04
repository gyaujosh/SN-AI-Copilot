// Provider · model, in one popover anchored to the composer.
//
// Tabs choose the provider; the list is that provider's live catalog, fetched
// from its models API with the user's key (nothing here is a hard-coded model
// list). Search filters within the provider, and any model id can still be
// typed in for a model the catalog doesn't list. Choosing a model writes the
// provider and model in one settings patch.
//
// A model that takes a reasoning effort shows its levels under the list —
// only the ones it accepts — and picking such a model keeps the popover open
// on them. "Default" sends none, so the model runs at its own setting.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, KeyRound, Loader2, RefreshCw, Search, X } from "lucide-react";
import type { EffortLevel, ProviderId, PublicSettings } from "../../shared/types";
import { PROVIDERS, PROVIDER_IDS, modelDisplayName } from "../../shared/types";
import { EFFORT_LABELS, chosenEffort, modelEfforts } from "../../shared/effort";
import type { AgentApi } from "../hooks/useAgent";

/** The trigger's text, "Claude · Claude Sonnet 5", and the effort chosen for that model. */
export function modelTriggerLabel(settings: PublicSettings, agent: AgentApi): { family: string; model: string; effort?: string } {
  const provider = settings.provider;
  const modelId = settings.models[provider];
  const entry = agent.modelLists[provider]?.models.find((m) => m.id === modelId);
  const effort = chosenEffort(settings.efforts, provider, modelId, modelEfforts(provider, modelId, entry).efforts);
  return { family: PROVIDERS[provider].label, model: entry?.name || modelDisplayName(provider, modelId), effort: effort && EFFORT_LABELS[effort] };
}

export function ModelPicker({
  settings,
  agent,
  anchorRef,
  onAddKey,
}: {
  settings: PublicSettings;
  agent: AgentApi;
  /** The composer: the popover opens above it, the width of it. */
  anchorRef: React.RefObject<HTMLElement>;
  onAddKey: () => void;
}) {
  const current = settings.provider;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ProviderId>(current);
  const [query, setQuery] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [customModel, setCustomModel] = useState("");
  /** The model just picked, whose efforts show before the settings echo back. */
  const [picked, setPicked] = useState<{ tab: ProviderId; id: string } | null>(null);
  const [placement, setPlacement] = useState<{ up: boolean; room: number; caret: number }>({ up: true, room: 420, caret: 60 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const effortRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const trigger = modelTriggerLabel(settings, agent);
  const triggerTitle = `${trigger.family} · ${trigger.model}${trigger.effort ? ` · ${trigger.effort} effort` : ""}`;

  // The provider in use gets its catalog as soon as it has a key, so the
  // trigger shows the model's own name and a fresh key gets its default model.
  const currentHasKey = settings.keysPresent[current];
  useEffect(() => {
    if (currentHasKey) agent.listModels(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, currentHasKey]);

  function openPicker() {
    setTab(current);
    setQuery("");
    setCustomOpen(false);
    setPicked(null);
    setOpen(true);
  }
  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Load every catalog the user holds a key for, once per opening.
  useEffect(() => {
    if (!open) return;
    for (const provider of PROVIDER_IDS) {
      if (settings.keysPresent[provider]) agent.listModels(provider);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Upward when there is room, otherwise whichever side has more.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current?.getBoundingClientRect();
    const button = triggerRef.current?.getBoundingClientRect();
    if (!anchor || !button) return;
    const above = anchor.top - 8;
    const below = window.innerHeight - anchor.bottom - 8;
    const up = above >= 300 || above >= below;
    setPlacement({ up, room: Math.max(180, up ? above : below), caret: button.left - anchor.left + button.width / 2 });
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!popRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open, close]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open, tab]);

  const info = PROVIDERS[tab];
  const hasKey = settings.keysPresent[tab];
  const live = agent.modelLists[tab];
  const selectedId = tab === current ? settings.models[current] : null;
  const models = useMemo(() => {
    const list = (live?.models ?? []).map(({ id, name }) => ({ id, name }));
    // A model in use stays visible even when the catalog doesn't list it.
    if (selectedId && !list.some((m) => m.id === selectedId)) list.unshift({ id: selectedId, name: modelDisplayName(tab, selectedId) });
    const needle = query.trim().toLowerCase();
    return needle ? list.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(needle)) : list;
  }, [live, tab, selectedId, query]);
  const loading = !!live?.loading;
  const loadError = live?.error && live.error !== "no_key" ? live.error : null;

  // The effort row belongs to the model in use on this tab, or the one just picked.
  const effortModel = picked?.tab === tab ? picked.id : selectedId;
  const effortEntry = effortModel ? live?.models.find((m) => m.id === effortModel) : undefined;
  const offered = effortModel ? modelEfforts(tab, effortModel, effortEntry) : { efforts: [] as EffortLevel[] };
  const effort = effortModel ? chosenEffort(settings.efforts, tab, effortModel, offered.efforts) ?? null : null;
  const effortModelName = effortEntry?.name || (effortModel ? modelDisplayName(tab, effortModel) : "");

  // A model just picked for its efforts: its current level takes focus.
  useEffect(() => {
    if (picked) effortRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
  }, [picked]);

  function selectTab(next: ProviderId) {
    setTab(next);
    setQuery("");
    setCustomOpen(false);
    setPicked(null);
  }

  function onTabKey(e: React.KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const index = PROVIDER_IDS.indexOf(tab);
    const next = PROVIDER_IDS[(index + (e.key === "ArrowRight" ? 1 : PROVIDER_IDS.length - 1)) % PROVIDER_IDS.length];
    selectTab(next);
    tabRefs.current[next]?.focus();
  }

  function pick(modelId: string) {
    agent.patchSettings({ provider: tab, models: { [tab]: modelId } });
    const entry = live?.models.find((m) => m.id === modelId);
    if (modelEfforts(tab, modelId, entry).efforts.length === 0) {
      close();
      return;
    }
    // Stay open on the new model's efforts; "Default" is already in effect.
    setCustomOpen(false);
    setPicked({ tab, id: modelId });
  }

  function chooseEffort(level: EffortLevel | null) {
    if (!effortModel) return;
    agent.patchSettings({ effort: { provider: tab, model: effortModel, level } });
    close();
  }

  function commitCustom() {
    const id = customModel.trim();
    if (!id) return;
    setCustomModel("");
    pick(id);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="model-trigger"
        onClick={() => (open ? close() : openPicker())}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model: ${triggerTitle}. Change model`}
        title={triggerTitle}
      >
        <span className="model-trigger-family">{trigger.family}</span>
        <span className="model-trigger-sep" aria-hidden="true">·</span>
        <span className="model-trigger-name">{trigger.model}</span>
        <ChevronDown size={15} className={`model-trigger-chevron ${open ? "model-trigger-chevron-open" : ""}`} aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={popRef}
          className={`picker ${placement.up ? "picker-up" : "picker-down"}`}
          role="dialog"
          aria-label="Choose a model"
          style={{ maxHeight: placement.room, ["--caret-x" as string]: `${placement.caret}px` }}
        >
          <div className="picker-head">
            <h2 className="picker-title">Choose a model</h2>
            <button type="button" className="icon-btn" onClick={() => close()} aria-label="Close model picker">
              <X size={17} />
            </button>
          </div>

          <div className="segmented picker-tabs" role="tablist" aria-label="Provider">
            {PROVIDER_IDS.map((p) => (
              <button
                key={p}
                id={`picker-tab-${p}`}
                ref={(el) => { tabRefs.current[p] = el; }}
                type="button"
                role="tab"
                aria-selected={tab === p}
                aria-controls="picker-panel"
                tabIndex={tab === p ? 0 : -1}
                className="segment"
                onClick={() => selectTab(p)}
                onKeyDown={onTabKey}
              >
                {PROVIDERS[p].label}
              </button>
            ))}
          </div>

          <div className="picker-panel" id="picker-panel" role="tabpanel" aria-labelledby={`picker-tab-${tab}`}>
            {!hasKey ? (
              <div className="picker-empty">
                <KeyRound size={16} aria-hidden="true" />
                <div>
                  <p>{info.label} needs an API key before its models can be used.</p>
                  <button type="button" className="link-btn" onClick={() => { close(false); onAddKey(); }}>Add a key in Settings</button>
                </div>
              </div>
            ) : (
              <>
                <div className="picker-search">
                  <Search size={15} aria-hidden="true" />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`Search ${info.label} models…`}
                    aria-label={`Search ${info.label} models`}
                  />
                  {loading
                    ? <Loader2 size={15} className="spin" aria-label="Loading models" />
                    : <button type="button" className="icon-btn icon-btn-small" onClick={() => agent.listModels(tab, true)} aria-label="Refresh model list" title="Refresh model list"><RefreshCw size={14} /></button>}
                </div>

                <div className="picker-list" role="group" aria-label={`${info.label} models`}>
                  {loadError && (
                    <p className="picker-note picker-note-error" role="alert">
                      Couldn’t load {info.label} models ({loadError}).{" "}
                      <button type="button" className="link-btn" onClick={() => agent.listModels(tab, true)}>Try again</button>
                    </p>
                  )}
                  {loading && !live?.models.length && <p className="picker-note">Loading {info.label} models…</p>}
                  {models.map((m) => {
                    const selected = m.id === selectedId;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        className={`picker-item ${selected ? "picker-item-selected" : ""}`}
                        aria-pressed={selected}
                        onClick={() => pick(m.id)}
                      >
                        <span className="picker-item-text">
                          <span className="picker-item-name">{m.name}</span>
                          {m.id !== m.name && <span className="picker-item-hint mono">{m.id}</span>}
                        </span>
                        {selected && <span className="picker-item-check" aria-hidden="true"><Check size={13} strokeWidth={3} /></span>}
                      </button>
                    );
                  })}
                  {models.length === 0 && !loading && (
                    query.trim() ? <p className="picker-note">No models match “{query}”.</p>
                    : !loadError && <p className="picker-note">No models listed yet.</p>
                  )}
                  {customOpen ? (
                    <div className="picker-custom">
                      <input
                        autoFocus
                        className="field-input"
                        aria-label={`Custom ${info.label} model id`}
                        placeholder={tab === "openrouter" ? "vendor/model-id" : "model-id"}
                        value={customModel}
                        onChange={(e) => setCustomModel(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") commitCustom(); }}
                      />
                      <button type="button" className="btn-solid btn-small" onClick={commitCustom} disabled={!customModel.trim()}>Use</button>
                    </div>
                  ) : (
                    <button type="button" className="picker-custom-open" onClick={() => setCustomOpen(true)}>Use a model id…</button>
                  )}
                </div>
              </>
            )}
          </div>

          {hasKey && offered.efforts.length > 0 && (
            <div className="picker-effort" ref={effortRef}>
              <p className="picker-effort-label" id="picker-effort-label">
                Effort for <strong>{effortModelName}</strong>
              </p>
              <div className="picker-effort-options" role="group" aria-labelledby="picker-effort-label">
                {[null, ...offered.efforts].map((level) => (
                  <button
                    key={level ?? "default"}
                    type="button"
                    className="effort-chip"
                    aria-pressed={level === effort}
                    title={level ? undefined : `The model's own setting${offered.defaultEffort ? ` (${EFFORT_LABELS[offered.defaultEffort]})` : ""}`}
                    onClick={() => chooseEffort(level)}
                  >
                    {level ? EFFORT_LABELS[level] : "Default"}
                  </button>
                ))}
              </div>
              <p className="picker-effort-hint">Higher effort thinks longer and costs more.</p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
