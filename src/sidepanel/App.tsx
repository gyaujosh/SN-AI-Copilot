import React, { useState } from "react";
import { ArrowDown, ArrowRight, Bug, ExternalLink, FileText, KeyRound, Users, Workflow } from "lucide-react";
import { ThemeProvider } from "./theme/ThemeContext";
import { useAgent, type AgentApi } from "./hooks/useAgent";
import { useFileAttachment } from "./hooks/useFileAttachment";
import { useSmartScroll } from "./hooks/useSmartScroll";
import { useFindInFeed } from "./hooks/useFindInFeed";
import { TopBar } from "./components/TopBar";
import { Composer } from "./components/Composer";
import { FindBar } from "./components/FindBar";
import { HistoryPanel } from "./components/HistoryPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { BottomNav, type View } from "./components/BottomNav";
import { shownTarget, targetName } from "./components/InstancePicker";
import { FeedEntry, Working } from "./components/Feed";

const STARTERS = [
  { icon: Workflow, title: "Explain a flow", prompt: "Summarize what this workflow / flow does, step by step" },
  { icon: Bug, title: "Find why a record misbehaves", prompt: "Help me find why this record isn't behaving as expected" },
  { icon: Users, title: "Create an assignment group", prompt: "Create an assignment group and add members to it" },
  { icon: FileText, title: "Explain the record I'm on", prompt: "Explain the record I'm looking at" },
];

export default function App() {
  return <AppView agent={useAgent()} />;
}

/** The real panel, also used by the isolated visual preview. */
export function AppView({ agent, initialView = "chat", initialSection = null }: { agent: AgentApi; initialView?: View; initialSection?: string | null }) {
  return (
    <ThemeProvider>
      <Panel agent={agent} initialView={initialView} initialSection={initialSection} />
    </ThemeProvider>
  );
}

function Panel({ agent, initialView, initialSection }: { agent: AgentApi; initialView: View; initialSection: string | null }) {
  const files = useFileAttachment();
  const [view, setView] = useState<View>(initialView);
  const [settingsSection, setSettingsSection] = useState<string | null>(initialSection);

  function openSettings(section: string | null = null) {
    setSettingsSection(section);
    setView("settings");
  }

  const scroll = useSmartScroll([agent.feed]);
  const find = useFindInFeed(scroll.containerRef, agent.feed, view === "chat");

  function submit(text: string) {
    const attached = [...files.attachedFiles];
    files.clearFiles();
    agent.sendChat(text, attached.length ? attached : undefined);
    scroll.scrollToBottom(false);
  }

  const provider = agent.settings.provider;
  const hasKey = agent.settings.keysPresent[provider];
  const shown = shownTarget(agent, agent.settings, agent.ctx);

  const lastItem = agent.feed[agent.feed.length - 1];
  const showWorking =
    agent.running &&
    lastItem &&
    !(lastItem.kind === "assistant" && lastItem.streaming) &&
    !(lastItem.kind === "approval" && lastItem.status === "pending");

  // Resume is offered on the notice of the latest run only, while it can resume.
  const resumeFor = (runId?: string) =>
    runId && agent.run?.id === runId && agent.run.resumable && !agent.running ? () => agent.resume(runId) : undefined;

  return (
    <div className="app-shell">
      <div className="app-main">
        <div className="chat-surface" style={{ visibility: view !== "chat" ? "hidden" : undefined }} aria-hidden={view !== "chat"}>
          <TopBar
            ctx={agent.ctx}
            catalog={agent.catalog}
            settings={agent.settings}
            agent={agent}
            onClearCatalog={agent.clearCatalog}
            onNewChat={agent.clear}
            onManageInstances={() => openSettings("instances")}
          />

          <div className="console-wrap">
            <FindBar find={find} />

            <div className="console-scroll" ref={scroll.containerRef} onScroll={scroll.onScroll}>
              {!hasKey && (
                <button type="button" className="setup-banner" onClick={() => openSettings("keys")}>
                  <KeyRound size={16} aria-hidden="true" />
                  <span>
                    <strong>Connect an AI provider</strong>
                    Add an API key for Claude, OpenAI or OpenRouter in Settings to start chatting.
                  </span>
                </button>
              )}

              {agent.feed.length === 0 ? (
                <div className="ask-start">
                  <h1 className="ask-hello">Ask about the page you&apos;re on.</h1>
                  {!agent.ctx?.instance && (shown.host ? (
                    <p className="ask-status">
                      No {targetName(shown)} tab is open.
                      <button type="button" className="btn-line btn-small" title={shown.host} onClick={() => agent.openHostTab(shown.host!)}>
                        <ExternalLink size={13} aria-hidden="true" /> Open {targetName(shown)}
                      </button>
                    </p>
                  ) : (
                    <p className="ask-status">Open a ServiceNow tab and I&apos;ll work with the page you&apos;re on.</p>
                  ))}
                  <div className="ask-starters">
                    {STARTERS.map(({ icon: Icon, title, prompt }) => (
                      <button type="button" key={title} className="ask-starter" onClick={() => submit(prompt)}>
                        <Icon size={17} aria-hidden="true" />
                        <span>{title}</span>
                        <ArrowRight size={15} className="ask-starter-arrow" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="console-feed">
                  {agent.feed.map((item) => (
                    <FeedEntry key={item.id} item={item} onDecide={agent.approve} resumeFor={resumeFor} />
                  ))}
                  {showWorking && <Working />}
                </div>
              )}
            </div>

            {!scroll.atBottom && (
              <button
                type="button"
                className={`jump-bottom ${scroll.hasNew && agent.running ? "jump-bottom-live" : ""}`}
                onClick={() => scroll.scrollToBottom()}
              >
                <ArrowDown size={14} aria-hidden="true" />
                {scroll.hasNew && agent.running ? "New output" : "Latest"}
              </button>
            )}
          </div>

          <Composer
            onSubmit={submit}
            running={agent.running}
            onStop={agent.stop}
            files={files.attachedFiles}
            onAttach={files.attachFiles}
            onRemoveFile={files.removeFile}
            onPasteImage={files.pasteImage}
            optimizing={files.optimizing}
            fileErrors={files.errors}
            settings={agent.settings}
            agent={agent}
            hasConversation={agent.feed.length > 0}
            onAddKey={() => openSettings("keys")}
          />
        </div>
        <HistoryPanel open={view === "history"} onClose={() => setView("chat")} agent={agent} />
        <SettingsPanel open={view === "settings"} section={settingsSection} onClose={() => setView("chat")} agent={agent} />
      </div>
      <BottomNav
        view={view}
        onNavigate={(next) => {
          if (next === "settings" && view !== "settings") setSettingsSection(null);
          setView(next);
        }}
      />
    </div>
  );
}
