import type { SetupCheck, SetupStatusResponse } from "./api";

export interface SetupStateBadge {
  className: string;
  label: string;
}

export function hasCompletedSetup(
  status: Pick<SetupStatusResponse, "hasCompletedSetup"> | null
): boolean {
  return Boolean(status?.hasCompletedSetup);
}

export function deriveSetupStateBadge(status: SetupStatusResponse | null): SetupStateBadge {
  if (!status) {
    return {
      className: "engine-badge-neutral",
      label: "Checking setup"
    };
  }

  const blockingCheck = status.checks.find((check) => check.status !== "ready") ?? null;

  if (!status.hasCompletedSetup) {
    if (status.canComplete) {
      return {
        className: "engine-badge-ready",
        label: "Ready to finish"
      };
    }

    return deriveBadgeFromProblem(blockingCheck, {
      defaultClassName: "engine-badge-neutral",
      defaultLabel: "Setup pending",
      signInLabel: "Needs sign-in",
      blockedLabel: "Setup blocked",
      needsActionLabel: "Setup pending"
    });
  }

  if (status.completed) {
    return {
      className: "engine-badge-ready",
      label: "Control room ready"
    };
  }

  return deriveBadgeFromProblem(blockingCheck, {
    defaultClassName: "engine-badge-warning",
    defaultLabel: "Repair recommended",
    signInLabel: "Repair sign-in",
    blockedLabel: "Repair required",
    needsActionLabel: "Repair recommended"
  });
}

function deriveBadgeFromProblem(
  check: SetupCheck | null,
  labels: {
    defaultClassName: string;
    defaultLabel: string;
    signInLabel: string;
    blockedLabel: string;
    needsActionLabel: string;
  }
): SetupStateBadge {
  if (check?.code === "codex_sign_in_required" || check?.code === "gh_auth_required") {
    return {
      className: "engine-badge-warning",
      label: labels.signInLabel
    };
  }

  if (check?.status === "blocked") {
    return {
      className: "engine-badge-danger",
      label: labels.blockedLabel
    };
  }

  if (check?.status === "needs_action") {
    return {
      className: "engine-badge-warning",
      label: labels.needsActionLabel
    };
  }

  return {
    className: labels.defaultClassName,
    label: labels.defaultLabel
  };
}
