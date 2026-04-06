export interface ProposedIssueTask {
  title: string;
  body: string;
  kind: string;
  execution_mode: string;
}

function parseDataString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseProposedIssueTasks(value: unknown): ProposedIssueTask[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }

    const title = parseDataString((entry as Record<string, unknown>).title);
    const body = parseDataString((entry as Record<string, unknown>).body);
    const kind = parseDataString((entry as Record<string, unknown>).kind);
    const executionMode = parseDataString((entry as Record<string, unknown>).execution_mode);

    if (!title || !body || !kind || !executionMode) {
      return [];
    }

    return [
      {
        title,
        body,
        kind,
        execution_mode: executionMode
      }
    ];
  });
}

export function extractLanePlanIssueTasks(
  data: Record<string, unknown> | null | undefined
): ProposedIssueTask[] {
  return parseProposedIssueTasks(data?.new_issues);
}
