import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  ConversationMessageRecord,
  ConversationResponse,
  DirectorStatusResponse,
  HumanQuestionRecord,
  RunRecord,
  SetupCheck,
  SetupRepositoryDraft,
  SetupStatusResponse,
  UpdateProjectSettingsInput
} from "./api";
import {
  completeSetup,
  fetchSetupStatus,
  fetchConversation,
  fetchStatus,
  pauseDirector,
  probeRepository,
  resetRouterRuntime,
  runWorkspaceTest,
  sendMessage,
  startDirector,
  syncNow,
  updateProjectSettings as saveProjectSettings
} from "./api";
import { deriveSetupStateBadge, hasCompletedSetup } from "./setup-state";

type SetupStep = "landing" | "repository" | "readiness" | "complete";
type SetupIntent = "fresh" | "repair";

const RESET_RUNTIME_CLEARS = [
  "Lane ownership, pending handoffs, and lane review queues",
  "Open blocker or escalation runtime state",
  "Chief of Staff and lane Codex session routing",
  "Recent router run history and pause state"
];

const RESET_RUNTIME_KEEPS = [
  "Repo path, repo slug, base branch, worktree root, and model settings",
  "GitHub issues and pull requests mirrored into the local cache",
  "Repository contents and existing worktrees on disk"
];

