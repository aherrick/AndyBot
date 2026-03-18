import type { ModelReasoningEffort, SandboxMode } from "@openai/codex-sdk";
import type { Context } from "grammy";
import { compactRepoThread } from "./codex.js";
import { getTopRepos } from "./repos.js";
import {
  appendWorkLog,
  clearThreadId,
  getThreadId,
  saveState,
  setSelectedRepo,
  setThreadId,
  type ChatState,
  type PersistedState,
  type RepoInfo,
} from "./state.js";
import { getChatId } from "./telegram-input.js";
import { buildRepoList, replyLong, truncate } from "./ui.js";

type RepoCommandHandlerDeps = {
  codeRoot: string;
  reasoningEffort: ModelReasoningEffort;
  sandboxMode: SandboxMode;
  model?: string;
  lastRepoLists: Map<number, RepoInfo[]>;
};

type RepoCommandArgs = {
  ctx: Context;
  state: PersistedState;
  chat: ChatState;
  chatId: number;
};

type RepoCommand = (args: RepoCommandArgs) => Promise<void>;

export function createRepoCommandHandler(deps: RepoCommandHandlerDeps) {
  const commandMap: Record<string, RepoCommand> = {
    "repo all": async ({ ctx, chat, chatId }) => {
      const repos = await getTopRepos(deps.codeRoot, 15);
      if (!repos.length) {
        await ctx.reply(`No git repos found under ${deps.codeRoot}`);
        return;
      }

      deps.lastRepoLists.set(chatId, repos);
      await replyLong(ctx, buildRepoList(repos, deps.codeRoot, chat.selectedRepoPath), "HTML");
    },
    "repo current": async ({ ctx, chat }) => {
      if (!chat.selectedRepoName || !chat.selectedRepoPath) {
        await ctx.reply("No repo selected. Run `repo all` then `repo <n>`.");
        return;
      }

      const threadId = getThreadId(chat);
      await ctx.reply(
        [
          `Current repo: ${chat.selectedRepoName}`,
          chat.selectedRepoPath,
          `Thread: ${threadId ? "saved" : "none"}`,
        ].join("\n")
      );
    },
    "repo reset": async ({ ctx, state, chat }) => {
      if (!chat.selectedRepoName) {
        await ctx.reply("No repo selected.");
        return;
      }

      clearThreadId(chat);
      saveState(state);
      await ctx.reply(`Cleared saved thread for ${chat.selectedRepoName}.`);
    },
    "repo compact": async ({ ctx, state, chat }) => {
      if (!chat.selectedRepoName || !chat.selectedRepoPath) {
        await ctx.reply("No repo selected.");
        return;
      }

      const threadId = getThreadId(chat);
      if (!threadId) {
        await ctx.reply("No saved thread yet for this repo.");
        return;
      }

      await ctx.reply(`Compacting thread for ${chat.selectedRepoName}...`);
      const result = await compactRepoThread(
        chat.selectedRepoPath,
        chat.selectedRepoName,
        threadId,
        deps.reasoningEffort,
        deps.sandboxMode,
        deps.model
      );

      if (result.newThreadId) {
        setThreadId(chat, result.newThreadId);
        saveState(state);
      }

      appendWorkLog({
        repoName: chat.selectedRepoName,
        repoPath: chat.selectedRepoPath,
        type: "compact",
        summary: truncate(result.summary, 220),
      });

      await replyLong(ctx, `Fresh thread for ${chat.selectedRepoName}.\n\n${result.summary}`);
    },
  };

  return async function handleRepoCommand(
    ctx: Context,
    text: string,
    state: PersistedState,
    chat: ChatState
  ): Promise<boolean> {
    const lower = text.trim().toLowerCase();
    const chatId = getChatId(ctx);
    const command = commandMap[lower];

    if (command) {
      await command({ ctx, state, chat, chatId });
      return true;
    }

    const numMatch = lower.match(/^repo\s+(\d{1,2})$/);
    if (!numMatch) return false;

    const list = deps.lastRepoLists.get(chatId);
    if (!list?.length) {
      await ctx.reply("Run `repo all` first.");
      return true;
    }

    const chosen = list.find((repo) => repo.index === Number(numMatch[1]));
    if (!chosen) {
      await ctx.reply(`Pick 1-${list.length}.`);
      return true;
    }

    setSelectedRepo(chat, chosen.name, chosen.path);
    saveState(state);

    const hasThread = !!getThreadId(chat);
    await ctx.reply(
      `Using repo ${chosen.index}: ${chosen.name}\n${chosen.path}\n\n` +
        (hasThread ? "Resuming saved thread." : "No saved thread yet.")
    );
    return true;
  };
}
