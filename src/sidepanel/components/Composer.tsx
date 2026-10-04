import React, { useRef, useState } from "react";
import { AlertTriangle, ArrowUp, Paperclip, Square, X } from "lucide-react";
import type { PlanFile, PublicSettings } from "../../shared/types";
import type { AgentApi } from "../hooks/useAgent";
import { CostMeter } from "./CostMeter";
import { ModelPicker } from "./ModelPicker";

/** Room for a few lines at rest; grows with the message up to a bound, then scrolls. */
const MAX_INPUT_PX = 184;

export function Composer({
  onSubmit,
  running,
  onStop,
  files,
  onAttach,
  onRemoveFile,
  onPasteImage,
  optimizing = false,
  fileErrors = [],
  settings,
  agent,
  hasConversation,
  onAddKey,
}: {
  onSubmit: (text: string) => void;
  running: boolean;
  onStop: () => void;
  files: PlanFile[];
  onAttach: (fl: FileList) => void;
  onRemoveFile: (i: number) => void;
  onPasteImage: (f: File) => void;
  optimizing?: boolean;
  fileErrors?: string[];
  settings: PublicSettings;
  agent: AgentApi;
  hasConversation: boolean;
  onAddKey: () => void;
}) {
  const [input, setInput] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // Sending mid-optimize would ship the message without the image still being
  // resized, so the button waits for it.
  const canSend = !running && !optimizing && !!(input.trim() || files.length);

  function fit(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, MAX_INPUT_PX) + "px";
  }

  function submit() {
    if (!canSend) return;
    onSubmit(input.trim() || "Analyze these files");
    setInput("");
    if (taRef.current) taRef.current.style.height = "";
  }

  return (
    <div className="composer-dock">
      <div className="composer" ref={cardRef}>
        {fileErrors.length > 0 && (
          <div className="composer-file-errors" role="alert">
            {fileErrors.map((e, i) => (
              <div key={i}>
                <AlertTriangle size={13} aria-hidden="true" /> {e}
              </div>
            ))}
          </div>
        )}

        {(files.length > 0 || optimizing) && (
          <div className="composer-files">
            {files.map((f, i) => (
              <span key={f.name + i} className="file-tag" title={f.name}>
                <span className="file-tag-name">{f.name}</span>
                <button type="button" onClick={() => onRemoveFile(i)} aria-label={`Remove ${f.name}`}>
                  <X size={12} />
                </button>
              </span>
            ))}
            {optimizing && <span className="file-tag file-tag-busy">Optimizing image…</span>}
          </div>
        )}

        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.gif,.xlsx,.xls,.csv,.json,.xml"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) onAttach(e.target.files);
            e.target.value = "";
          }}
        />

        <textarea
          ref={taRef}
          className="composer-input"
          rows={3}
          value={input}
          aria-label="Message"
          placeholder={hasConversation ? "Ask a follow-up…" : "Ask about the page you’re on…"}
          onChange={(e) => {
            setInput(e.target.value);
            fit(e.target);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (let i = 0; i < items.length; i++) {
              if (items[i].type.startsWith("image/")) {
                e.preventDefault();
                const file = items[i].getAsFile();
                if (file) onPasteImage(file);
                return;
              }
            }
          }}
          autoFocus
        />

        <div className="composer-toolbar">
          <button type="button" className="tool-btn" onClick={() => fileRef.current?.click()} aria-label="Attach files" title="Attach files or images">
            <Paperclip size={18} />
          </button>
          <span className="toolbar-divider" aria-hidden="true" />
          <ModelPicker settings={settings} agent={agent} anchorRef={cardRef} onAddKey={onAddKey} />
          <CostMeter cost={agent.cost} running={running} anchorRef={cardRef} />
          <span className="toolbar-spacer" />
          {running ? (
            <button type="button" className="send-btn send-btn-stop" onClick={onStop} aria-label="Stop" title="Stop this response">
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="send-btn" onClick={submit} disabled={!canSend} aria-label="Send" title="Send (Enter)">
              <ArrowUp size={20} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
