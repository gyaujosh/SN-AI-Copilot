function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// eslint-disable-next-line no-control-regex -- \x01 sentinel stands in for an escaped pipe
const PIPE = /\x01/g;
/** Record numbers and sys_ids read as identifiers, in the mono face. */
const IDENTIFIER = /^(?:[A-Z]{2,8}\d{4,}|[0-9a-f]{32})$/;

/** Cells of one table row. Only the outer pipes are structure: an empty cell
 * between two pipes is a real (blank) column and must keep its place. */
function cells(row: string): string[] {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|")) r = r.slice(0, -1);
  return r.split("|").map((c) => c.trim());
}

function cell(tag: "th" | "td", content: string): string {
  const inner = tag === "td" && IDENTIFIER.test(content) ? `<span class="md-id">${content}</span>` : content;
  return `<${tag} class="md-${tag}">${inner}</${tag}>`;
}

export function fmtMd(text: string): string {
  // \x00 and \x01 are this formatter's own placeholders: in the text itself
  // they could stand in for code or a pipe that isn't there.
  // eslint-disable-next-line no-control-regex -- removing exactly those characters
  text = String(text ?? "").replace(/[\x00\x01]/g, "");

  // 1. Extract and protect code first: code is shown and copied exactly as written.
  const codeBlocks: string[] = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const i = codeBlocks.length;
    const body = code.trim();
    const copy = `<button class="copy-btn" type="button" data-code="${esc(body)}">Copy</button>`;
    const header = `<div class="code-header">${lang ? `<span class="code-lang">${esc(lang)}</span>` : "<span></span>"}${copy}</div>`;
    codeBlocks.push(`<div class="code-block-wrapper">${header}<pre><code>${esc(body)}</code></pre></div>`);
    return `\x00CODE${i}\x00`;
  });
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_m, code) => {
    const i = inlineCodes.length;
    inlineCodes.push(`<code class="inline-code">${esc(code)}</code>`);
    return `\x00INLINE${i}\x00`;
  });

  // 2. Markdown escapes in prose. An escaped pipe is cell text, not table
  // structure, so it is held aside until the tables are built.
  text = text.replace(/\\\|/g, "\x01").replace(/\\([*_`])/g, "$1");

  // 3. Escape remaining HTML
  text = esc(text);

  // 4. Tables — every row has exactly the header's columns.
  text = text.replace(/^\|(.+)\|\s*\n\|[-| :]+\|\s*\n((?:\|.+\|\s*\n?)*)/gm, (_m, header, rows) => {
    const heads = cells(`|${header}|`);
    const th = heads.map((c) => cell("th", c)).join("");
    const trs = rows
      .trim()
      .split("\n")
      .filter((row: string) => row.trim())
      .map((row: string) => {
        const values = cells(row);
        const fitted = heads.map((_h, i) => values[i] ?? "");
        return `<tr>${fitted.map((c) => cell("td", c)).join("")}</tr>`;
      })
      .join("");
    return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
  });

  // 5. Headings (handle #### and ##### as h3, must come before ### to avoid partial match)
  text = text.replace(/^#{4,} (.+)$/gm, '<div class="md-h3">$1</div>');
  text = text.replace(/^### (.+)$/gm, '<div class="md-h3">$1</div>');
  text = text.replace(/^## (.+)$/gm, '<div class="md-h2">$1</div>');
  text = text.replace(/^# (.+)$/gm, '<div class="md-h1">$1</div>');

  // 6. Horizontal rule
  text = text.replace(/^---+$/gm, '<hr class="md-hr"/>');

  // 7. Unordered lists
  text = text.replace(/^[ \t]*[-*] (.+)$/gm, '<li class="md-li">$1</li>');
  text = text.replace(
    /(<li class="md-li">.*<\/li>\n?)+/g,
    (m) =>
      `<ul class="md-ul">${m.replace(
        /<li class="md-li">/g,
        '<li class="md-li"><span class="md-bullet" aria-hidden="true">•</span><span>'
      ).replace(/<\/li>/g, "</span></li>")}</ul>`
  );

  // 8. Numbered lists
  text = text.replace(/^(\d+)\. (.+)$/gm, '<li class="md-oli" value="$1">$2</li>');
  text = text.replace(/(<li class="md-oli"[^>]*>.*<\/li>\n?)+/g, (m) => `<ol class="md-ol">${m}</ol>`);

  // 9. Bold and italic
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong class="md-bold">$1</strong>');
  text = text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");

  // 10. Line breaks — none next to block elements, whose margins already space them.
  // eslint-disable-next-line no-control-regex -- \x00 sentinels are deliberate placeholders
  text = text.replace(/(<\/(?:div|ul|ol|table)>|<hr class="md-hr"\/>|\x00CODE\d+\x00)\n+/g, "$1");
  // eslint-disable-next-line no-control-regex -- \x00 sentinels are deliberate placeholders
  text = text.replace(/\n+(?=<div class="md-|<ul class="md-|<ol class="md-|<hr class="md-|\x00CODE)/g, "");
  text = text.replace(/\n/g, "<br>");

  // 11. Restore protected blocks
  // eslint-disable-next-line no-control-regex -- \x00 sentinels are deliberate placeholders
  text = text.replace(/\x00CODE(\d+)\x00/g, (_m, i) => codeBlocks[+i]);
  // eslint-disable-next-line no-control-regex -- \x00 sentinels are deliberate placeholders
  text = text.replace(/\x00INLINE(\d+)\x00/g, (_m, i) => inlineCodes[+i]);

  return text.replace(PIPE, "|");
}
