# How it works

The side panel is a React view that mirrors an `AgentSession` living in the extension's background service worker, over a typed port (`src/shared/types.ts` is the protocol). Provider adapters implement the streaming model loop: the Anthropic SDK for Claude, the Responses API for OpenAI (Chat Completions refuses tools on its reasoning models unless reasoning is off), and an OpenAI-compatible Chat Completions client for OpenRouter, both streamed as server-sent events. Each is sent the reasoning effort chosen for the model, and only levels the model accepts (`src/shared/effort.ts`). `SnBridge` relays ServiceNow REST calls through a verified browser tab and the page-context helper (`public/inject.js`), which calls the Table and Aggregate APIs with the signed-in user's session token. Catalog helpers (`src/background/snCatalog.ts`) validate records before they are created and handle ServiceNow-specific catalog behavior. Every create and update is checked against the record ServiceNow returns: the Table API drops a value without an error when a field ACL makes it read-only, the table has no such field, or a business rule clears it, so a dropped value is reported to the model as `not_saved` rather than passed off as set. A catalog UI policy action is read back after it is created and deleted again unless it is linked to its policy with its variable set.

## Models

Model lists come from each provider's models API, fetched with the user's key and cached for 24 hours (the refresh button in the picker bypasses the cache; changing a key clears it). Nothing in the code names a model: until the user picks one, the first catalog loaded for a provider chooses its default — the newest Claude Sonnet, the newest flagship GPT (no mini, nano, pro or dated snapshot), or on OpenRouter a Claude Sonnet, else GPT, route — and keeps it as the user's choice. OpenRouter's list is narrowed to models that report tool support, since the agent works through tools.

## Instance selection

The instance menu in the header follows the ServiceNow tab you're viewing (**Auto**) until you pin an instance. Auto follows instances you never added in Settings too — they accept changes, each one approved, like any environment but Production — so the agent never quietly works on an instance other than the one on screen. Background tabs finishing a load cannot move the selection.

Each run stays on the instance selected when you sent the message, and uses the page you were looking at as its context, even if you switch tabs, windows, or the instance menu while it works; a new selection applies to the next message. Recovery never switches to another instance.

Before a run starts, the model is told the instance's environment and whether changes are allowed there, so it can explain instead of attempting a write that would be refused. Writes are refused regardless of what the model attempts, and the environment is re-read before every batch of writes, so marking an instance Production mid-run stops the rest, including one that wasn't added before. A run sent before any instance was selected belongs to the instance the bridge binds for it, from then on.

The host a context update belongs to is taken from the browser (the sender's URL), never from what the page reports. The page helper only relays calls to `/api/now/table/<table>[/<sys_id>]` and `/api/now/stats/<table>` on its own origin, and the background refuses malformed table names and record ids before building a request. Catalog calibration runs only on instances the user added and is used only for runs on that same instance.

## Runs and connection recovery

A run belongs to the extension's background worker, not to the side panel. You can close the panel, switch tabs, or work in another window; the run keeps working against its instance, and reopening the panel shows the same run, its progress, or its answer. Using the ServiceNow tab itself is fine too: in-page navigation (the classic content frame, History API and hash changes) does not count as a new page — the extension asks the tab which document it is running, and only a real reload, navigation away, discard or close invalidates it.

Before a request, the extension reuses a recently verified tab and page helper, otherwise it probes. It ignores XML/WSDL and discarded/frozen pages and considers other tabs on the same instance. If none works, it may open one background recovery tab without moving your focus or reloading existing pages; an existing recovery tab is reused across worker restarts, and closing it imposes a one-minute cooldown.

While a request is outstanding the tab is pinged every few seconds, so a read on a tab that stops responding moves to another tab on the same instance instead of waiting out its deadline. Reads retry at most twice, with backoff, within their deadline, and stop immediately when you press Stop. A read refused with 401 by one tab (a stale page token) is tried once on another tab of the same instance. Writes are resent only when the page provably never received them; after an uncertain result they are never replayed — the trace marks them "outcome unknown" and the model is told to verify. Form operations never move to another tab or document.

The readiness dot is green when the browser helper answers; that does not verify API permissions. The header stays quiet unless something needs you: **Sign-in required** (with a Sign in link), **No ServiceNow tab** (with an Open link), a refresh request for an outdated helper, or **Reconnecting…**. Details are in the instance control's tooltip, accessible name and menu. Health checks run every 15 seconds only while a panel is connected, never underneath a running run, and after a sign-in problem they re-verify with one small read so the state clears once you sign in.

Chrome can still stop the background worker. Runs are checkpointed as they go (the request, each completed step, streamed text about once a second, and a marker around every write; a write whose marker can't be saved is not sent), so a restart is reported instead of silently dropped: the run is marked interrupted, a step that was running shows "outcome unknown", and **Resume** continues from the last completed step on the run's original instance. A resumed run asks for approval again before any write and refuses to repeat a write whose outcome is unknown, however many times it is resumed. The same **Resume** is offered when a run pauses because every ServiceNow call needed sign-in, no tab on the instance answered, or the AI provider failed (rate limit, rejected key, network). Execution cannot continue while the browser is closed or the computer sleeps; those runs stop and can be resumed afterwards.

## Diagnostics

`chrome.storage.session` holds two bounded (100-entry) buffers, useful when debugging:

- `snConnectionDiagnostics` records relay events — probes, in-page navigation kept (`document_kept`), real document changes, unloads, liveness failures and retries — with tab/window identifiers and lifecycle flags.
- `copilotRunDiagnostics` records run events — worker start (and whether a previous worker left a run running), panel attach/detach and whether a run continued, run start/resume/end, and ServiceNow or provider failure kinds.

Together they tell a closed panel from a terminated worker, a relay failure, an expired session, or a provider failure. Neither contains record bodies, prompts, URL query strings, cookies, tokens, or request payloads; both are session-local and never sent anywhere.

Inspect them from the service worker's DevTools console (`chrome://extensions` → the extension → *service worker*):

```js
await chrome.storage.session.get(["snConnectionDiagnostics", "copilotRunDiagnostics"]);
```

## Storage

| Key (`chrome.storage.local`) | Contents |
| --- | --- |
| `provider`, `providerModels`, `providerKeys` | The provider in use, the chosen model per provider, and API keys. |
| `snInstances`, `activeInstanceId`, `chatPinnedInstanceId` | Your instances with their environments, the last selection, and the pin. |
| `modelCatalog` | Cached model lists, per provider. |
| `copilotFeed`, `copilotHistory_v2`, `copilotRun`, `copilotCost` | The current conversation (redacted), its model-facing history, the current run's checkpoint, and token/cost counters. |
| `copilotSessions` | Up to 30 archived conversations for History, each with its token and cost totals (view-only; never sent to a model). |
| `calibration`, `catalogContext` | Auto-discovered catalog variable types and categories for the last added instance calibrated, and the catalog item being built. |
| `theme`, `textSize`, `navPinned` | Appearance. |

`chrome.storage.session` additionally keeps the last ServiceNow host you viewed (so Auto survives a worker restart), recovery-tab bookkeeping and the diagnostics above. Removing the extension removes all of it.
