import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  planOpenClawModelsJsonWithDeps,
  resolveProvidersForModelsJsonWithDeps,
} from "./models-config.plan.test-support.js";

type ResolveImplicitProviders = NonNullable<
  NonNullable<
    Parameters<typeof resolveProvidersForModelsJsonWithDeps>[1]
  >["resolveImplicitProviders"]
>;

function model(id: string, input: Array<"text" | "image"> = ["text"]) {
  return {
    id,
    name: id,
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1024,
    maxTokens: 1024,
  };
}

describe("models config input presence", () => {
  it("keeps provider catalog config materialized while reporting source field presence", async () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "amazon-bedrock": {
            baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
            models: [model("vision-model"), model("text-only-model")],
          },
        },
      },
    };
    const sourceConfigForSecrets = {
      models: {
        providers: {
          "amazon-bedrock": {
            baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
            models: [
              { id: "vision-model", name: "vision-model" },
              { id: "text-only-model", name: "text-only-model", input: ["text"] },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolveImplicitProviders = vi.fn<ResolveImplicitProviders>(async () => ({}));

    await resolveProvidersForModelsJsonWithDeps(
      {
        cfg,
        sourceConfigForSecrets,
        agentDir: "/tmp/openclaw-model-input-presence",
        env: {},
      },
      { resolveImplicitProviders },
    );

    const params = resolveImplicitProviders.mock.calls[0]?.[0];
    expect(params?.config.models?.providers?.["amazon-bedrock"]?.models[0]?.input).toEqual([
      "text",
    ]);
    expect(params?.resolveModelInputConfigured?.("amazon-bedrock", "vision-model")).toBe(false);
    expect(params?.resolveModelInputConfigured?.("amazon-bedrock", "text-only-model")).toBe(true);
    expect(params?.resolveModelInputConfigured?.("amazon-bedrock", "custom-model")).toBeUndefined();
  });

  it.each([
    {
      name: "inherits discovered input when source input was omitted",
      sourceModel: { id: "vision-model", name: "vision-model" },
      expected: ["text", "image"],
    },
    {
      name: "preserves text-only input when source input was explicit",
      sourceModel: { id: "vision-model", name: "vision-model", input: ["text"] },
      expected: ["text"],
    },
  ] as const)("$name in the final generated models.json", async ({ sourceModel, expected }) => {
    const configuredProvider = {
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      apiKey: "AWS_PROFILE",
      models: [model("vision-model")],
    };
    const cfg: OpenClawConfig = {
      models: { providers: { "amazon-bedrock": configuredProvider } },
    };
    const sourceConfigForSecrets = {
      models: {
        providers: {
          "amazon-bedrock": {
            baseUrl: configuredProvider.baseUrl,
            apiKey: configuredProvider.apiKey,
            models: [sourceModel],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolveImplicitProviders = vi.fn<ResolveImplicitProviders>(async () => ({
      "amazon-bedrock": {
        ...configuredProvider,
        models: [model("vision-model", ["text", "image"])],
      },
    }));

    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg,
        sourceConfigForSecrets,
        agentDir: "/tmp/openclaw-model-input-presence",
        env: { AWS_PROFILE: "default" },
        existingRaw: "",
        existingParsed: {},
      },
      { resolveImplicitProviders },
    );

    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      throw new Error(`expected write plan, got ${plan.action}`);
    }
    const generated = JSON.parse(plan.contents) as {
      providers: Record<string, { models?: Array<{ input?: string[] }> }>;
    };
    expect(generated.providers["amazon-bedrock"]?.models?.[0]?.input).toEqual(expected);
  });
});
