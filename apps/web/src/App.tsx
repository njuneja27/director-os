import { useEffect, useMemo, useState, type ReactNode } from "react";

import type {
  ConversationMessageRecord,
  ConversationResponse,
  DirectorStatusResponse,
  PrCycleRecord,
  RunRecord,
  SetupCheck,
  WorkItemRecord,
  SetupRepositoryDraft,
  SetupStatusResponse
} from "./api";
import {
  completeSetup,
  fetchSetupStatus,
  fetchConversation,
  fetchStatus,
  pauseDirector,
  probeRepository,
  runWorkspaceTest,
  sendMessage,
  startDirector,
  syncNow
} from "./api";

type SetupStep = "landing" | "repository" | "readiness" | "complete";
type SetupIntent = "fresh" | "repair";

export function App() {
  const [shellMode, setShellMode] = useState<"setup" | "app">("setup");
  const [setupStep, setSetupStep] = useState<SetupStep>("landing");
  const [setupIntent, setSetupIntent] = useState<SetupIntent>("fresh");
  const [setupStatus, setSetupStatus] = useState<SetupStatusResponse | null>(null);
  const [status, setStatus] = useState<DirectorStatusResponse | null>(null);
  const [conversation, setConversation] = useState<ConversationResponse | null>(null);
  const [repositoryPath, setRepositoryPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [worktreeRoot, setWorktreeRoot] = useState("");
  const [modelName, setModelName] = useState("");
  const [messageInput, setMessageInput] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (shellMode !== "app") {
      return;
    }

    const interval = window.setInterval(() => {
      void refreshWorkspace();
    }, 5_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [shellMode]);

  const codexCheck = setupStatus?.checks.find((check) => check.kind === "codex") ?? null;
  const codexBadge = deriveEngineBadge(codexCheck, setupStatus?.completed ?? false);
  const showSetup = shellMode === "setup" || !setupStatus?.completed;
  const openQuestion = conversation?.openQuestion ?? null;
  const composerPlaceholder = openQuestion
    ? "Reply to the Chief of Staff..."
    : "Message the Chief of Staff about the next slice, blocker, or product call.";

  const counts = useMemo(
    () => ({
      queued: status?.queue.length ?? 0,
      active: status?.activeWork.length ?? 0,
      decisions: status?.decisions.length ?? 0,
      prs: status?.openPullRequests.length ?? 0
    }),
    [status]
  );

  async function bootstrap() {
    await refreshSetup();
  }

  async function refreshSetup(options?: { forceSetup?: boolean }) {
    try {
      setError(null);
      const nextSetupStatus = await fetchSetupStatus();
      setSetupStatus(nextSetupStatus);
      hydrateSetupDraft(nextSetupStatus.repositoryDraft);

      if (nextSetupStatus.completed && !options?.forceSetup) {
        setShellMode("app");
        setSetupStep("complete");
        setSetupIntent("repair");
        await refreshWorkspace();
        return;
      }

      setShellMode("setup");
      setSetupIntent(nextSetupStatus.activeProject ? "repair" : "fresh");
      setSetupStep(nextSetupStatus.repositoryDraft || nextSetupStatus.activeProject ? "readiness" : "landing");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setShellMode("setup");
      setSetupStep("landing");
      setSetupIntent("fresh");
    }
  }

  async function refreshWorkspace() {
    setError(null);

    const [statusResult, conversationResult] = await Promise.allSettled([fetchStatus(), fetchConversation()]);

    if (statusResult.status === "fulfilled") {
      setStatus(statusResult.value);
    } else {
      setError(statusResult.reason instanceof Error ? statusResult.reason.message : String(statusResult.reason));
    }

    if (conversationResult.status === "fulfilled") {
      setConversation(conversationResult.value);
      setConversationError(null);
    } else {
      setConversation(null);
      setConversationError(
        conversationResult.reason instanceof Error
          ? conversationResult.reason.message
          : String(conversationResult.reason)
      );
    }
  }

  function hydrateSetupDraft(draft: SetupRepositoryDraft | null) {
    if (!draft) {
      return;
    }

    setRepositoryPath(draft.repoPath ?? "");
    setProjectName(draft.projectName ?? "");
    setWorktreeRoot(draft.worktreeRoot ?? "");
    setModelName(draft.model ?? "");
  }

  async function runSetupAction(actionKey: string, runner: () => Promise<SetupStatusResponse>) {
    try {
      setBusyAction(actionKey);
      setError(null);
      const nextStatus = await runner();
      setSetupStatus(nextStatus);
      hydrateSetupDraft(nextStatus.repositoryDraft);
      if (nextStatus.completed) {
        setSetupStep("complete");
      } else if (nextStatus.repositoryDraft) {
        setSetupStep("readiness");
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyAction(null);
    }
  }

  async function runDashboardAction(actionKey: string, runner: () => Promise<unknown>) {
    try {
      setBusyAction(actionKey);
      setError(null);
      await runner();
      await refreshWorkspace();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyAction(null);
    }
  }

  async function beginSetup() {
    setSetupIntent(setupStatus?.activeProject ? "repair" : "fresh");
    setSetupStep("repository");
  }

  async function probeSetupRepository() {
    await runSetupAction("setup-probe-repository", async () => {
      const nextStatus = await probeRepository({
        repoPath: repositoryPath.trim(),
        projectName: projectName.trim() || undefined,
        worktreeRoot: worktreeRoot.trim() || undefined,
        model: modelName.trim() || undefined
      });
      setSetupStep("readiness");
      return nextStatus;
    });
  }

  async function runSetupWorkspaceTest() {
    if (!setupStatus?.repositoryDraft) {
      setError("Probe the repository before running the workspace test.");
      return;
    }

    await runSetupAction("setup-workspace-test", async () =>
      runWorkspaceTest(setupStatus.repositoryDraft as SetupRepositoryDraft)
    );
  }

  async function completeDesktopSetup() {
    if (!setupStatus?.repositoryDraft) {
      setError("Probe the repository before completing setup.");
      return;
    }

    await runSetupAction("setup-complete", async () => {
      const nextStatus = await completeSetup(setupStatus.repositoryDraft as SetupRepositoryDraft);
      setShellMode("app");
      await refreshWorkspace();
      return nextStatus;
    });
  }

  async function openRepairSetup() {
    setShellMode("setup");
    setSetupIntent("repair");
    setSetupStep(setupStatus?.repositoryDraft ? "readiness" : "repository");
    await refreshSetup({ forceSetup: true });
  }

  async function handleSendMessage() {
    const message = messageInput.trim();
    if (!message) {
      setError("Message the Chief of Staff first.");
      return;
    }

    await runDashboardAction("send-message", async () => {
      const nextConversation = await sendMessage(message);
      setConversation(nextConversation);
      setMessageInput("");
      await refreshWorkspace();
    });
  }

  if (showSetup) {
    return (
      <div className="app-shell">
        <SetupWorkspace
          busyAction={busyAction}
          codexBadge={codexBadge}
          error={error}
          intent={setupIntent}
          modelName={modelName}
          onBeginSetup={() => void beginSetup()}
          onCompleteSetup={() => void completeDesktopSetup()}
          onModelNameChange={setModelName}
          onProbeRepository={() => void probeSetupRepository()}
          onProjectNameChange={setProjectName}
          onRefresh={() => void refreshSetup({ forceSetup: true })}
          onRepositoryPathChange={setRepositoryPath}
          onRunWorkspaceTest={() => void runSetupWorkspaceTest()}
          projectName={projectName}
          repositoryPath={repositoryPath}
          setupStatus={setupStatus}
          setupStep={setupStep}
          worktreeRoot={worktreeRoot}
          onWorktreeRootChange={setWorktreeRoot}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">D</div>
          <div>
            <div className="brand-name">Director OS</div>
            <div className="brand-meta">
              {status?.project?.name ?? "Director OS"} • {status?.project?.repoSlug ?? "No repo connected"}
            </div>
          </div>
        </div>
        <div className="header-actions">
          <button
            className="action-button action-button-secondary"
            disabled={busyAction === "sync"}
            onClick={() => void runDashboardAction("sync", () => syncNow())}
          >
            Sync GitHub
          </button>
          {status?.orchestrator?.status === "running" ? (
            <button
              className="action-button action-button-danger"
              disabled={busyAction === "pause"}
              onClick={() => void runDashboardAction("pause", () => pauseDirector())}
            >
              Pause
            </button>
          ) : (
            <button
              className="action-button action-button-primary"
              disabled={busyAction === "start"}
              onClick={() => void runDashboardAction("start", () => startDirector())}
            >
              Start
            </button>
          )}
          <button className={`engine-badge ${codexBadge.className}`} onClick={() => void openRepairSetup()}>
            {codexBadge.label}
          </button>
        </div>
      </header>

      <main className="page-shell workspace-grid">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {conversationError ? <Banner tone="warning">{conversationError}</Banner> : null}

        <section className="panel conversation-panel">
          <div className="panel-header">
            <div>
              <div className="eyebrow">Chief of Staff chat</div>
              <div className="section-title">One project thread, one place to answer the CoS.</div>
              <div className="section-meta">
                Workers ask here first. The CoS only escalates to you when there is a real product decision.
              </div>
            </div>
            <div className="conversation-header-meta">
              <StatusPill status={status?.orchestrator?.status ?? "idle"} />
              <span>{conversation?.thread?.status ?? "active thread"}</span>
            </div>
          </div>

          {openQuestion ? (
            <div className="open-question-card">
              <div className="eyebrow">Reply needed</div>
              <div className="open-question-title">{openQuestion.summary ?? "Chief of Staff question"}</div>
              <p className="open-question-copy">{openQuestion.content}</p>
              <div className="open-question-meta">
                {openQuestion.linkedIssueNumber ? <span>Issue #{openQuestion.linkedIssueNumber}</span> : null}
                {openQuestion.linkedPrNumber ? <span>PR #{openQuestion.linkedPrNumber}</span> : null}
                <span>{formatTimestamp(openQuestion.createdAt)}</span>
              </div>
            </div>
          ) : null}

          <div className="conversation-stream">
            {conversation?.messages?.length ? (
              conversation.messages.map((message) => (
                <ConversationBubble key={message.id} message={message} />
              ))
            ) : (
              <div className="empty-state conversation-empty">
                Say what you want the Chief of Staff to steer next. The project thread will grow from there.
              </div>
            )}
          </div>

          <div className="composer-card">
            <div className="composer-head">
              <div>
                <div className="section-title">Message the Chief of Staff</div>
                <div className="section-meta">
                  {openQuestion
                    ? "Reply here to unblock the current question."
                    : "Send a new direction, clarification, or boundary in plain language."}
                </div>
              </div>
              <span className={`check-pill ${openQuestion ? "check-pill-needs-action" : "check-pill-ready"}`}>
                {openQuestion ? "Reply needed" : "Open thread"}
              </span>
            </div>
            <textarea
              className="text-field text-area composer-input"
              value={messageInput}
              onChange={(event) => setMessageInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSendMessage();
                }
              }}
              placeholder={composerPlaceholder}
            />
            <div className="composer-actions">
              <button
                className="action-button action-button-primary"
                disabled={busyAction === "send-message" || !messageInput.trim()}
                onClick={() => void handleSendMessage()}
              >
                Send to CoS
              </button>
              <button
                className="action-button action-button-secondary"
                disabled={!messageInput.trim()}
                onClick={() => setMessageInput("")}
              >
                Clear
              </button>
            </div>
          </div>
        </section>

        <aside className="sidebar-column">
          <section className="panel sidebar-card">
            <div className="panel-header">
              <div>
                <div className="section-title">Current stance</div>
                <div className="section-meta">{status?.orchestrator?.lastSummary ?? "The control room is ready."}</div>
              </div>
            </div>
            <div className="hero-stats sidebar-stats">
              <StatCard label="Queue" value={String(counts.queued)} />
              <StatCard label="Active" value={String(counts.active)} />
              <StatCard label="Escalations" value={String(counts.decisions)} />
              <StatCard label="Open PRs" value={String(counts.prs)} />
            </div>
            <div className="hero-meta">
              <span className={`status-pill status-pill-${(status?.orchestrator?.status ?? "idle").replace("_", "-")}`}>
                {status?.orchestrator?.status ?? "idle"}
              </span>
              <span>The Chief of Staff loop stays local and synchronized with GitHub.</span>
            </div>
          </section>

          <section className="panel sidebar-card">
            <div className="panel-header">
              <div>
                <div className="section-title">Open escalations</div>
                <div className="section-meta">Read-only view of the questions the CoS still wants resolved.</div>
              </div>
            </div>
            <ItemList<DirectorStatusResponse["decisions"][number]>
              empty="No human escalations are waiting right now."
              items={status?.decisions ?? []}
              render={(decision) => (
                <div className="compact-card" key={decision.id}>
                  <div className="compact-card-head">
                    <div className="list-title">{decision.title}</div>
                    <span className="check-pill check-pill-needs-action">{decision.target.replace("_", " ")}</span>
                  </div>
                  <div className="compact-card-meta">
                    {decision.issueNumber ? <span>Issue #{decision.issueNumber}</span> : null}
                    {decision.prNumber ? <span>PR #{decision.prNumber}</span> : null}
                  </div>
                  <div className="list-note">{decision.summary}</div>
                </div>
              )}
            />
          </section>

          <section className="panel sidebar-card">
            <div className="panel-header">
              <div>
                <div className="section-title">Queued work</div>
                <div className="section-meta">GitHub remains the durable backlog behind the chat.</div>
              </div>
            </div>
            <ItemList<WorkItemRecord>
              empty="No queueable work yet."
              items={status?.queue ?? []}
              render={(item) => (
                <div className="list-row compact-list-row" key={item.id}>
                  <div>
                    <div className="list-title">#{item.issueNumber} {item.title}</div>
                    <div className="list-meta">
                      <span>{item.executionMode}</span>
                      <span>{item.kind}</span>
                      <span>{item.status}</span>
                    </div>
                  </div>
                  <div className="list-note">{item.lastSummary ?? item.summary}</div>
                </div>
              )}
            />
          </section>

          <section className="panel sidebar-card">
            <div className="panel-header">
              <div>
                <div className="section-title">Active slices</div>
                <div className="section-meta">In-flight lane, worker, review, and PR watch runs.</div>
              </div>
            </div>
            <ItemList<WorkItemRecord>
              empty="Nothing is active right now."
              items={status?.activeWork ?? []}
              render={(item) => (
                <div className="list-row compact-list-row" key={item.id}>
                  <div>
                    <div className="list-title">#{item.issueNumber} {item.title}</div>
                    <div className="list-meta">
                      <span>{item.executionMode}</span>
                      <span>{item.status}</span>
                      {item.activePrNumber ? <span>PR #{item.activePrNumber}</span> : null}
                    </div>
                  </div>
                  <div className="list-note">{item.lastSummary ?? item.summary}</div>
                </div>
              )}
            />
          </section>

          <section className="panel sidebar-card">
            <div className="panel-header">
              <div>
                <div className="section-title">PR cycles</div>
                <div className="section-meta">Automation waits, review follow-up, and merge readiness.</div>
              </div>
            </div>
            <ItemList<PrCycleRecord>
              empty="No open PR cycles yet."
              items={status?.prCycles ?? []}
              render={(cycle) => (
                <div className="list-row compact-list-row" key={cycle.id}>
                  <div>
                    <div className="list-title">PR #{cycle.prNumber} for issue #{cycle.issueNumber}</div>
                    <div className="list-meta">
                      <span>{cycle.status}</span>
                      {cycle.automationWindowEndsAt ? <span>Window ends {formatTimestamp(cycle.automationWindowEndsAt)}</span> : null}
                    </div>
                  </div>
                  <div className="list-note">{cycle.summary}</div>
                </div>
              )}
            />
          </section>

          <section className="panel sidebar-card">
            <div className="panel-header">
              <div>
                <div className="section-title">Recent runs</div>
                <div className="section-meta">Chief of Staff, lane, worker, and review runs.</div>
              </div>
            </div>
            <ItemList<RunRecord>
              empty="No runs recorded yet."
              items={status?.recentRuns ?? []}
              render={(run) => (
                <div className="list-row compact-list-row" key={run.id}>
                  <div>
                    <div className="list-title">{run.role} • {run.phase}</div>
                    <div className="list-meta">
                      <span>{run.status}</span>
                      {run.issueNumber ? <span>Issue #{run.issueNumber}</span> : null}
                      {run.prNumber ? <span>PR #{run.prNumber}</span> : null}
                    </div>
                  </div>
                  <div className="list-note">{run.summary}</div>
                </div>
              )}
            />
          </section>
        </aside>
      </main>
    </div>
  );
}

function SetupWorkspace(props: {
  busyAction: string | null;
  codexBadge: { label: string; className: string };
  error: string | null;
  intent: SetupIntent;
  modelName: string;
  onBeginSetup: () => void;
  onCompleteSetup: () => void;
  onModelNameChange: (value: string) => void;
  onProbeRepository: () => void;
  onProjectNameChange: (value: string) => void;
  onRefresh: () => void;
  onRepositoryPathChange: (value: string) => void;
  onRunWorkspaceTest: () => void;
  onWorktreeRootChange: (value: string) => void;
  projectName: string;
  repositoryPath: string;
  setupStatus: SetupStatusResponse | null;
  setupStep: SetupStep;
  worktreeRoot: string;
}) {
  const repositoryCheck = props.setupStatus?.checks.find((check) => check.kind === "repository") ?? null;
  const canOpenWorkspace = props.setupStatus?.completed;

  return (
    <div className="setup-shell">
      <header className="topbar setup-topbar">
        <div className="brand-block">
          <div className="brand-mark">D</div>
          <div>
            <div className="brand-name">Director OS</div>
            <div className="brand-meta">
              {props.intent === "repair"
                ? "Repair the local machine before the control room resumes."
                : "Desktop onboarding for the local machine."}
            </div>
          </div>
        </div>
        <button className={`engine-badge ${props.codexBadge.className}`} onClick={props.onRefresh}>
          {props.codexBadge.label}
        </button>
      </header>

      {props.error ? <Banner tone="danger">{props.error}</Banner> : null}

      <div className="setup-grid">
        <section className="panel setup-hero">
          <div className="eyebrow">Local-first desktop shell</div>
          <h1 className="hero-title">Bring Director OS online on this computer.</h1>
          <p className="hero-copy">
            Director OS stays local. It checks the repository, GitHub CLI, Codex CLI, and a safe
            workspace test before the control room appears.
          </p>
          <div className="step-stack">
            <SetupStepCard index={1} title="Landing" body="Start the setup conversation." active={props.setupStep === "landing"} />
            <SetupStepCard index={2} title="Repository" body="Point Director OS at an absolute repo path." active={props.setupStep === "repository"} />
            <SetupStepCard index={3} title="Readiness" body="Confirm GitHub, Codex, and the workspace." active={props.setupStep === "readiness"} />
            <SetupStepCard index={4} title="Complete" body="Open the director workspace." active={props.setupStep === "complete"} />
          </div>
          {props.setupStep === "landing" ? (
            <button className="action-button action-button-primary" onClick={props.onBeginSetup}>
              Begin setup
            </button>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <div className="section-title">Repository</div>
              <div className="section-meta">
                {repositoryCheck?.detail ?? "Check the repository before Director OS opens the workspace."}
              </div>
            </div>
          </div>
          <div className="field-grid">
            <label className="field">
              <span>Repository path</span>
              <input
                className="text-field"
                value={props.repositoryPath}
                onChange={(event) => props.onRepositoryPathChange(event.target.value)}
                placeholder="~/Documents/Experiments/director-os"
              />
            </label>
            <label className="field">
              <span>Project name</span>
              <input
                className="text-field"
                value={props.projectName}
                onChange={(event) => props.onProjectNameChange(event.target.value)}
                placeholder="Director OS"
              />
            </label>
            <label className="field">
              <span>Worktree root</span>
              <input
                className="text-field"
                value={props.worktreeRoot}
                onChange={(event) => props.onWorktreeRootChange(event.target.value)}
                placeholder="Optional local worktree directory"
              />
            </label>
            <label className="field">
              <span>Model preset</span>
              <input
                className="text-field"
                value={props.modelName}
                onChange={(event) => props.onModelNameChange(event.target.value)}
                placeholder="Optional runner preset"
              />
            </label>
          </div>
          <div className="inline-actions">
            <button
              className="action-button action-button-primary"
              disabled={props.busyAction === "setup-probe-repository"}
              onClick={props.onProbeRepository}
            >
              Check repository
            </button>
            <button className="action-button action-button-secondary" onClick={props.onRefresh}>
              Refresh status
            </button>
          </div>
          <div className="readiness-block">
            <div className="section-title">Checking local setup</div>
            <p className="section-meta">
              Director OS loads the local status before it opens the workspace.
            </p>
            <div className="check-stack">
              {(props.setupStatus?.checks ?? []).map((check) => (
                <CheckRow check={check} key={check.kind} />
              ))}
            </div>
            <div className="inline-actions">
              <button
                className="action-button action-button-secondary"
                disabled={!props.setupStatus?.repositoryDraft || props.busyAction === "setup-workspace-test"}
                onClick={props.onRunWorkspaceTest}
              >
                Run local test
              </button>
              <button
                className="action-button action-button-primary"
                disabled={!props.setupStatus?.canComplete || props.busyAction === "setup-complete"}
                onClick={props.onCompleteSetup}
              >
                {canOpenWorkspace ? "Open Director Home" : "Complete setup"}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function CheckRow(props: { check: SetupCheck }) {
  return (
    <div className="check-row">
      <div className="check-head">
        <span className="check-title">{props.check.title}</span>
        <span className={`check-pill check-pill-${props.check.status.replace("_", "-")}`}>
          {props.check.status.replace("_", " ")}
        </span>
      </div>
      <div className="check-copy">{props.check.detail}</div>
      {props.check.recommendedAction ? (
        <div className="check-recommendation">{props.check.recommendedAction}</div>
      ) : null}
      {props.check.advancedDetail ? (
        <details className="advanced-detail">
          <summary>Advanced details</summary>
          <pre>{props.check.advancedDetail}</pre>
        </details>
      ) : null}
    </div>
  );
}

function SetupStepCard(props: {
  active: boolean;
  body: string;
  index: number;
  title: string;
}) {
  return (
    <div className={`step-card ${props.active ? "step-card-active" : ""}`}>
      <div className="step-index">{props.index}. {props.title}</div>
      <div className="step-body">{props.body}</div>
    </div>
  );
}

function StatusPill(props: { status: string }) {
  return <span className={`status-pill status-pill-${props.status.replace("_", "-")}`}>{props.status.replace("_", " ")}</span>;
}

function ConversationBubble(props: { message: ConversationMessageRecord }) {
  const toneClass =
    props.message.role === "director"
      ? "conversation-message-director"
      : props.message.role === "chief_of_staff"
        ? "conversation-message-cos"
        : "conversation-message-system";

  const kindLabel = props.message.kind.replace("_", " ");
  const roleLabel =
    props.message.role === "director"
      ? "Director"
      : props.message.role === "chief_of_staff"
        ? "Chief of Staff"
        : "System";

  return (
    <article className={`conversation-message ${toneClass} ${props.message.isOpenQuestion ? "conversation-message-open" : ""}`}>
      <div className="conversation-message-head">
        <div className="conversation-message-labels">
          <span className="conversation-role">{roleLabel}</span>
          <span className="conversation-kind">{kindLabel}</span>
          {props.message.isOpenQuestion ? <span className="conversation-open">Needs reply</span> : null}
        </div>
        <span className="conversation-time">{formatTimestamp(props.message.createdAt)}</span>
      </div>
      {props.message.summary ? <div className="conversation-summary">{props.message.summary}</div> : null}
      <p className="conversation-body">{props.message.content}</p>
      <div className="conversation-links">
        {props.message.linkedIssueNumber ? <span>Issue #{props.message.linkedIssueNumber}</span> : null}
        {props.message.linkedPrNumber ? <span>PR #{props.message.linkedPrNumber}</span> : null}
      </div>
    </article>
  );
}

function StatCard(props: { label: string; value: string }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{props.value}</div>
      <div className="stat-label">{props.label}</div>
    </div>
  );
}

function Banner(props: { children: string; tone: "danger" | "warning" }) {
  return <div className={`banner banner-${props.tone}`}>{props.children}</div>;
}

function ItemList<TItem>(props: {
  empty: string;
  items: TItem[];
  render: (item: TItem) => ReactNode;
}) {
  if (props.items.length === 0) {
    return <div className="empty-state">{props.empty}</div>;
  }

  return <div className="list-stack">{props.items.map(props.render)}</div>;
}

function deriveEngineBadge(
  check: SetupCheck | null,
  completed: boolean
): { className: string; label: string } {
  if (!check && !completed) {
    return {
      className: "engine-badge-neutral",
      label: "Setup pending"
    };
  }

  if (check?.status === "ready") {
    return {
      className: "engine-badge-ready",
      label: "Codex ready"
    };
  }

  if (check?.code === "codex_sign_in_required") {
    return {
      className: "engine-badge-warning",
      label: "Needs sign-in"
    };
  }

  if (check?.status === "blocked") {
    return {
      className: "engine-badge-danger",
      label: "Codex blocked"
    };
  }

  return {
    className: "engine-badge-neutral",
    label: completed ? "Codex unknown" : "Setup pending"
  };
}

function formatTimestamp(value: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(value));
  } catch {
    return value;
  }
}
