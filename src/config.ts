import type { ModelReasoningEffort, SandboxMode } from "@openai/codex-sdk";

export type AppConfig = {
  telegramBotToken: string;
  codeRoot: string;
  codexReasoningEffort: ModelReasoningEffort;
  codexSandboxMode: SandboxMode;
  codexModel?: string;
};

function parseReasoningEffort(value?: string): ModelReasoningEffort {
  switch (value?.trim().toLowerCase()) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value.trim().toLowerCase() as ModelReasoningEffort;
    default:
      return "medium";
  }
}

function parseSandboxMode(value?: string): SandboxMode {
  switch (value?.trim().toLowerCase()) {
    case "read-only":
    case "workspace-write":
    case "danger-full-access":
      return value.trim().toLowerCase() as SandboxMode;
    default:
      return "read-only";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() ?? "",
    codeRoot: env.CODE_ROOT?.trim() || "C:\\code",
    codexReasoningEffort: parseReasoningEffort(env.CODEX_REASONING_EFFORT),
    codexSandboxMode: parseSandboxMode(env.CODEX_SANDBOX_MODE),
    codexModel: env.CODEX_MODEL?.trim(),
  };
}