export function App() {
  const [shellMode, setShellMode] = useState<"booting" | "setup" | "app">("booting");
  const [setupStep, setSetupStep] = useState<SetupStep>("landing");
  const [setupIntent, setSetupIntent] = useState<SetupIntent>("fresh");
  const [setupStatus, setSetupStatus] = useState<SetupStatusResponse | null>(null);
  const [status, setStatus] = useState<DirectorStatusResponse | null>(null);
  const [conversation, setConversation] = useState<ConversationResponse | null>(null);
  const [projectSettingsDraft, setProjectSettingsDraft] = useState<UpdateProjectSettingsInput | null>(null);
  const [editingProjectSettings, setEditingProjectSettings] = useState(false);
  const [repositoryPath, setRepositoryPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [worktreeRoot, setWorktreeRoot] = useState("");
  const [modelName, setModelName] = useState("");
  const [messageInput, setMessageInput] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setupRefreshSequence = useRef(0);

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

  const setupStateBadge = deriveSetupStateBadge(setupStatus);
  const canReturnToControlRoom = hasCompletedSetup(setupStatus);
  const showSetup = shellMode === "setup";
  const openQuestion = conversation?.openQuestion ?? null;
  const composerPlaceholder = openQuestion
    ? "Reply to the Chief of Staff..."
    : "Message the Chief of Staff about the next slice, blocker, or product call.";

  async function bootstrap() {
    await refreshSetup();
  }

  async function refreshSetup(options?: { forceSetup?: boolean }) {
    const refreshSequence = ++setupRefreshSequence.current;

    try {
      setError(null);
      const nextSetupStatus = await fetchSetupStatus();

      if (setupRefreshSequence.current !== refreshSequence) {
        return;
      }

      setSetupStatus(nextSetupStatus);
      hydrateSetupDraft(nextSetupStatus.repositoryDraft);

      if (hasCompletedSetup(nextSetupStatus) && !options?.forceSetup) {
        setShellMode("app");
        setSetupStep("complete");
        setSetupIntent("repair");
        await refreshWorkspace();
        return;
      }

      setShellMode("setup");
      setSetupIntent(hasCompletedSetup(nextSetupStatus) ? "repair" : "fresh");
      setSetupStep(
        nextSetupStatus.repositoryDraft || hasCompletedSetup(nextSetupStatus)
          ? "readiness"
          : "landing"
      );
    } catch (nextError) {
      if (setupRefreshSequence.current !== refreshSequence) {
        return;
      }

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
      if (!editingProjectSettings || !projectSettingsDraft) {
        hydrateProjectSettingsDraft(statusResult.value);
      }
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

  function hydrateProjectSettingsDraft(nextStatus: DirectorStatusResponse | null) {
    if (!nextStatus?.project) {
      return;
    }

    setProjectSettingsDraft({
      repoPath: nextStatus.project.repoPath,
      repoSlug: nextStatus.project.repoSlug,
      defaultBranch: nextStatus.project.defaultBranch,
      defaultBranchStrategy: nextStatus.projectConfigStatus?.defaultBranchStrategy ?? "repo_default",
      worktreeRoot: nextStatus.project.worktreeRoot,
      model: nextStatus.project.model
    });
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
      } else if (nextStatus.repositoryDraft || hasCompletedSetup(nextStatus)) {
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
    setSetupIntent(hasCompletedSetup(setupStatus) ? "repair" : "fresh");
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
    setSetupStep(setupStatus?.repositoryDraft || canReturnToControlRoom ? "readiness" : "repository");
    await refreshSetup({ forceSetup: true });
  }

  function returnToControlRoom() {
    if (!canReturnToControlRoom) {
      return;
    }

    setShellMode("app");
    void refreshWorkspace();
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

  async function handleResetRouterRuntime() {
    const confirmation = window.confirm(
      [
        "Reset local router runtime for the active project?",
        "",
        "This clears:",
        ...RESET_RUNTIME_CLEARS.map((item) => `- ${item}`),
        "",
        "This keeps:",
        ...RESET_RUNTIME_KEEPS.map((item) => `- ${item}`),
        "",
        "After reset, run Sync and then restart the Chief of Staff loop when ready."
      ].join("\n")
    );

    if (!confirmation) {
      return;
    }

    await runDashboardAction("reset-router-runtime", async () => resetRouterRuntime());
  }

  async function handleSaveProjectSettings() {
    if (!projectSettingsDraft) {
      setError("Project settings are not ready to save yet.");
      return;
    }

    await runDashboardAction("save-project-settings", async () => {
      const nextStatus = await saveProjectSettings(projectSettingsDraft);
      setStatus(nextStatus);
      hydrateProjectSettingsDraft(nextStatus);
      setEditingProjectSettings(false);
      await refreshWorkspace();
    });
  }

  async function handleHealBaseBranch() {
    if (!status?.project || !status.projectConfigStatus?.repoDefaultBranch) {
      setError("The local repo default branch is not available to recover from.");
      return;
    }

    const nextDraft: UpdateProjectSettingsInput = {
      repoPath: status.project.repoPath,
      repoSlug: status.project.repoSlug,
      defaultBranch: status.projectConfigStatus.repoDefaultBranch,
      defaultBranchStrategy: "repo_default",
      worktreeRoot: status.project.worktreeRoot,
      model: status.project.model
    };

    await runDashboardAction("heal-base-branch", async () => {
      const nextStatus = await saveProjectSettings(nextDraft);
      setStatus(nextStatus);
      hydrateProjectSettingsDraft(nextStatus);
      setEditingProjectSettings(false);
      await refreshWorkspace();
    });
  }

  if (shellMode === "booting") {
    return (
      <div className="app-shell">
        <LoadingWorkspace badge={setupStateBadge} />
      </div>
    );
  }

  if (showSetup) {
    return (
      <div className="app-shell">
        <SetupWorkspace
          busyAction={busyAction}
          canReturnToControlRoom={canReturnToControlRoom}
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
          onReturnToControlRoom={returnToControlRoom}
          onRunWorkspaceTest={() => void runSetupWorkspaceTest()}
          projectName={projectName}
          repositoryPath={repositoryPath}
          setupBadge={setupStateBadge}
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
            Sync
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
          <button className={`engine-badge ${setupStateBadge.className}`} onClick={() => void openRepairSetup()}>
            {setupStateBadge.label}
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
            <EscalationCard
              question={openQuestion}
              run={conversation?.openQuestionRun ?? null}
              status={status}
            />
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
                <div className="section-title">Session state</div>
                <div className="section-meta">{status?.orchestrator?.lastSummary ?? "The Chief of Staff router is ready."}</div>
              </div>
            </div>
            <div className="meta-pairs">
              <div className="meta-pair">
                <span className="meta-pair-label">Chief of Staff loop</span>
                <StatusPill status={status?.orchestrator?.status ?? "idle"} />
              </div>
              <div className="meta-pair">
                <span className="meta-pair-label">Last successful GitHub sync</span>
                <span className="meta-pair-value">
                  {status?.lastSuccessfulSyncAt
                    ? formatTimestamp(status.lastSuccessfulSyncAt)
                    : "No successful sync yet"}
                </span>
              </div>
              <div className="meta-pair">
                <span className="meta-pair-label">PR sweep</span>
                <span className="meta-pair-value">
                  {status?.prSweep
                    ? status.prSweep.status === "running"
                      ? "Running"
                      : status.prSweep.pausedIssueWork
                        ? "Pausing issue work"
                        : status.prSweep.nextRunAt
                          ? `Scheduled for ${formatTimestamp(status.prSweep.nextRunAt)}`
                          : "Unscheduled"
                    : "Unavailable"}
                </span>
              </div>
            </div>
            <div className="list-note">
              The Chief of Staff loop stays local and routes work through persistent lane sessions.
            </div>
          </section>

          <section className="panel sidebar-card">
            <div className="panel-header">
              <div>
                <div className="section-title">Project settings</div>
                <div className="section-meta">
                  Repo, base branch, worktree root, and model settings for the active project.
                </div>
              </div>
              <span
                className={`check-pill ${
                  status?.projectConfigStatus?.branchStatus === "stale"
                    ? "check-pill-needs-action"
                    : "check-pill-ready"
                }`}
              >
                {status?.projectConfigStatus
                  ? status.projectConfigStatus.branchStatus === "stale"
                    ? "Needs recovery"
                    : status.projectConfigStatus.defaultBranchStrategy === "custom"
                      ? "Custom base"
                      : "Repo default"
                  : "Unavailable"}
              </span>
            </div>
            {editingProjectSettings && projectSettingsDraft ? (
              <div className="setup-form">
                <label className="field-group">
                  <span className="field-label">Repo path</span>
                  <input
                    className="text-field"
                    value={projectSettingsDraft.repoPath}
                    onChange={(event) =>
                      setProjectSettingsDraft((current) =>
                        current
                          ? {
                              ...current,
                              repoPath: event.target.value
                            }
                          : current
                      )
                    }
                  />
                </label>
                <label className="field-group">
                  <span className="field-label">Repo slug</span>
                  <input
                    className="text-field"
                    value={projectSettingsDraft.repoSlug}
                    onChange={(event) =>
                      setProjectSettingsDraft((current) =>
                        current
                          ? {
                              ...current,
                              repoSlug: event.target.value
                            }
                          : current
                      )
                    }
                  />
                </label>
                <label className="field-group">
                  <span className="field-label">Base branch mode</span>
                  <select
                    className="text-field"
                    value={projectSettingsDraft.defaultBranchStrategy}
                    onChange={(event) =>
                      setProjectSettingsDraft((current) =>
                        current
                          ? {
                              ...current,
                              defaultBranchStrategy:
                                event.target.value === "custom" ? "custom" : "repo_default",
                              defaultBranch:
                                event.target.value === "custom"
                                  ? current.defaultBranch
                                  : status?.projectConfigStatus?.repoDefaultBranch ?? current.defaultBranch
                            }
                          : current
                      )
                    }
                  >
                    <option value="repo_default">Repo default</option>
                    <option value="custom">Custom</option>
                  </select>
                </label>
                <label className="field-group">
                  <span className="field-label">PR target branch</span>
                  <input
                    className="text-field"
                    disabled={projectSettingsDraft.defaultBranchStrategy === "repo_default"}
                    value={
                      projectSettingsDraft.defaultBranchStrategy === "repo_default"
                        ? status?.projectConfigStatus?.repoDefaultBranch ?? projectSettingsDraft.defaultBranch
                        : projectSettingsDraft.defaultBranch
                    }
                    onChange={(event) =>
                      setProjectSettingsDraft((current) =>
                        current
                          ? {
                              ...current,
                              defaultBranch: event.target.value
                            }
                          : current
                      )
                    }
                  />
                </label>
                <label className="field-group">
                  <span className="field-label">Worktree root</span>
                  <input
                    className="text-field"
                    value={projectSettingsDraft.worktreeRoot}
                    onChange={(event) =>
                      setProjectSettingsDraft((current) =>
                        current
                          ? {
                              ...current,
                              worktreeRoot: event.target.value
                            }
                          : current
                      )
                    }
                  />
                </label>
                <label className="field-group">
                  <span className="field-label">Model</span>
                  <input
                    className="text-field"
                    value={projectSettingsDraft.model}
                    onChange={(event) =>
                      setProjectSettingsDraft((current) =>
                        current
                          ? {
                              ...current,
                              model: event.target.value
                            }
                          : current
                      )
                    }
                  />
                </label>
                <div className="inline-actions">
                  <button
                    className="action-button action-button-primary"
                    disabled={busyAction === "save-project-settings"}
                    onClick={() => void handleSaveProjectSettings()}
                  >
                    {busyAction === "save-project-settings" ? "Saving..." : "Save settings"}
                  </button>
                  <button
                    className="action-button action-button-secondary"
                    onClick={() => {
                      hydrateProjectSettingsDraft(status);
                      setEditingProjectSettings(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="meta-pairs">
                  <div className="meta-pair">
                    <span className="meta-pair-label">Repo path</span>
                    <span className="meta-pair-value">{status?.project?.repoPath ?? "Unavailable"}</span>
                  </div>
                  <div className="meta-pair">
                    <span className="meta-pair-label">Worktree root</span>
                    <span className="meta-pair-value">{status?.project?.worktreeRoot ?? "Unavailable"}</span>
                  </div>
                  <div className="meta-pair">
                    <span className="meta-pair-label">PR target branch</span>
                    <span className="meta-pair-value">{status?.project?.defaultBranch ?? "Unavailable"}</span>
                  </div>
                  <div className="meta-pair">
                    <span className="meta-pair-label">Branch mode</span>
                    <span className="meta-pair-value">
                      {status?.projectConfigStatus?.defaultBranchStrategy === "custom"
                        ? "Custom"
                        : "Repo default"}
                    </span>
                  </div>
                  <div className="meta-pair">
                    <span className="meta-pair-label">Repo default branch</span>
                    <span className="meta-pair-value">
                      {status?.projectConfigStatus?.repoDefaultBranch ?? "Unavailable"}
                    </span>
                  </div>
                  <div className="meta-pair">
                    <span className="meta-pair-label">Current local branch</span>
                    <span className="meta-pair-value">
                      {status?.projectConfigStatus?.currentBranch ?? "Unavailable"}
                    </span>
                  </div>
                </div>
                <div className="compact-card">
                  <div className="compact-card-meta">
                    <span>{status?.project?.repoSlug ?? "No repo slug"}</span>
                    <span>{status?.project?.model ?? "No model"}</span>
                  </div>
                  <div className="list-note">
                    {status?.projectConfigStatus?.branchStatusSummary ??
                      "Project settings are not available yet."}
                  </div>
                </div>
                <div className="inline-actions">
                  <button
                    className="action-button action-button-secondary"
                    onClick={() => {
                      hydrateProjectSettingsDraft(status);
                      setEditingProjectSettings(true);
                    }}
                  >
                    Edit settings
                  </button>
                  {status?.projectConfigStatus?.canHealToRepoDefault ? (
                    <button
                      className="action-button action-button-primary"
                      disabled={busyAction === "heal-base-branch"}
                      onClick={() => void handleHealBaseBranch()}
                    >
                      {busyAction === "heal-base-branch" ? "Recovering..." : "Use repo default"}
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </section>

          <section className="panel sidebar-card recovery-card">
            <div className="panel-header">
              <div>
                <div className="section-title">Recovery</div>
                <div className="section-meta">
                  Reset only the local router runtime for this project when the control room is wedged.
                </div>
              </div>
              <span className="check-pill check-pill-needs-action">Manual recovery</span>
            </div>
            <div className="recovery-grid">
              <div className="compact-card recovery-block">
                <div className="list-title">This clears</div>
                <ul className="recovery-list">
                  {RESET_RUNTIME_CLEARS.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div className="compact-card recovery-block">
                <div className="list-title">This keeps</div>
                <ul className="recovery-list">
                  {RESET_RUNTIME_KEEPS.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="list-note">
              GitHub issues, pull requests, and repo contents stay intact. After reset, run Sync and then Start when orchestration should resume.
            </div>
            <div className="inline-actions">
              <button
                className="action-button action-button-danger"
                disabled={busyAction === "reset-router-runtime"}
                onClick={() => void handleResetRouterRuntime()}
              >
                {busyAction === "reset-router-runtime"
                  ? "Resetting runtime..."
                  : "Reset local router runtime"}
              </button>
            </div>
          </section>

          <section className="panel sidebar-card">
            <div className="panel-header">
              <div>
                <div className="section-title">PR sweep</div>
                <div className="section-meta">The Chief of Staff periodically pauses normal issue routing to clear the open PR queue, then resumes backlog work.</div>
              </div>
            </div>
            <ItemList<NonNullable<DirectorStatusResponse["prSweep"]>>
              empty="PR sweep state is not available yet."
              items={status?.prSweep ? [status.prSweep] : []}
              render={(prSweep) => (
                <div className="compact-card">
                  <div className="compact-card-head">
                    <div className="list-title">
                      {prSweep.status === "running"
                        ? "Sweep in progress"
                        : prSweep.nextRunAt
                          ? `Next sweep ${formatTimestamp(prSweep.nextRunAt)}`
                          : "Sweep not scheduled"}
                    </div>
                    <span className="check-pill check-pill-needs-action">
                      {prSweep.pausedIssueWork ? "Issue work paused" : prSweep.status}
                    </span>
                  </div>
                  <div className="compact-card-meta">
                    {prSweep.currentPullRequestNumber ? <span>Reviewing PR #{prSweep.currentPullRequestNumber}</span> : null}
                    {prSweep.pendingPullRequestNumbers.length > 0 ? (
                      <span>{prSweep.pendingPullRequestNumbers.length} PRs remaining</span>
                    ) : null}
                    {prSweep.waitingOnIssueNumber ? <span>Waiting on issue #{prSweep.waitingOnIssueNumber}</span> : null}
                    {prSweep.completedAt ? <span>Last completed {formatTimestamp(prSweep.completedAt)}</span> : null}
                  </div>
                  <div className="list-note">
                    {prSweep.lastSummary ?? "Chief of Staff will schedule the next PR sweep when the router is ready."}
                  </div>
                </div>
              )}
            />
          </section>

          <section className="panel sidebar-card">
            <div className="panel-header">
              <div>
                <div className="section-title">Recent activity</div>
                <div className="section-meta">A compact timeline of recent CoS, lane, and PR sweep automation events.</div>
              </div>
            </div>
            <ItemList<DirectorStatusResponse["recentActivity"][number]>
              empty="No recent automation activity yet."
              items={status?.recentActivity ?? []}
              render={(activity) => (
                <div className="list-row compact-list-row" key={activity.id}>
                  <div>
                    <div className="list-title">{activity.summary}</div>
                    <div className="list-meta">
                      <span>{activity.kind.replaceAll("_", " ")}</span>
                      {activity.laneName ? <span>{activity.laneName}</span> : null}
                      {activity.issueNumber ? <span>Issue #{activity.issueNumber}</span> : null}
                      {activity.pullRequestNumber ? <span>PR #{activity.pullRequestNumber}</span> : null}
                    </div>
                  </div>
                  <div className="list-note">{formatTimestamp(activity.createdAt)}</div>
                </div>
              )}
            />
          </section>

          <section className="panel sidebar-card">
            <div className="panel-header">
              <div>
                <div className="section-title">Current blocker</div>
                <div className="section-meta">Only the Chief of Staff escalates to you when a real product call is needed.</div>
              </div>
            </div>
            <ItemList<NonNullable<DirectorStatusResponse["openQuestion"]>>
              empty="No blocker is waiting on you right now."
              items={status?.openQuestion ? [status.openQuestion] : []}
              render={(question) => (
                <EscalationCard key={question.id} question={question} status={status} variant="compact" />
              )}
            />
          </section>

          <section className="panel sidebar-card">
            <div className="panel-header">
              <div>
                <div className="section-title">Lanes</div>
                <div className="section-meta">Persistent Codex sessions owned by the Chief of Staff. Independent lanes can run in parallel when they own different issues.</div>
              </div>
            </div>
            <ItemList<DirectorStatusResponse["lanes"][number]>
              empty="No lane sessions are active yet."
              items={status?.lanes ?? []}
              render={(lane) => (
                <div className="list-row compact-list-row" key={lane.id}>
                  <div>
                    <div className="list-title">{lane.name}</div>
                    <div className="list-meta">
                      <span>{String(lane.status).replace("_", " ")}</span>
                      {lane.currentIssueNumber ? <span>Issue #{lane.currentIssueNumber}</span> : null}
                      {lane.activePullRequestNumber ? <span>PR #{lane.activePullRequestNumber}</span> : null}
                    </div>
                  </div>
                  <div className="list-note">{lane.lastSummary ?? lane.lastPlanSummary ?? "Waiting for a routed issue."}</div>
                </div>
              )}
            />
          </section>

          <section className="panel sidebar-card">
            <div className="panel-header">
              <div>
                <div className="section-title">Owned issues</div>
                <div className="section-meta">GitHub issues stay durable; the router only shows whether the Chief of Staff or a lane currently owns each slice.</div>
              </div>
            </div>
            <ItemList<DirectorStatusResponse["issues"][number]>
              empty="No GitHub issues are currently owned by the Chief of Staff or a lane."
              items={(status?.issues ?? []).filter((issue) => issue.state.toLowerCase() === "open" && issue.ownerKind)}
              render={(issue) => (
                <div className="list-row compact-list-row" key={issue.issueNumber}>
                  <div>
                    <div className="list-title">#{issue.issueNumber} {issue.title}</div>
                    <div className="list-meta">
                      {issue.ownerName ? <span>{issue.ownerName}</span> : null}
                      <span>{String(issue.status).replace("_", " ")}</span>
                      {issue.linkedPullRequestNumber ? <span>PR #{issue.linkedPullRequestNumber}</span> : null}
                    </div>
                  </div>
                  <div className="list-note">{issue.lastSummary ?? issue.workflowState}</div>
                </div>
              )}
            />
          </section>

          <section className="panel sidebar-card">
            <div className="panel-header">
              <div>
                <div className="section-title">Pull requests</div>
                <div className="section-meta">Linked PRs stay visible, but they are downstream of CoS and lane routing.</div>
              </div>
            </div>
            <ItemList<DirectorStatusResponse["openPullRequests"][number]>
              empty="No open pull requests yet."
              items={status?.openPullRequests ?? []}
              render={(pullRequest) => (
                <div className="list-row compact-list-row" key={pullRequest.id}>
                  <div>
                    <div className="list-title">PR #{pullRequest.number} {pullRequest.title}</div>
                    <div className="list-meta">
                      <span>{pullRequest.reviewDecision ?? (pullRequest.isDraft ? "Draft" : "Open")}</span>
                      {pullRequest.checksBucket ? <span>{pullRequest.checksBucket.replaceAll("_", " ")}</span> : null}
                      {pullRequest.linkedIssueNumbers[0] ? <span>Issue #{pullRequest.linkedIssueNumbers[0]}</span> : null}
                    </div>
                  </div>
                  <div className="list-note">{pullRequest.headRefName} {" -> "} {pullRequest.baseRefName}</div>
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
  canReturnToControlRoom: boolean;
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
  onReturnToControlRoom: () => void;
  onRunWorkspaceTest: () => void;
  onWorktreeRootChange: (value: string) => void;
  projectName: string;
  repositoryPath: string;
  setupBadge: { label: string; className: string };
  setupStatus: SetupStatusResponse | null;
  setupStep: SetupStep;
  worktreeRoot: string;
}) {
  const repositoryCheck = props.setupStatus?.checks.find((check) => check.kind === "repository") ?? null;

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
        <div className="header-actions">
          <span className={`engine-badge engine-badge-static ${props.setupBadge.className}`}>
            {props.setupBadge.label}
          </span>
          {props.canReturnToControlRoom ? (
            <button className="action-button action-button-secondary" onClick={props.onReturnToControlRoom}>
              Return to control room
            </button>
          ) : null}
        </div>
      </header>

      {props.error ? <Banner tone="danger">{props.error}</Banner> : null}

      <div className="setup-grid">
        <section className="panel setup-hero">
          <div className="eyebrow">Local-first desktop shell</div>
          <h1 className="hero-title">Bring Director OS online on this computer.</h1>
          <p className="hero-copy">
            Director OS stays local. It checks the repository, GitHub CLI, Codex CLI, and a safe
            workspace test before the control room appears. On macOS, new installs live in
            Application Support and use Library/Caches for temporary files.
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
                {props.canReturnToControlRoom ? "Save repair" : "Complete setup"}
              </button>
              {props.canReturnToControlRoom ? (
                <button className="action-button action-button-secondary" onClick={props.onReturnToControlRoom}>
                  Return to control room
                </button>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function LoadingWorkspace(props: { badge: { label: string; className: string } }) {
  return (
    <div className="setup-shell">
      <header className="topbar setup-topbar">
        <div className="brand-block">
          <div className="brand-mark">D</div>
          <div>
            <div className="brand-name">Director OS</div>
            <div className="brand-meta">Checking the local control room before the shell loads.</div>
          </div>
        </div>
        <span className={`engine-badge engine-badge-static ${props.badge.className}`}>{props.badge.label}</span>
      </header>

      <main className="loading-shell">
        <section className="panel loading-panel">
          <div className="eyebrow">Local-first desktop shell</div>
          <h1 className="hero-title">Checking setup completion.</h1>
          <p className="hero-copy">
            Director OS is reading the local project registration and runtime health before it picks
            setup or the control room.
          </p>
        </section>
      </main>
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
  return <span className={`status-pill status-pill-${props.status.replace("_", "-")}`}>{formatOrchestratorStatus(props.status)}</span>;
}

function EscalationCard(props: {
  question: HumanQuestionRecord;
  run?: RunRecord | null;
  status: DirectorStatusResponse | null;
  variant?: "full" | "compact";
}) {
  const variant = props.variant ?? "full";
  const linkedIssue = resolveLinkedIssue(props.question, props.status);
  const linkedPullRequest = resolveLinkedPullRequest(props.question, props.status, linkedIssue);
  const heading = deriveEscalationHeading(props.question, linkedIssue, linkedPullRequest);
  const deck = deriveEscalationDeck(props.question, linkedIssue, linkedPullRequest);
  const hasContext = Boolean(linkedIssue || linkedPullRequest);

  return (
    <article className={`open-question-card ${variant === "compact" ? "open-question-card-compact" : ""}`}>
      <div className="open-question-header">
        <div className="open-question-header-copy">
          <div className="eyebrow">CoS escalation</div>
          <div className="open-question-head">
            <div className="open-question-title">{heading}</div>
            <span className="check-pill check-pill-needs-action">Decision needed</span>
          </div>
          {deck ? <p className="open-question-deck">{deck}</p> : null}
        </div>
        <div className="open-question-status">
          <span className="open-question-status-label">Raised</span>
          <span>{formatTimestamp(props.question.createdAt)}</span>
        </div>
      </div>

      <div className="open-question-sections">
        <QuestionSection emphasis="strong" label="Exact ask" text={props.question.question} />
        <QuestionSection label="Why it matters" text={props.question.whyItMatters} />
        <QuestionSection emphasis="strong" label="Recommendation" text={props.question.recommendation} />
      </div>

      <div className="open-question-context">
        <div className="open-question-context-label">Linked context</div>
        <div className="open-question-context-links">
          {linkedIssue ? (
            <ContextLink
              kind="Issue"
              number={linkedIssue.number}
              title={linkedIssue.title}
              url={linkedIssue.url}
            />
          ) : null}
          {linkedPullRequest ? (
            <ContextLink
              kind="PR"
              number={linkedPullRequest.number}
              title={linkedPullRequest.title}
              url={linkedPullRequest.url}
            />
          ) : null}
          {!hasContext ? (
            <span className="context-link context-link-static">No linked issue or PR context yet.</span>
          ) : null}
        </div>
      </div>

      {variant === "full" && props.run ? (
        <RunOutputDetails run={props.run} summaryLabel="Inspect source run" />
      ) : null}
    </article>
  );
}

function QuestionSection(props: {
  emphasis?: "default" | "strong";
  label: string;
  text: string;
}) {
  return (
    <section className={`open-question-section ${props.emphasis === "strong" ? "open-question-section-strong" : ""}`}>
      <div className="open-question-section-label">{props.label}</div>
      <p className="open-question-section-copy">{props.text}</p>
    </section>
  );
}

function ContextLink(props: {
  kind: "Issue" | "PR";
  number: number;
  title: string | null;
  url: string | null;
}) {
  const title = props.title ? `#${props.number} ${props.title}` : `#${props.number}`;
  const content = (
    <>
      <span className="context-link-kind">{props.kind}</span>
      <span className="context-link-title">{title}</span>
    </>
  );

  return props.url ? (
    <a className="context-link" href={props.url} rel="noreferrer" target="_blank">
      {content}
    </a>
  ) : (
    <span className="context-link context-link-static">{content}</span>
  );
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

function resolveLinkedIssue(
  question: HumanQuestionRecord,
  status: DirectorStatusResponse | null
): { number: number; title: string | null; url: string | null } | null {
  if (!question.linkedIssueNumber) {
    return null;
  }

  const linkedIssue =
    status?.issues.find((issue) => issue.issueNumber === question.linkedIssueNumber) ?? null;

  return {
    number: question.linkedIssueNumber,
    title: linkedIssue?.title ?? null,
    url:
      linkedIssue?.url ??
      buildGitHubUrl(status?.project?.repoSlug ?? null, "issues", question.linkedIssueNumber)
  };
}

function resolveLinkedPullRequest(
  question: HumanQuestionRecord,
  status: DirectorStatusResponse | null,
  linkedIssue: { number: number; title: string | null; url: string | null } | null
): { number: number; title: string | null; url: string | null } | null {
  if (!question.linkedPullRequestNumber) {
    return null;
  }

  const linkedPullRequest =
    status?.openPullRequests.find((pullRequest) => pullRequest.number === question.linkedPullRequestNumber) ?? null;
  const linkedIssueRecord =
    status?.issues.find((issue) => issue.issueNumber === linkedIssue?.number) ?? null;

  return {
    number: question.linkedPullRequestNumber,
    title: linkedPullRequest?.title ?? null,
    url:
      linkedPullRequest?.url ??
      linkedIssueRecord?.linkedPullRequestUrl ??
      buildGitHubUrl(status?.project?.repoSlug ?? null, "pull", question.linkedPullRequestNumber)
  };
}

function deriveEscalationHeading(
  question: HumanQuestionRecord,
  linkedIssue: { number: number; title: string | null; url: string | null } | null,
  linkedPullRequest: { number: number; title: string | null; url: string | null } | null
): string {
  if (linkedIssue) {
    return `Decision needed on issue #${linkedIssue.number}`;
  }

  if (linkedPullRequest) {
    return `Decision needed on PR #${linkedPullRequest.number}`;
  }

  if (!isGenericEscalationTitle(question.title)) {
    return question.title.trim();
  }

  return "Decision needed to proceed";
}

function deriveEscalationDeck(
  question: HumanQuestionRecord,
  linkedIssue: { number: number; title: string | null; url: string | null } | null,
  linkedPullRequest: { number: number; title: string | null; url: string | null } | null
): string | null {
  if (linkedIssue?.title) {
    return linkedIssue.title;
  }

  if (linkedPullRequest?.title) {
    return linkedPullRequest.title;
  }

  if (!isGenericEscalationTitle(question.title)) {
    return question.title.trim();
  }

  return null;
}

function isGenericEscalationTitle(value: string): boolean {
  return /^chief of staff question(?:\s+for\b.*)?$/i.test(value.trim());
}

function buildGitHubUrl(
  repoSlug: string | null,
  kind: "issues" | "pull",
  number: number
): string | null {
  return repoSlug ? `https://github.com/${repoSlug}/${kind}/${number}` : null;
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

function formatRunEnvelope(run: RunRecord): string {
  return JSON.stringify(
    {
      role: run.role,
      phase: run.phase,
      status: run.status,
      summary: run.summary,
      recommendedNextAction: run.recommendedNextAction,
      blockingQuestions: run.blockingQuestions,
      artifacts: run.artifacts,
      worktreePath: run.worktreePath,
      outputJson: run.outputJson
    },
    null,
    2
  );
}

function formatOrchestratorStatus(status: string): string {
  switch (status) {
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "blocked":
      return "Blocked";
    default:
      return "Idle";
  }
}

function formatRunStatus(status: RunRecord["status"]): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "needs_input":
      return "Waiting for you";
    case "succeeded":
      return "Done";
    case "failed":
      return "Blocked";
    default:
      return String(status).replace("_", " ");
  }
}

function formatRunTitle(run: RunRecord): string {
  const roleLabel =
    run.role === "chief_of_staff"
      ? "Chief of Staff"
      : run.role === "reviewer"
        ? "Review"
        : run.role === "worker"
          ? "Implementation"
          : run.role === "lane_owner"
            ? "Planning"
            : run.role.replaceAll("_", " ");
  return `${roleLabel} • ${run.phase.replaceAll("_", " ")}`;
}

function RunOutputDetails(props: { run: RunRecord; summaryLabel: string }) {
  const hasRaw = Boolean(props.run.rawModelOutput?.trim());
  const hasStructured =
    Boolean(props.run.outputJson) ||
    props.run.blockingQuestions.length > 0 ||
    Boolean(props.run.recommendedNextAction) ||
    props.run.artifacts.length > 0 ||
    Boolean(props.run.worktreePath);

  if (!hasRaw && !hasStructured) {
    return null;
  }

  return (
    <details className="run-output-toggle">
      <summary>{props.summaryLabel}</summary>
      {hasRaw ? (
        <div className="run-output-section">
          <div className="run-output-label">Raw Codex output</div>
          <pre className="raw-output-block">{props.run.rawModelOutput}</pre>
        </div>
      ) : null}
      {hasStructured ? (
        <div className="run-output-section">
          <div className="run-output-label">Parsed run payload</div>
          <pre className="raw-output-block">{formatRunEnvelope(props.run)}</pre>
        </div>
      ) : null}
    </details>
  );
}
