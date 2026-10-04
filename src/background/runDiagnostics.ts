// Run-lifecycle diagnostics. They answer one question after the fact: when a
// run stopped, was it the panel closing, the worker being terminated, the
// ServiceNow relay, an expired session, or the AI provider?
//
// Session-local (chrome.storage.session), bounded, and metadata only: event
// names, run ids and failure kinds — never prompts, record data, URLs, keys or
// tokens. Nothing here is sent to a provider.

export type RunDiagnosticEvent =
  | "worker_start"        // detail: "run_left_running" when a previous worker died mid-run
  | "panel_attach"
  | "panel_detach"        // running: whether a run continued without a viewer
  | "run_start"
  | "run_resume"
  | "run_end"             // detail: final status or failure kind
  | "run_interrupted"     // detail: RunFailureKind
  | "provider_failure"    // detail: RunFailureKind
  | "servicenow_failure"; // detail: ConnectionFailure

export interface RunDiagnostic {
  at: number;
  event: RunDiagnosticEvent;
  runId?: string;
  detail?: string;
  running?: boolean;
}

export const RUN_DIAGNOSTICS_KEY = "copilotRunDiagnostics";
const LIMIT = 100;
let buffer: RunDiagnostic[] | null = null;
let queue: Promise<void> = Promise.resolve();

export function recordRunEvent(event: RunDiagnosticEvent, fields: Omit<RunDiagnostic, "at" | "event"> = {}): Promise<void> {
  queue = queue.then(async () => {
    if (!buffer) {
      const stored = (await chrome.storage.session.get(RUN_DIAGNOSTICS_KEY))[RUN_DIAGNOSTICS_KEY];
      buffer = Array.isArray(stored) ? stored : [];
    }
    buffer.push({ at: Date.now(), event, ...fields });
    buffer = buffer.slice(-LIMIT);
    await chrome.storage.session.set({ [RUN_DIAGNOSTICS_KEY]: buffer });
  }).catch(() => {});
  return queue;
}
