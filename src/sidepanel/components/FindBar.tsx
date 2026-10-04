import React, { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { useFindInFeed } from "../hooks/useFindInFeed";

export function FindBar({ find }: { find: ReturnType<typeof useFindInFeed> }) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (find.open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [find.open]);

  if (!find.open) return null;

  return (
    <div className="find-bar" role="search">
      <input
        ref={inputRef}
        value={find.query}
        placeholder="Find in conversation…"
        aria-label="Find in conversation"
        onChange={(e) => find.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) find.prev();
            else find.next();
          }
        }}
      />
      <span className={`find-count ${find.query && find.hitCount === 0 ? "find-count-none" : ""}`} aria-live="polite">
        {find.query ? (find.hitCount ? `${find.current}/${find.hitCount}` : "0/0") : ""}
      </span>
      <button type="button" className="icon-btn icon-btn-small" onClick={find.prev} disabled={!find.hitCount} aria-label="Previous match" title="Previous (Shift+Enter)">
        <ChevronUp size={16} />
      </button>
      <button type="button" className="icon-btn icon-btn-small" onClick={find.next} disabled={!find.hitCount} aria-label="Next match" title="Next (Enter)">
        <ChevronDown size={16} />
      </button>
      <button type="button" className="icon-btn icon-btn-small" onClick={find.close} aria-label="Close find" title="Close (Esc)">
        <X size={16} />
      </button>
    </div>
  );
}
