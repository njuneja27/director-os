# Director OS

## What We Want To Do

Director OS is a local-first orchestration engine for running a software product with AI agents while the human stays at the level of direction, taste, and exception handling.

The product goal is not "full autonomy." The goal is a continuous operating loop where:

- the human director gives direction, constraints, and non-obvious product judgment
- the Chief of Staff owns prioritization, scoping, sequencing, merge judgment, and escalation
- lane owners take larger cross-cutting slices end to end
- focused workers handle bounded implementation, validation, and review tasks
- GitHub remains the durable artifact layer for issues and pull requests

The desired outcome is that the human mostly interacts through:

- `Start` / `Pause`
- director notes
- rare escalation decisions

not through manually triggering every issue, review, or merge step.

## How We Want To Do It

### Core Model

Director OS now treats the local app as an orchestration layer on top of GitHub and Codex CLI.

The core local objects are:

- `WorkItem`: a local record for a numbered GitHub issue, including kind, ownership mode, queue state, and active PR linkage
- `Run`: a Chief of Staff, lane, worker, review, validation, or PR-watch execution with logs and summaries
- `Decision`: a real escalation, targeted either to the Chief of Staff or the human director
- `PR cycle`: the local state machine around an open PR while it waits for automation, comments, revalidation, CoS review, and merge
- `Director note`: freeform direction from the human, used when the org needs more work to pull

### Operating Loop

1. The director adds a note or leaves existing GitHub issues as the durable backlog.
2. The Chief of Staff syncs GitHub and chooses the next best ready slice.
3. Larger or cross-cutting work is classified into a lane owner flow.
4. Lane planning happens in a read-only Codex pass before any write-enabled execution starts.
5. Bounded tasks go straight to worker execution.
6. Workers implement code, validate locally, and open real non-draft PRs linked to numbered issues.
7. PR cycles wait through automated review, address comments, rerun validation, and return to the Chief of Staff for independent merge judgment.
8. Only non-obvious product calls, contradictory review outcomes, or "no work left" states escalate back to the human director.

### UX Shape

Director OS should feel like a calm control room rather than a ticket board.

The primary desktop experience is:

- setup and repair for repository, GitHub CLI, Codex CLI, and local workspace readiness
- one control room with orchestrator state, queued work, active slices, PR cycles, escalations, recent runs, and director notes
- explicit `Start`, `Pause`, and `Sync` controls instead of manual per-issue execution buttons

### Technical Direction

- local desktop-first shell
- one embedded local backend process
- GitHub for live issue and PR state
- SQLite for orchestration state, runs, decisions, notes, and PR-cycle tracking
- Codex CLI as the local coding engine, with no separate API-key UX in Director OS

## Dogfood Smoke Test

When operating Director OS from this source checkout rather than an installed build, rebuild first so the local `dist` artifacts match the current source before using the CLI directly.

1. `npm run build`
2. `node apps/cli/dist/index.js sync`
3. `node apps/cli/dist/index.js status`

Expected result:

- recently closed GitHub issues do not appear in `status.queue`
- newly opened GitHub issues do appear in `status.queue`
- the control-room queue only shows open, claimable work

### Validated Local Smoke-Test Path

When using the CLI directly, prefer the root `director` script so commands run against a fresh build instead of potentially stale compiled artifacts.

Examples:

- `npm run director -- status`
- `npm run director -- sync`
- `npm run director -- start`
- `npm run director -- pause --reason "manual stop"`

For desktop dogfooding, prefer:

- `npm run desktop:start`

This path rebuilds the desktop shell, renderer, core package, and CLI before launch.

## Scope

### MVP

The MVP should prove that Director OS can dogfood itself on one repo with one human director.

MVP includes:

- local setup and readiness checks
- GitHub issue and PR mirroring
- a local orchestration schema built around work items, runs, decisions, notes, and orchestrator state
- a continuous Chief of Staff loop with `Start` and `Pause`
- lane planning via read-only Codex runs
- worker execution via write-enabled Codex runs
- real non-draft PR creation linked to numbered issues
- PR-cycle waiting, review follow-up, revalidation, and merge readiness
- a thin desktop control room for visibility and intervention

MVP does not need:

- deploy orchestration
- multi-repo support
- cloud-hosted execution
- long-lived shared session memory between agents
- rich analytics or roadmap views

### V1

V1 should make the system dependable enough to operate a live product backlog day to day.

V1 includes:

- stronger CoS sequencing and ranking
- better autonomous handling of review comments and failing checks
- richer lane ownership across parent/child issue slices
- more informative human escalation cards
- improved activity history and replayability
- a more expressive director note to issue-expansion loop

### Vx

The long-range version becomes a true operating system for an agent-run software organization.

Vx may include:

- multiple repos or products
- release orchestration and rollback awareness
- richer capacity and roadmap planning
- stronger memory and decision lineage
- more persistent lane agents
- better integration between product signals and backlog maintenance

## Product Boundaries

Director OS should automate bounded execution, not replace human product judgment.

If the decision is reversible and local, the system should usually make it.

If the decision is strategic, taste-sensitive, or costly to undo, the system should escalate it.
