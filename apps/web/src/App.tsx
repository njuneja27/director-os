import { startTransition, useEffect, useMemo, useState } from "react";
import type {
  BriefRecord,
  DirectorTaskRecord,
  HomeOverview,
  IntakeResponse
} from "@director-os/shared";
import type {
  SetupCheck,
  SetupRepositoryDraft,
  SetupStatusResponse
} from "./api";
import {
  actOnBrief,
  actOnTask,
  completeSetup,
  fetchInbox,
  fetchIntake,
  fetchOverview,
  fetchSetupStatus,
  mergePr,
  probeRepository,
  reviewPr,
  runIssue,
  runWorkspaceTest,
  sendIntakeMessage,
  syncNow
} from "./api";

type ViewKey = "home" | "inbox" | "intake";
type SetupStep = "landing" | "repository" | "readiness" | "complete";
type SetupIntent = "fresh" | "repair";

export function App() {
  const [shellMode, setShellMode] = useState<"setup" | "app">("setup");
  const [setupStep, setSetupStep] = useState<SetupStep>("landing");
  const [setupIntent, setSetupIntent] = useState<SetupIntent>("fresh");
  const [setupStatus, setSetupStatus] = useState<SetupStatusResponse | null>(null);
  const [overview, setOverview] = useState<HomeOverview | null>(null);
  const [inbox, setInbox] = useState<DirectorTaskRecord[]>([]);
  const [intake, setIntake] = useState<IntakeResponse | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [draftInput, setDraftInput] = useState("");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [worktreeRoot, setWorktreeRoot] = useState("");
  const [modelName, setModelName] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>(() => readViewFromHash());

  const selectedTask = useMemo(
    () => inbox.find((task) => task.id === selectedTaskId) ?? inbox[0] ?? null,
    [inbox, selectedTaskId]
  );

  const currentBrief = intake?.brief ?? overview?.latestBrief ?? null;

  useEffect(() => {
    const onHashChange = () => {
      startTransition(() => {
        setView(readViewFromHash());
      });
    };

    window.addEventListener("hashchange", onHashChange);
    void bootstrap();

    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  useEffect(() => {
    if (selectedTaskId === null && inbox[0]) {
      setSelectedTaskId(inbox[0].id);
    }
  }, [inbox, selectedTaskId]);

  const codexCheck = setupStatus?.checks.find((check) => check.kind === "codex") ?? null;
  const codexBadge = deriveEngineBadge(codexCheck, setupStatus?.completed ?? false);
  const showSetup = shellMode === "setup" || !setupStatus?.completed;

  async function bootstrap() {
    await refreshSetupStatus();
  }

  async function refreshSetupStatus(options?: { forceSetup?: boolean }) {
    try {
      setError(null);
      const nextStatus = await fetchSetupStatus();
      setSetupStatus(nextStatus);
      hydrateSetupDraft(nextStatus.repositoryDraft);

      if (nextStatus.completed && !options?.forceSetup) {
        setShellMode("app");
        setSetupStep("complete");
        setSetupIntent("repair");
        try {
          await refreshMainData();
        } catch (mainDataError) {
          setError(mainDataError instanceof Error ? mainDataError.message : String(mainDataError));
        }
        return;
      }

      setShellMode("setup");
      setSetupIntent(nextStatus.activeProject ? "repair" : "fresh");
      setSetupStep(nextStatus.repositoryDraft || nextStatus.activeProject ? "readiness" : "landing");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setShellMode("setup");
      setSetupIntent("fresh");
      setSetupStep("landing");
    }
  }

  async function refreshMainData() {
    const [nextOverview, nextInbox, nextIntake] = await Promise.all([
      fetchOverview(),
      fetchInbox(),
      fetchIntake()
    ]);

    setOverview(nextOverview);
    setInbox(nextInbox.tasks);
    setIntake(nextIntake);
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

  async function runMainAction(actionKey: string, runner: () => Promise<unknown>) {
    try {
      setBusyAction(actionKey);
      setError(null);
      await runner();
      await refreshMainData();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyAction(null);
    }
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
      } else if (nextStatus.canComplete) {
        setSetupStep("readiness");
      }
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

    await runSetupAction("setup-workspace-test", async () => {
      const nextStatus = await runWorkspaceTest(setupStatus.repositoryDraft as SetupRepositoryDraft);
      setSetupStep(nextStatus.canComplete ? "readiness" : "repository");
      return nextStatus;
    });
  }

  async function completeDesktopSetup() {
    if (!setupStatus?.repositoryDraft) {
      setError("Probe the repository before completing setup.");
      return;
    }

    await runSetupAction("setup-complete", async () => {
      const nextStatus = await completeSetup(setupStatus.repositoryDraft as SetupRepositoryDraft);
      setShellMode("app");
      setView("home");
      window.location.hash = "home";
      await refreshMainData();
      return nextStatus;
    });
  }

  async function openRepairSetup() {
    setShellMode("setup");
    setSetupIntent("repair");
    setSetupStep(setupStatus?.repositoryDraft ? "readiness" : "repository");
    await refreshSetupStatus({ forceSetup: true });
  }

  async function returnToWorkspace() {
    setShellMode("app");
    setView("home");
    window.location.hash = "home";
    await refreshMainData();
  }

  if (showSetup) {
    return (
      <div className="app-shell">
        <SetupWorkspace
          busyAction={busyAction}
          codexBadge={codexBadge}
          error={error}
          intent={setupIntent}
          onBeginSetup={() => void beginSetup()}
          onCompleteSetup={() => void completeDesktopSetup()}
          onOpenWorkspace={() => void returnToWorkspace()}
          onProbeRepository={() => void probeSetupRepository()}
          onRefresh={() => void refreshSetupStatus({ forceSetup: true })}
          onRunWorkspaceTest={() => void runSetupWorkspaceTest()}
          onRepositoryPathChange={setRepositoryPath}
          onProjectNameChange={setProjectName}
          onWorktreeRootChange={setWorktreeRoot}
          onModelNameChange={setModelName}
          repositoryPath={repositoryPath}
          projectName={projectName}
          setupStep={setupStep}
          setupStatus={setupStatus}
          worktreeRoot={worktreeRoot}
          modelName={modelName}
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
              {overview?.project ? `${overview.project.name} · ${overview.project.repoSlug}` : "No project selected"}
            </div>
          </div>
        </div>
        <nav className="topnav" aria-label="Primary">
          <button className={tabClass(view === "home")} onClick={() => navigate("home")}>
            Home
          </button>
          <button className={tabClass(view === "inbox")} onClick={() => navigate("inbox")}>
            Inbox
          </button>
          <button className={tabClass(view === "intake")} onClick={() => navigate("intake")}>
            Intake
          </button>
        </nav>
        <div className="header-actions">
          <button
            className="button button-secondary"
            disabled={busyAction === "sync"}
            onClick={() => void runMainAction("sync", syncNow)}
          >
            {busyAction === "sync" ? "Syncing..." : "Sync GitHub"}
          </button>
          <button
            className={`engine-badge engine-badge-${codexBadge.tone}`}
            onClick={() => void openRepairSetup()}
            type="button"
          >
            {codexBadge.label}
          </button>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <main className="page-shell">
        {view === "home" ? (
          <HomeView
            busyAction={busyAction}
            onOpenInbox={() => navigate("inbox")}
            onOpenIntake={() => navigate("intake")}
            onOpenSetup={() => void openRepairSetup()}
            onMergePr={(prNumber) => void runMainAction(`merge-${prNumber}`, () => mergePr(prNumber))}
            onReviewPr={(prNumber) => void runMainAction(`review-${prNumber}`, () => reviewPr(prNumber))}
            onRunIssue={(issueNumber) => void runMainAction(`issue-${issueNumber}`, () => runIssue(issueNumber))}
            overview={overview}
          />
        ) : null}

        {view === "inbox" ? (
          <InboxView
            busyAction={busyAction}
            currentBrief={currentBrief}
            onApproveBrief={(brief) => void runMainAction(`brief-approve-${brief.id}`, () => actOnBrief(brief.id, "approve"))}
            onMergePr={(prNumber) => void runMainAction(`merge-${prNumber}`, () => mergePr(prNumber))}
            onRejectBrief={(brief) => void runMainAction(`brief-reject-${brief.id}`, () => actOnBrief(brief.id, "reject"))}
            onResolveTask={(task) => void runMainAction(`task-${task.id}`, () => actOnTask(task.id, "resolve"))}
            onReviseBrief={(brief) => void runMainAction(`brief-revise-${brief.id}`, () => actOnBrief(brief.id, "revise"))}
            onSelectTask={(taskId) => setSelectedTaskId(taskId)}
            selectedTask={selectedTask}
            tasks={inbox}
          />
        ) : null}

        {view === "intake" ? (
          <IntakeView
            busyAction={busyAction}
            brief={currentBrief}
            draftInput={draftInput}
            onApprove={(brief) => void runMainAction(`brief-approve-${brief.id}`, () => actOnBrief(brief.id, "approve"))}
            onDraftInputChange={setDraftInput}
            onReject={(brief) => void runMainAction(`brief-reject-${brief.id}`, () => actOnBrief(brief.id, "reject"))}
            onRevise={(brief) => void runMainAction(`brief-revise-${brief.id}`, () => actOnBrief(brief.id, "revise"))}
            onSubmit={() =>
              void runMainAction("intake", async () => {
                await sendIntakeMessage(draftInput.trim());
                setDraftInput("");
              })
            }
          />
        ) : null}
      </main>
    </div>
  );

  function navigate(next: ViewKey) {
    startTransition(() => {
      setView(next);
    });
    window.location.hash = next;
  }
}

function SetupWorkspace(props: {
  busyAction: string | null;
  codexBadge: { label: string; tone: "ready" | "warning" | "danger" | "neutral" };
  error: string | null;
  intent: SetupIntent;
  onBeginSetup: () => void;
  onCompleteSetup: () => void;
  onOpenWorkspace: () => void;
  onProbeRepository: () => void;
  onRefresh: () => void;
  onRunWorkspaceTest: () => void;
  onRepositoryPathChange: (value: string) => void;
  onProjectNameChange: (value: string) => void;
  onWorktreeRootChange: (value: string) => void;
  onModelNameChange: (value: string) => void;
  repositoryPath: string;
  projectName: string;
  setupStep: SetupStep;
  setupStatus: SetupStatusResponse | null;
  worktreeRoot: string;
  modelName: string;
}) {
  const status = props.setupStatus;
  const checks = status?.checks ?? [];
  const canComplete = Boolean(status?.completed || status?.canComplete);

  return (
    <div className="setup-shell">
      <header className="topbar setup-topbar">
        <div className="brand-block">
          <div className="brand-mark">D</div>
          <div>
            <div className="brand-name">Director OS</div>
            <div className="brand-meta">
              {props.intent === "repair" ? "Repair the local desktop setup" : "Desktop onboarding for the local machine"}
            </div>
          </div>
        </div>
        <div className="header-actions">
          {status?.completed ? (
            <button className="button button-secondary" onClick={props.onOpenWorkspace} type="button">
              Return to workspace
            </button>
          ) : null}
          <button className={`engine-badge engine-badge-${props.codexBadge.tone}`} onClick={props.onRefresh} type="button">
            {props.codexBadge.label}
          </button>
        </div>
      </header>

      {props.error ? <div className="error-banner">{props.error}</div> : null}

      <main className="setup-grid">
        <section className="panel setup-hero">
          <div className="eyebrow">Local-first desktop shell</div>
          <h1>
            {props.intent === "repair" ? "Repair the machine, then keep moving." : "Bring Director OS online on this computer."}
          </h1>
          <p className="section-intro">
            Director OS stays local. It checks the repository, GitHub CLI, Codex CLI, and a safe workspace test before the workspace appears.
          </p>

          <div className="step-list">
            <div className={`step-item ${props.setupStep === "landing" ? "step-item-active" : ""}`}>
              <strong>1. Landing</strong>
              <span>Start the setup conversation.</span>
            </div>
            <div className={`step-item ${props.setupStep === "repository" ? "step-item-active" : ""}`}>
              <strong>2. Repository</strong>
              <span>Point Director OS at an absolute repo path.</span>
            </div>
            <div className={`step-item ${props.setupStep === "readiness" ? "step-item-active" : ""}`}>
              <strong>3. Readiness</strong>
              <span>Confirm GitHub, Codex, and the workspace.</span>
            </div>
            <div className={`step-item ${props.setupStep === "complete" ? "step-item-active" : ""}`}>
              <strong>4. Complete</strong>
              <span>Open the director workspace.</span>
            </div>
          </div>
        </section>

        <section className="panel setup-panel">
          {props.setupStep === "landing" ? (
            <div className="setup-stage">
              <h2>Start setup</h2>
              <p>
                We will verify the local repository path, GitHub login, Codex availability, and a safe workspace proof-of-life test.
              </p>
              <div className="button-row">
                <button className="button button-primary" onClick={props.onBeginSetup} type="button">
                  Begin setup
                </button>
              </div>
            </div>
          ) : null}

          {props.setupStep === "repository" ? (
            <div className="setup-stage">
              <div className="section-header">
                <h2>Repository</h2>
                <span className="status-chip status-ready">Ready to probe</span>
              </div>
              <div className="setup-form-grid">
                <label className="field">
                  <span>Repository path</span>
                  <input
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    placeholder="/Users/nishant/Documents/projects/my-app"
                    value={props.repositoryPath}
                    onChange={(event) => props.onRepositoryPathChange(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Project name</span>
                  <input
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    placeholder="My Product"
                    value={props.projectName}
                    onChange={(event) => props.onProjectNameChange(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Worktree root</span>
                  <input
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    placeholder="Optional local worktree directory"
                    value={props.worktreeRoot}
                    onChange={(event) => props.onWorktreeRootChange(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Model preset</span>
                  <input
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    placeholder="Optional runner preset"
                    value={props.modelName}
                    onChange={(event) => props.onModelNameChange(event.target.value)}
                  />
                </label>
              </div>
              <div className="button-row">
                <button className="button button-primary" disabled={props.busyAction === "setup-probe-repository"} onClick={props.onProbeRepository} type="button">
                  {props.busyAction === "setup-probe-repository" ? "Checking..." : "Check repository"}
                </button>
                <button className="button button-secondary" onClick={props.onRefresh} type="button">
                  Refresh status
                </button>
              </div>
              {status?.repositoryDraft ? <RepositorySummary draft={status.repositoryDraft} /> : null}
            </div>
          ) : null}

          {props.setupStep === "readiness" ? (
            <div className="setup-stage">
              <div className="section-header">
                <h2>Readiness</h2>
                <span className={`status-chip status-${status?.canComplete ? "ready" : "pending"}`}>
                  {status?.canComplete ? "Ready to complete" : "Waiting on checks"}
                </span>
              </div>
              {status?.repositoryDraft ? <RepositorySummary draft={status.repositoryDraft} /> : null}
              <div className="check-grid">
                {checks.map((check) => (
                  <SetupCheckCard key={check.kind} check={check} />
                ))}
              </div>
              <div className="button-row">
                <button className="button button-primary" disabled={!canComplete || props.busyAction === "setup-complete"} onClick={props.onCompleteSetup} type="button">
                  {props.busyAction === "setup-complete" ? "Completing..." : "Finish setup"}
                </button>
                <button className="button button-secondary" disabled={props.busyAction === "setup-workspace-test"} onClick={props.onRunWorkspaceTest} type="button">
                  {props.busyAction === "setup-workspace-test" ? "Testing..." : "Run local test"}
                </button>
              </div>
            </div>
          ) : null}

          {props.setupStep === "complete" ? (
            <div className="setup-stage">
              <div className="section-header">
                <h2>Complete</h2>
                <span className="status-chip status-ready">Workspace ready</span>
              </div>
              <p>
                Director OS is connected to your local repository, GitHub CLI, and Codex CLI. The director workspace can now take over.
              </p>
              {status?.repositoryDraft ? <RepositorySummary draft={status.repositoryDraft} /> : null}
              <div className="button-row">
                <button className="button button-primary" onClick={props.onOpenWorkspace} type="button">
                  Open Director Home
                </button>
                <button className="button button-secondary" onClick={props.onRefresh} type="button">
                  Re-check setup
                </button>
              </div>
            </div>
          ) : null}

          {!status ? (
            <div className="setup-stage">
              <h2>Checking local setup</h2>
              <p>Director OS is loading the local status before it opens the workspace.</p>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function RepositorySummary(props: { draft: SetupRepositoryDraft }) {
  return (
    <section className="repository-summary">
      <div className="section-header">
        <h3>Repository details</h3>
      </div>
      <dl className="summary-grid">
        <div>
          <dt>Repository</dt>
          <dd>{props.draft.repoPath}</dd>
        </div>
        <div>
          <dt>GitHub slug</dt>
          <dd>{props.draft.repoSlug || "Not resolved yet"}</dd>
        </div>
        <div>
          <dt>Default branch</dt>
          <dd>{props.draft.defaultBranch || "Not resolved yet"}</dd>
        </div>
        <div>
          <dt>Worktree root</dt>
          <dd>{props.draft.worktreeRoot || "Not set"}</dd>
        </div>
        <div>
          <dt>Model preset</dt>
          <dd>{props.draft.model || "Not set"}</dd>
        </div>
        <div>
          <dt>Project name</dt>
          <dd>{props.draft.projectName || "Not set"}</dd>
        </div>
      </dl>
    </section>
  );
}

function SetupCheckCard(props: { check: SetupCheck }) {
  return (
    <article className="check-card">
      <div className="check-card-top">
        <div>
          <strong>{props.check.title}</strong>
          <div className="row-meta">{props.check.detail}</div>
        </div>
        <span className={`status-chip status-${props.check.status}`}>{props.check.status.replaceAll("_", " ")}</span>
      </div>
      <div className="task-recommendation">Recommended action: {props.check.recommendedAction}</div>
      {props.check.advancedDetail ? <details className="advanced-details"><summary>Advanced details</summary><p>{props.check.advancedDetail}</p></details> : null}
    </article>
  );
}

function HomeView(props: {
  overview: HomeOverview | null;
  busyAction: string | null;
  onRunIssue: (issueNumber: number) => void;
  onReviewPr: (prNumber: number) => void;
  onMergePr: (prNumber: number) => void;
  onOpenInbox: () => void;
  onOpenIntake: () => void;
  onOpenSetup: () => void;
}) {
  if (!props.overview?.project) {
    return (
      <section className="empty-state">
        <h1>No active project yet</h1>
        <p>Open setup and point Director OS at a local repository to begin the operating loop.</p>
        <div className="button-row">
          <button className="button button-primary" onClick={props.onOpenSetup} type="button">
            Open setup
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="layout-grid">
      <section className="main-column">
        <section className="panel">
          <div className="section-header">
            <h1>Needs your judgment</h1>
            <button className="button button-secondary" onClick={props.onOpenInbox} type="button">
              Open inbox
            </button>
          </div>
          {props.overview.pendingTasks.length ? (
            <div className="stack">
              {props.overview.pendingTasks.map((task) => (
                <article className="task-card" key={task.id}>
                  <div className="task-card-top">
                    <strong>{task.title}</strong>
                    <span className="task-kind">{task.kind.replaceAll("_", " ")}</span>
                  </div>
                  <p>{task.description}</p>
                  <div className="task-recommendation">Recommendation: {task.recommendation}</div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyCopy title="Nothing needs a decision right now." body="The system is running without an immediate director interrupt." />
          )}
        </section>

        <section className="panel">
          <div className="section-header">
            <h2>Work in motion</h2>
            <button className="button button-secondary" onClick={props.onOpenIntake} type="button">
              Open intake
            </button>
          </div>
          {props.overview.activeIssues.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>State</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {props.overview.activeIssues.map((issue) => (
                  <tr key={issue.number}>
                    <td>
                      <div className="row-title">
                        #{issue.number} {issue.title}
                      </div>
                      <div className="row-meta">{issue.url}</div>
                    </td>
                    <td>
                      <span className={`status-chip status-${issue.workflowState}`}>{issue.workflowState.replaceAll("_", " ")}</span>
                    </td>
                    <td>{formatTimestamp(issue.updatedAt)}</td>
                    <td className="table-action">
                      {issue.workflowState === "ready" ? (
                        <button
                          className="button button-primary"
                          disabled={props.busyAction === `issue-${issue.number}`}
                          onClick={() => props.onRunIssue(issue.number)}
                          type="button"
                        >
                          {props.busyAction === `issue-${issue.number}` ? "Running..." : "Run"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyCopy title="No synced issues yet." body="Approve a brief or sync GitHub to populate the active work queue." />
          )}
        </section>

        <section className="panel">
          <div className="section-header">
            <h2>Open pull requests</h2>
          </div>
          {props.overview.openPullRequests.length ? (
            <div className="stack">
              {props.overview.openPullRequests.map((pr) => (
                <article className="pr-row" key={pr.number}>
                  <div>
                    <div className="row-title">
                      #{pr.number} {pr.title}
                    </div>
                    <div className="row-meta">
                      {pr.headRefName} → {pr.baseRefName}
                    </div>
                  </div>
                  <div className="pr-actions">
                    <span className={`status-chip status-${pr.checksBucket ?? "draft"}`}>{pr.checksBucket ?? "unchecked"}</span>
                    <button
                      className="button button-secondary"
                      disabled={props.busyAction === `review-${pr.number}`}
                      onClick={() => props.onReviewPr(pr.number)}
                      type="button"
                    >
                      {props.busyAction === `review-${pr.number}` ? "Reviewing..." : "Review"}
                    </button>
                    <button
                      className="button button-primary"
                      disabled={props.busyAction === `merge-${pr.number}`}
                      onClick={() => props.onMergePr(pr.number)}
                      type="button"
                    >
                      {props.busyAction === `merge-${pr.number}` ? "Merging..." : "Merge"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyCopy title="No open pull requests." body="Once an issue run completes, its PR will appear here." />
          )}
        </section>
      </section>

      <aside className="side-column">
        <section className="panel">
          <h2>Current stance</h2>
          <dl className="stats-list">
            <div>
              <dt>Director tasks</dt>
              <dd>{props.overview.counts.pendingDirectorTasks}</dd>
            </div>
            <div>
              <dt>Active briefs</dt>
              <dd>{props.overview.counts.activeBriefs}</dd>
            </div>
            <div>
              <dt>Ready issues</dt>
              <dd>{props.overview.counts.readyIssues}</dd>
            </div>
            <div>
              <dt>Open PRs</dt>
              <dd>{props.overview.counts.openPullRequests}</dd>
            </div>
          </dl>
        </section>

        <section className="panel">
          <h2>Latest brief</h2>
          {props.overview.latestBrief ? (
            <div className="brief-summary">
              <strong>{props.overview.latestBrief.title}</strong>
              <p>{props.overview.latestBrief.summary}</p>
              <ul className="plain-list">
                <li>Target user: {props.overview.latestBrief.draft.targetUser || "Not set yet"}</li>
                <li>Desired outcome: {props.overview.latestBrief.draft.desiredOutcome || "Not set yet"}</li>
                <li>Status: {props.overview.latestBrief.status.replaceAll("_", " ")}</li>
              </ul>
            </div>
          ) : (
            <EmptyCopy title="No brief drafted yet." body="Use Intake to start a product conversation with the chief of staff." />
          )}
        </section>

        <section className="panel">
          <h2>Recent runs</h2>
          {props.overview.recentRuns.length ? (
            <ul className="plain-list">
              {props.overview.recentRuns.map((run) => (
                <li key={run.id}>
                  <strong>{run.role}</strong>
                  <div className="row-meta">{run.outputSummary}</div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyCopy title="No agent runs yet." body="Intake, issue execution, and PR review runs will appear here." />
          )}
        </section>
      </aside>
    </div>
  );
}

function InboxView(props: {
  tasks: DirectorTaskRecord[];
  selectedTask: DirectorTaskRecord | null;
  busyAction: string | null;
  currentBrief: BriefRecord | null;
  onSelectTask: (taskId: number) => void;
  onResolveTask: (task: DirectorTaskRecord) => void;
  onApproveBrief: (brief: BriefRecord) => void;
  onReviseBrief: (brief: BriefRecord) => void;
  onRejectBrief: (brief: BriefRecord) => void;
  onMergePr: (prNumber: number) => void;
}) {
  const selectedTask = props.selectedTask;
  const currentBrief = props.currentBrief;

  return (
    <div className="inbox-grid">
      <section className="panel">
        <div className="section-header">
          <h1>Inbox</h1>
          <span className="section-count">{props.tasks.length} items</span>
        </div>
        {props.tasks.length ? (
          <div className="stack">
            {props.tasks.map((task) => (
              <button
                className={`list-row ${props.selectedTask?.id === task.id ? "list-row-active" : ""}`}
                key={task.id}
                onClick={() => props.onSelectTask(task.id)}
                type="button"
              >
                <strong>{task.title}</strong>
                <span>{task.recommendation}</span>
              </button>
            ))}
          </div>
        ) : (
          <EmptyCopy title="Inbox clear." body="There are no outstanding asks for the director right now." />
        )}
      </section>

      <section className="panel detail-panel">
        {selectedTask ? (
          <>
            <div className="section-header">
              <h2>{selectedTask.title}</h2>
              <span className={`status-chip status-${selectedTask.status}`}>
                {selectedTask.status.replaceAll("_", " ")}
              </span>
            </div>
            <p>{selectedTask.description}</p>
            <div className="task-recommendation">Recommendation: {selectedTask.recommendation}</div>

            {selectedTask.kind === "approve_brief" && currentBrief ? (
              <>
                <BriefDraftCard brief={currentBrief} />
                <div className="button-row">
                  <button
                    className="button button-primary"
                    disabled={props.busyAction === `brief-approve-${currentBrief.id}`}
                    onClick={() => props.onApproveBrief(currentBrief)}
                    type="button"
                  >
                    {props.busyAction === `brief-approve-${currentBrief.id}` ? "Approving..." : "Approve brief"}
                  </button>
                  <button
                    className="button button-secondary"
                    disabled={props.busyAction === `brief-revise-${currentBrief.id}`}
                    onClick={() => props.onReviseBrief(currentBrief)}
                    type="button"
                  >
                    Revise
                  </button>
                  <button
                    className="button button-danger"
                    disabled={props.busyAction === `brief-reject-${currentBrief.id}`}
                    onClick={() => props.onRejectBrief(currentBrief)}
                    type="button"
                  >
                    Reject
                  </button>
                </div>
              </>
            ) : null}

            {selectedTask.kind === "approve_merge" ? (
              <div className="button-row">
                {readMergeTarget(selectedTask) !== null ? null : (
                  <span className="row-meta">This task is missing a pull request number.</span>
                )}
                <button
                  className="button button-primary"
                  disabled={readMergeTarget(selectedTask) === null || props.busyAction === `merge-${readMergeTarget(selectedTask)}`}
                  onClick={() => {
                    const mergeTarget = readMergeTarget(selectedTask);
                    if (mergeTarget === null) {
                      return;
                    }

                    props.onMergePr(mergeTarget);
                  }}
                  type="button"
                >
                  {props.busyAction === `merge-${readMergeTarget(selectedTask)}` ? "Merging..." : "Merge PR"}
                </button>
                <button
                  className="button button-secondary"
                  disabled={props.busyAction === `task-${selectedTask.id}`}
                  onClick={() => props.onResolveTask(selectedTask)}
                  type="button"
                >
                  Dismiss
                </button>
              </div>
            ) : null}

            {selectedTask.kind !== "approve_brief" && selectedTask.kind !== "approve_merge" ? (
              <div className="button-row">
                <button
                  className="button button-primary"
                  disabled={props.busyAction === `task-${selectedTask.id}`}
                  onClick={() => props.onResolveTask(selectedTask)}
                  type="button"
                >
                  Mark resolved
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <EmptyCopy title="Select an inbox item." body="The detail pane shows recommendation and actions for the selected task." />
        )}
      </section>
    </div>
  );
}

function IntakeView(props: {
  busyAction: string | null;
  brief: BriefRecord | null;
  draftInput: string;
  onDraftInputChange: (value: string) => void;
  onSubmit: () => void;
  onApprove: (brief: BriefRecord) => void;
  onRevise: (brief: BriefRecord) => void;
  onReject: (brief: BriefRecord) => void;
}) {
  const brief = props.brief;

  return (
    <div className="intake-grid">
      <section className="panel">
        <div className="section-header">
          <h1>Intake</h1>
        </div>
        <p className="section-intro">
          Describe the product goal in plain language. The chief of staff will keep distilling it into an approvable brief.
        </p>
        <label className="field">
          <span>Director message</span>
          <textarea
            rows={7}
            placeholder="Example: onboarding feels unclear for first-time operators; I want a calmer and more trustworthy first session."
            value={props.draftInput}
            onChange={(event) => props.onDraftInputChange(event.target.value)}
          />
        </label>
        <div className="button-row">
          <button
            className="button button-primary"
            disabled={!props.draftInput.trim() || props.busyAction === "intake"}
            onClick={props.onSubmit}
            type="button"
          >
            {props.busyAction === "intake" ? "Sending..." : "Send to chief of staff"}
          </button>
        </div>

        <section className="transcript-panel">
          <h2>Conversation</h2>
          {brief?.transcript.length ? (
            <div className="stack">
              {brief.transcript.map((entry, index) => (
                <article className={`transcript-row transcript-${entry.role}`} key={`${entry.createdAt}-${index}`}>
                  <div className="transcript-role">{entry.role === "director" ? "Director" : "Chief of staff"}</div>
                  <p>{entry.content}</p>
                </article>
              ))}
            </div>
          ) : (
            <EmptyCopy title="No intake history yet." body="Your first message will start the conversation and create the first brief draft." />
          )}
        </section>
      </section>

      <section className="panel">
        <div className="section-header">
          <h2>Live brief draft</h2>
          {brief ? <span className={`status-chip status-${brief.status}`}>{brief.status.replaceAll("_", " ")}</span> : null}
        </div>
        {brief ? (
          <>
            <BriefDraftCard brief={brief} />
            <div className="button-row">
              <button
                className="button button-primary"
                disabled={props.busyAction === `brief-approve-${brief.id}`}
                onClick={() => props.onApprove(brief)}
                type="button"
              >
                Approve
              </button>
              <button
                className="button button-secondary"
                disabled={props.busyAction === `brief-revise-${brief.id}`}
                onClick={() => props.onRevise(brief)}
                type="button"
              >
                Revise
              </button>
              <button
                className="button button-danger"
                disabled={props.busyAction === `brief-reject-${brief.id}`}
                onClick={() => props.onReject(brief)}
                type="button"
              >
                Reject
              </button>
            </div>
          </>
        ) : (
          <EmptyCopy title="No brief draft yet." body="Once the chief of staff has enough context, the structured brief will appear here." />
        )}
      </section>
    </div>
  );
}

function BriefDraftCard(props: { brief: BriefRecord }) {
  return (
    <div className="brief-card">
      <h3>{props.brief.draft.title}</h3>
      <p>{props.brief.summary}</p>
      <dl className="brief-grid">
        <div>
          <dt>Problem</dt>
          <dd>{props.brief.draft.problem || "Not yet set."}</dd>
        </div>
        <div>
          <dt>Target user</dt>
          <dd>{props.brief.draft.targetUser || "Not yet set."}</dd>
        </div>
        <div>
          <dt>Desired outcome</dt>
          <dd>{props.brief.draft.desiredOutcome || "Not yet set."}</dd>
        </div>
        <div>
          <dt>Constraints</dt>
          <dd>{renderList(props.brief.draft.constraints)}</dd>
        </div>
        <div>
          <dt>Non-goals</dt>
          <dd>{renderList(props.brief.draft.nonGoals)}</dd>
        </div>
        <div>
          <dt>Success metrics</dt>
          <dd>{renderList(props.brief.draft.successMetrics)}</dd>
        </div>
      </dl>
    </div>
  );
}

function EmptyCopy(props: { title: string; body: string }) {
  return (
    <div className="empty-copy">
      <strong>{props.title}</strong>
      <p>{props.body}</p>
    </div>
  );
}

function readViewFromHash(): ViewKey {
  const hash = window.location.hash.replace("#", "");
  return hash === "inbox" || hash === "intake" ? hash : "home";
}

function tabClass(active: boolean) {
  return active ? "tab-button tab-button-active" : "tab-button";
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function renderList(items: string[]) {
  return items.length ? items.join(" · ") : "Not yet set.";
}

function readMergeTarget(task: DirectorTaskRecord): number | null {
  const raw = task.payload.prNumber;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function deriveEngineBadge(
  check: SetupCheck | null,
  completed: boolean
): { label: string; tone: "ready" | "warning" | "danger" | "neutral" } {
  if (!check) {
    return { label: completed ? "Setup ready" : "Setup pending", tone: "neutral" };
  }

  switch (check.status) {
    case "ready":
      return { label: "Codex ready", tone: "ready" };
    case "needs_action":
      return { label: "Needs sign-in", tone: "warning" };
    case "blocked":
      return { label: "Blocked", tone: "danger" };
    case "waiting":
    default:
      return { label: "Checking Codex", tone: "neutral" };
  }
}
