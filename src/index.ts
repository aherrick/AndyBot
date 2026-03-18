import "dotenv/config";
import path from "node:path";
import { Bot, type Context } from "grammy";
import type { Message } from "grammy/types";
import { loadConfig } from "./config.js";
import { createCodexHandler } from "./codex-handler.js";
import { logError, logInfo } from "./logger.js";
import { REQUEST_FAILURE_REPLY, UNSUPPORTED_REQUEST_REPLY } from "./messages.js";
import { createRepoCommandHandler } from "./repo-commands.js";
import { getChatState, loadState, type RepoInfo } from "./state.js";
import {
  DEFAULT_MEDIA_GROUP_SETTLE_MS,
  MediaGroupCollector,
  buildTelegramRequest,
  extractTelegramImages,
  getChatId,
  isBotCommandMessage,
} from "./telegram-input.js";
import { buildCommands } from "./ui.js";

const TELEGRAM_MEDIA_ROOT = path.resolve("data", "telegram-media");
const env = loadConfig();

if (!env.telegramBotToken) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");

const lastRepoLists = new Map<number, RepoInfo[]>();
const mediaGroupCollector = new MediaGroupCollector(DEFAULT_MEDIA_GROUP_SETTLE_MS);

const handleRepoCommand = createRepoCommandHandler({
  codeRoot: env.codeRoot,
  reasoningEffort: env.codexReasoningEffort,
  sandboxMode: env.codexSandboxMode,
  model: env.codexModel,
  lastRepoLists,
});

const handleCodexRequest = createCodexHandler({
  botToken: env.telegramBotToken,
  mediaRoot: TELEGRAM_MEDIA_ROOT,
  reasoningEffort: env.codexReasoningEffort,
  sandboxMode: env.codexSandboxMode,
  model: env.codexModel,
});

const bot = new Bot(env.telegramBotToken);

async function replyWithFailure(ctx: Context, error: unknown): Promise<void> {
  logError("Request failed", error);
  await ctx.reply(REQUEST_FAILURE_REPLY);
}

async function handleMessageBatch(ctx: Context, messages: Message[]): Promise<void> {
  const request = buildTelegramRequest(messages);
  if (!request.text && !request.images.length) {
    await ctx.reply(UNSUPPORTED_REQUEST_REPLY);
    return;
  }

  const state = loadState();
  const chat = getChatState(state, getChatId(ctx));

  if (messages.length === 1 && !request.images.length && request.text) {
    const handled = await handleRepoCommand(ctx, request.text, state, chat);
    if (handled) return;
  }

  await handleCodexRequest(ctx, request, state, chat);
}

async function handleMessageBatchSafe(ctx: Context, messages: Message[]): Promise<void> {
  try {
    await handleMessageBatch(ctx, messages);
  } catch (error) {
    await replyWithFailure(ctx, error);
  }
}

bot.command("start", (ctx) =>
  ctx.reply(
    [
      "Andy bot is up.",
      "",
      buildCommands(),
      "",
      "Then send a question, a photo, or an album of images.",
    ].join("\n"),
    { parse_mode: "HTML" }
  )
);

bot.command("help", (ctx) =>
  ctx.reply(
    [buildCommands(), "", "You can also send a photo or an album with an optional caption."].join(
      "\n"
    ),
    { parse_mode: "HTML" }
  )
);

bot.on("message", async (ctx) => {
  if (isBotCommandMessage(ctx.message)) return;

  if (ctx.message.media_group_id) {
    if (extractTelegramImages(ctx.message).length) {
      mediaGroupCollector.queue(ctx, async (groupCtx, groupMessages) => {
        await handleMessageBatchSafe(groupCtx, groupMessages);
      });
    }
    return;
  }

  await handleMessageBatchSafe(ctx, [ctx.message]);
});

bot.catch((err) => logError("Bot error", err.error));

logInfo("Andy bot running...");
logInfo(`Repo root: ${env.codeRoot}`);
logInfo(`Codex reasoning effort: ${env.codexReasoningEffort}`);
logInfo(`Codex sandbox mode: ${env.codexSandboxMode}`);
if (env.codexModel) logInfo(`Codex model: ${env.codexModel}`);
bot.start();
