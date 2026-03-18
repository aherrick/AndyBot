import type { Input, ModelReasoningEffort, SandboxMode } from "@openai/codex-sdk";
import type { Context } from "grammy";
import { runCodexInRepo } from "./codex.js";
import { PICK_REPO_REPLY } from "./messages.js";
import {
  appendWorkLog,
  getThreadId,
  saveState,
  setThreadId,
  type ChatState,
  type PersistedState,
} from "./state.js";
import {
  cleanupDownloadedImages,
  downloadTelegramImages,
  type TelegramRequest,
} from "./telegram-input.js";
import {
  buildPrompt,
  buildThinkingMessage,
  describeIncomingRequest,
  replyLong,
  truncate,
} from "./ui.js";

type CodexHandlerDeps = {
  botToken: string;
  mediaRoot: string;
  reasoningEffort: ModelReasoningEffort;
  sandboxMode: SandboxMode;
  model?: string;
};

type PreparedCodexInput = {
  input: Input;
  additionalDirectories: string[];
  cleanup: () => Promise<void>;
};

function buildCodexInput(
  repoName: string,
  repoPath: string,
  request: TelegramRequest,
  imagePaths: string[]
): Input {
  const prompt = buildPrompt(repoName, repoPath, request.text, imagePaths.length);
  if (!imagePaths.length) return prompt;

  return [
    { type: "text", text: prompt },
    ...imagePaths.map((imagePath) => ({ type: "local_image" as const, path: imagePath })),
  ];
}

async function prepareCodexInput(
  ctx: Context,
  request: TelegramRequest,
  repoName: string,
  repoPath: string,
  deps: CodexHandlerDeps
): Promise<PreparedCodexInput> {
  const downloaded = await downloadTelegramImages(ctx, request.images, deps.botToken, deps.mediaRoot);

  return {
    input: buildCodexInput(repoName, repoPath, request, downloaded?.paths ?? []),
    additionalDirectories: downloaded ? [downloaded.directory] : [],
    cleanup: async () => cleanupDownloadedImages(downloaded),
  };
}

export function createCodexHandler(deps: CodexHandlerDeps) {
  return async function handleCodexRequest(
    ctx: Context,
    request: TelegramRequest,
    state: PersistedState,
    chat: ChatState
  ): Promise<void> {
    if (!chat.selectedRepoName || !chat.selectedRepoPath) {
      await ctx.reply(PICK_REPO_REPLY);
      return;
    }

    await ctx.reply(buildThinkingMessage(chat.selectedRepoName, request.images.length));
    const prepared = await prepareCodexInput(
      ctx,
      request,
      chat.selectedRepoName,
      chat.selectedRepoPath,
      deps
    );

    try {
      const result = await runCodexInRepo(
        chat.selectedRepoPath,
        prepared.input,
        getThreadId(chat),
        deps.reasoningEffort,
        deps.sandboxMode,
        deps.model,
        prepared.additionalDirectories
      );

      if (result.threadId) {
        setThreadId(chat, result.threadId);
        saveState(state);
      }

      appendWorkLog({
        repoName: chat.selectedRepoName,
        repoPath: chat.selectedRepoPath,
        type: "message",
        request: truncate(describeIncomingRequest(request), 140),
        summary: truncate(result.text, 220),
      });

      await replyLong(ctx, result.text || "(No response)");
    } finally {
      await prepared.cleanup();
    }
  };
}
