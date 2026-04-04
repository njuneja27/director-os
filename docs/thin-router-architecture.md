# Thin Router Architecture

Director OS is moving from a local workflow engine to a thin routing layer on top of Codex CLI and GitHub.

## Keep

- local setup and repository readiness checks
- GitHub issue and pull request sync
- Codex CLI as the only agent runtime
- a single local ownership lock for the running orchestrator loop
- one human-facing Chief of Staff conversation

## Replace

- SQLite workflow tables such as `work_items`, `decisions`, `pr_cycles`, and `runs`
- local work-item taxonomy and queue state as the primary model
- custom planning objects and planning state
- direct worker-to-human escalation paths

These are replaced by a small file-backed router registry that stores only the operational state needed to recover routing:

- active project metadata
- Chief of Staff Codex session id
- lane Codex session ids and lane metadata
- one open human-facing blocker question
- pending handoffs between CoS and lanes
- last successful GitHub sync timestamp

## Durable Systems

- GitHub issues and pull requests are the durable work queue
- Codex sessions are the durable agent context
- local files are only for routing and recovery

## Target Flow

1. The human talks only to the Chief of Staff.
2. The Chief of Staff chooses or accepts the next GitHub issue.
3. The router assigns the issue to the CoS directly or to a lane session.
4. Lanes use Codex native planning or implementation in their own persistent sessions.
5. Any blocker returns to the CoS first.
6. Only the CoS can open a human-facing question, and only one can be open at a time.

## Migration Notes

- SQLite can remain temporarily for migration or inspection, but normal runtime flow should not depend on it.
- User-facing surfaces should show CoS chat first and lane visibility second.
- PRs should stay small and linked to the GitHub issues they implement.
