import { useState, useRef, useCallback } from "react";
import type { PlanFile } from "../../shared/types";
import { admit } from "../../shared/imagePolicy";
import { optimizeImage, renameForType } from "../lib/optimizeImage";

/** Spreadsheets are unpacked whole in the panel before their text is cut, so
 * a very large (or deliberately inflated) workbook could freeze it. */
export const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024;

/** Text and spreadsheet attachments — images take the optimizing path instead. */
async function readTextish(f: File): Promise<PlanFile | null> {
  return new Promise((resolve) => {
    const r = new FileReader();
    const isExcel =
      f.name.endsWith(".xlsx") ||
      f.name.endsWith(".xls") ||
      f.type.includes("spreadsheet") ||
      f.type.includes("excel") ||
      f.type.includes("ms-excel");
    if (isExcel && f.size > MAX_SPREADSHEET_BYTES) {
      const MB = 1024 * 1024;
      resolve({ name: f.name, type: "text/plain", content: `[Spreadsheet not read: it is ${(f.size / MB).toFixed(1)} MB, and the limit is ${MAX_SPREADSHEET_BYTES / MB} MB]`, isImage: false });
      return;
    }
    r.onload = () => {
      try {
        if (isExcel) {
          try {
            const XLSX = (window as unknown as Record<string, unknown>).XLSX as {
              read: (d: unknown, o: unknown) => { SheetNames: string[]; Sheets: Record<string, unknown> };
              utils: {
                sheet_to_csv: (s: unknown, o: unknown) => string;
                sheet_to_json: (s: unknown, o: unknown) => unknown[];
              };
            };
            const wb = XLSX.read(r.result, { type: "array" });
            let text = wb.SheetNames.map(
              (n) => {
                const json = XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: "" });
                if (!json || (json as unknown[]).length === 0) return "";
                return `=== Sheet: ${n} ===\n${JSON.stringify(json, null, 2)}`;
              }
            )
              .filter((s) => s.trim())
              .join("\n\n");
            if (text.length > 100000) text = text.substring(0, 100000) + "\n[truncated]";
            resolve({ name: f.name, type: "text/plain", content: text, isImage: false });
          } catch {
            resolve({ name: f.name, type: "text/plain", content: "[Failed to parse Excel]", isImage: false });
          }
        } else {
          let t = String(r.result ?? "");
          if (t.length > 100000) t = t.substring(0, 100000) + "\n[truncated]";
          resolve({ name: f.name, type: f.type || "text/plain", content: t, isImage: false });
        }
      } catch {
        resolve(null);
      }
    };
    r.onerror = () => resolve(null);
    if (isExcel) r.readAsArrayBuffer(f);
    else r.readAsText(f);
  });
}

function budgetShape(f: PlanFile) {
  return { name: f.name, bytes: f.bytes ?? 0, file: f };
}

export function useFileAttachment() {
  const [attachedFiles, setAttachedFiles] = useState<PlanFile[]>([]);
  const [optimizing, setOptimizing] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastPasteRef = useRef(0);
  // Mirrors the state so the budget can be measured against what is already
  // attached without waiting for a re-render — two pastes in quick succession
  // must not both think they are the first.
  const filesRef = useRef<PlanFile[]>([]);
  // Counted, not a boolean: a paste that finishes first must not report "done"
  // while a drop of ten images is still encoding.
  const pendingRef = useRef(0);

  const startWork = useCallback(() => {
    pendingRef.current++;
    setOptimizing(true);
  }, []);
  const endWork = useCallback(() => {
    pendingRef.current = Math.max(0, pendingRef.current - 1);
    if (pendingRef.current === 0) setOptimizing(false);
  }, []);

  const apply = useCallback((next: PlanFile[]) => {
    filesRef.current = next;
    setAttachedFiles(next);
  }, []);

  /** Fit new images into what's left of the per-message budget, keep the rest. */
  const admitImages = useCallback(
    (incomingImages: PlanFile[], others: PlanFile[], problems: string[]) => {
      const existing = filesRef.current.filter((f) => f.isImage).map((f) => ({ name: f.name, bytes: f.bytes ?? 0 }));
      const { accepted, rejected } = admit(existing, incomingImages.map(budgetShape));
      apply([...filesRef.current, ...others, ...accepted.map((a) => a.file)]);
      setErrors([...problems, ...rejected.map((r) => `${r.name} ${r.reason}`)]);
    },
    [apply]
  );

  const attachFiles = useCallback(
    async (fl: FileList) => {
      setErrors([]);
      startWork();
      try {
        const results = await Promise.all(
          Array.from(fl).map(async (f) => {
            if (!f.type.startsWith("image/")) return { file: await readTextish(f) };
            const outcome = await optimizeImage(f);
            return outcome.ok === true ? { file: outcome.file } : { error: `${outcome.name} ${outcome.reason}` };
          })
        );
        const problems = results.flatMap((r) => ("error" in r && r.error ? [r.error] : []));
        const ok = results.flatMap((r) => ("file" in r && r.file ? [r.file] : []));
        admitImages(
          ok.filter((f) => f.isImage),
          ok.filter((f) => !f.isImage),
          problems
        );
      } finally {
        endWork();
      }
    },
    [admitImages, startWork, endWork]
  );

  const removeFile = useCallback(
    (idx: number) => {
      apply(filesRef.current.filter((_, j) => j !== idx));
    },
    [apply]
  );

  const clearFiles = useCallback(() => {
    apply([]);
    setErrors([]);
  }, [apply]);

  const pasteImage = useCallback(
    async (file: File) => {
      const now = Date.now();
      if (now - lastPasteRef.current < 500) {
        // The window exists to eat double-fired paste events, but a real
        // second image must not vanish without a word.
        setErrors(["Pasted image ignored — too soon after the last one. Paste it again."]);
        return;
      }
      lastPasteRef.current = now;
      setErrors([]);
      startWork();
      try {
        const outcome = await optimizeImage(file);
        if (outcome.ok === false) {
          setErrors([`${outcome.name || "Pasted image"} ${outcome.reason}`]);
          return;
        }
        // Pasted files arrive unnamed or all called "image.png"; the extension
        // still has to match whatever encoding came out the other side.
        const named = { ...outcome.file, name: renameForType(`screenshot-${now}`, outcome.type) };
        admitImages([named], [], []);
      } finally {
        endWork();
      }
    },
    [admitImages, startWork, endWork]
  );

  return { attachedFiles, fileRef, attachFiles, removeFile, clearFiles, pasteImage, optimizing, errors };
}
