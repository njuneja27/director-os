import { describe, expect, it } from "vitest";

import { codexOutputSchema } from "./agents.js";

describe("codexOutputSchema", () => {
  it("requires every top-level property that it declares", () => {
    expect([...codexOutputSchema.required].sort()).toEqual(
      Object.keys(codexOutputSchema.properties).sort()
    );
  });

  it("uses a strict nested data schema that satisfies Codex structured output requirements", () => {
    const dataSchema = (
      codexOutputSchema.properties as {
        data: {
          additionalProperties: boolean;
          properties: Record<string, unknown>;
          required: string[];
        };
      }
    ).data;

    expect(dataSchema.additionalProperties).toBe(false);
    expect([...dataSchema.required].sort()).toEqual(
      Object.keys(dataSchema.properties).sort()
    );
  });

  it("does not expose the legacy child_tasks planning field", () => {
    const dataSchema = (
      codexOutputSchema.properties as {
        data: {
          properties: Record<string, unknown>;
          required: string[];
        };
      }
    ).data;

    expect(dataSchema.properties).not.toHaveProperty("child_tasks");
    expect(dataSchema.required).not.toContain("child_tasks");
  });
});
