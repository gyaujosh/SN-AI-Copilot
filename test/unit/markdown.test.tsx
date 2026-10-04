// Assistant output rendering: tables keep their columns, content is escaped,
// and code is shown and copied exactly as written.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { fmtMd } from "../../src/sidepanel/utils/markdown";
import { OutputBlock } from "../../src/sidepanel/components/Feed";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
function html(md: string) {
  const el = document.createElement("div");
  el.innerHTML = fmtMd(md);
  return el;
}
const rows = (el: HTMLElement) => Array.from(el.querySelectorAll("tr")).map((tr) => Array.from(tr.children).map((c) => c.textContent));

describe("tables", () => {
  it("keeps an empty cell in its column", () => {
    const el = html("| Number | Priority | State |\n| --- | --- | --- |\n| INC0010003 | 2 - High |  |\n|  | 3 - Moderate | New |");
    expect(rows(el)).toEqual([["Number", "Priority", "State"], ["INC0010003", "2 - High", ""], ["", "3 - Moderate", "New"]]);
  });

  it("pads short rows and trims long ones to the header's columns", () => {
    const el = html("| A | B | C |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |");
    expect(rows(el).slice(1)).toEqual([["1", "", ""], ["1", "2", "3"]]);
  });

  it("keeps an escaped pipe inside its cell", () => {
    const el = html("| Query | Count |\n| --- | --- |\n| a\\|b | 2 |");
    expect(rows(el)[1]).toEqual(["a|b", "2"]);
  });

  it("sets record numbers and sys_ids in the identifier face, and scrolls wide tables in a frame", () => {
    const el = html("| Number | Sys ID |\n| --- | --- |\n| INC0010001 | " + "a".repeat(32) + " |");
    expect(el.querySelectorAll(".md-id")).toHaveLength(2);
    expect(el.querySelector(".md-table-wrap > table")).not.toBeNull();
  });
});

describe("safety", () => {
  it("escapes markup in prose, tables and code", () => {
    const el = html('<img src=x onerror="alert(1)"> **bold**\n\n| x |\n| - |\n| <script>alert(1)</script> |\n\n```html\n<b>hi</b>\n```');
    expect(el.querySelector("img, script, b")).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(el.querySelector("strong")?.textContent).toBe("bold");
  });

  it("leaves markdown escapes inside code untouched", () => {
    const el = html("```\nconst re = /a\\*b/; if (a < b && c) {}\n```");
    expect(el.querySelector("pre code")?.textContent).toBe("const re = /a\\*b/; if (a < b && c) {}");
  });
});

describe("code copy", () => {
  it("copies the code exactly as written", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const code = 'if (a < b && c !== "&lt;") { x = /a\\*b/; }';
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<OutputBlock item={{ kind: "assistant", id: "a", text: "```js\n" + code + "\n```" }} />));
    const copy = container.querySelector<HTMLButtonElement>(".copy-btn")!;
    await act(async () => { copy.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(writeText).toHaveBeenCalledWith(code);
    expect(copy.textContent).toBe("Copied");
    act(() => root.unmount());
    container.remove();
  });
});
