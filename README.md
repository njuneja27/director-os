# Director OS

## What We Want To Do

Director OS is a product for running a software effort with a human at the level of direction, taste, and approval while AI agents handle most of the operating loop.

The goal is not "full autonomy." The goal is a human-directed agent organization where:

- the human director sets product direction, priorities, and high-stakes decisions
- a chief of staff agent turns messy intent into clear briefs and queues of work
- specialized agents decompose, plan, implement, review, and audit changes
- the system only interrupts the human when their judgment creates real leverage

In practice, the product should let a human say something like "onboarding feels weak" and have the system:

1. clarify the goal
2. turn it into a product brief
3. break that brief into issues
4. route work to execution agents
5. open real, non-draft PRs linked to numbered issues
6. review the work
7. return to the human only for approval, testing, or strategic guidance

### Desired Outcome

The human director should be able to steer a product in a small amount of time each day without managing implementation details.

### Success Criteria

- the director mostly interacts through approvals, testing, and advice requests
- agents move approved work from brief to merged PR with minimal human intervention
- work is tracked through durable artifacts instead of fragile chat history
- the executive inbox stays small, clear, and recommendation-first
- the system can run for long periods without product direction drifting

## How We Want To Do It

### Product Shape

Director OS should feel like an executive cockpit, not a task board. The primary user experience is:

- `Home`: a calm summary of what needs judgment, what shipped, what is blocked, and what agents are doing
- `Inbox`: decision-shaped requests such as approve, test, choose, advise
- `Intake`: a conversation between the human director and chief of staff that produces an approvable brief
- `Validation`: a guided place for the human to test important changes
- `Strategy`: a periodic review surface for priorities, risks, and proposed next work

### Operating Model

The system should be artifact-centered, not chat-centered. Agents may converse, but the real handoffs should be durable objects:

- `brief`
- `epic`
- `issue`
- `plan`
- `pr`
- `review`
- `director_task`

These objects should drive the workflow from intake through merge.

### Core Roles

- `Human director`: owns intent, priorities, taste, and irreversible decisions
- `Chief of staff`: owns intake, triage, issue readiness, assignment, escalation, and merge recommendation
- `Spec agent`: turns approved briefs into epics and child issues
- `Execution agents`: implement bounded work in code
- `Review agents`: review PRs for correctness, regressions, and missing tests
- `Audit agents`: periodically inspect UX, functionality, performance, and reliability to propose follow-up work

### Interaction Principles

- recommend actions instead of asking open-ended questions
- escalate ambiguity instead of bluffing through it
- keep the director out of routine operations
- show momentum and risk, not agent chatter
- make every director-facing item short, structured, and decision-ready

### Workflow

1. The human director and chief of staff discuss a product goal in Intake.
2. The chief of staff writes a `brief`.
3. The human director approves, revises, or rejects the brief.
4. The spec agent turns the approved brief into an `epic` and a set of `issues`.
5. The chief of staff sequences the work and moves issues into `ready`.
6. An execution agent creates a `plan`, gets approval if needed, implements the issue, and opens a real, non-draft PR linked to the numbered issue.
7. Review and audit agents inspect the PR and either pass it, request changes, or escalate to the director.
8. If human validation is needed, the system creates a `director_task` such as test this flow or choose between options.
9. After review passes, the chief of staff merges the PR.
10. After a PR is opened, the system should wait for automated review feedback before considering the work fully complete.

### Initial Technical Direction

The first implementation should bias toward simplicity:

- GitHub is the control plane for issues, PRs, and linked work items
- Director OS is the orchestration and UI layer on top
- a small set of structured templates define briefs, issues, plans, reviews, and director tasks
- agent runs should be inspectable and replayable
- product memory should live in durable docs and policies, not only prompt history

## Scope

### MVP

The MVP should prove that the product is useful for one human director and one software project.

MVP includes:

- a single-project workspace
- `Home`, `Inbox`, and `Intake` as the first three screens
- brief creation and approval
- epic and issue decomposition from an approved brief
- issue states such as `ready`, `in_progress`, `in_review`, `blocked`, and `done`
- GitHub sync for issues and PRs
- real, non-draft PR creation linked to numbered issues
- review summaries and merge recommendations
- a director inbox with at least these task types:
  - approve brief
  - answer product question
  - test flow
  - approve release or merge

MVP does not need:

- full autonomous deployment
- deep analytics integration
- multi-repo orchestration
- sophisticated budgeting or capacity planning
- many agent specialties beyond the core operating loop

### V1

V1 should make the system feel dependable enough to use as a real operating layer for an active product.

V1 includes:

- `Validation` and `Strategy` screens
- reusable templates for briefs, issues, plans, reviews, and director tasks
- stronger routing between frontend, backend, and review agents
- dependency-aware issue sequencing
- periodic audit digests for UX, functionality, performance, and reliability
- merge gating based on reviews, checks, and policy
- lightweight shared memory for product context, architecture context, and decisions
- better visibility into why agents made specific recommendations

### Vx

Vx is the long-range vision where Director OS becomes a real operating system for an agent-run software organization.

Vx may include:

- multiple products or repositories under one director view
- richer planning across roadmap, capacity, and release windows
- experiment loops tied to usage data and outcomes
- deployment orchestration with rollback awareness
- automatic backlog pruning and priority maintenance
- long-lived agent memory with explicit decision lineage
- support for different org shapes, such as multiple chiefs of staff or dedicated release managers

## Product Boundaries

Director OS is not trying to replace human product judgment. It is trying to compress execution overhead so the human can stay focused on the decisions that matter most.

If a decision is reversible and bounded, the system should usually make it.

If a decision is strategic, ambiguous, or costly to undo, the system should escalate it to the human director.
