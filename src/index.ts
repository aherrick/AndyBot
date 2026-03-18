import "dotenv/config";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Input, ModelReasoningEffort, SandboxMode } from "@openai/codex-sdk";
import { Bot, Context } from "grammy";
import type { Message } from "grammy/types";
import { compactRepoThread, runCodexInRepo } from "./codex.js";
import { getTopRepos } from "./repos.js";
import {
  appendWorkLog,
  clearThreadId,
  getChatState,
  getThreadId,
  loadState,
  saveState,
  setSelectedRepo,
  setThreadId,
  type ChatState,
  type PersistedState,
  type RepoInfo,
} from "./state.js";

type TelegramImageRef = {
  fileId: string;
};

type TelegramRequest = {
  text: string;
  images: TelegramImageRef[];
};

type DownloadedImages = {
  directory: string;
  paths: string[];
};

type PendingMediaGroup = {
  ctx: Context;
  messages: Message[];
  timer?: NodeJS.Timeout;
};

const TELEGRAM_MEDIA_ROOT = path.resolve("data", "telegram-media");
const MEDIA_GROUP_SETTLE_MS = 1200;

// --- Config ---

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

const env = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "",
  codeRoot: process.env.CODE_ROOT?.trim() || "C:\\code",
  codexReasoningEffort: parseReasoningEffort(process.env.CODEX_REASONING_EFFORT),
  codexSandboxMode: parseSandboxMode(process.env.CODEX_SANDBOX_MODE),
  codexModel: process.env.CODEX_MODEL?.trim(),
};

if (!env.telegramBotToken) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");

// --- Helpers ---

const lastRepoLists = new Map<number, RepoInfo[]>();
const pendingMediaGroups = new Map<string, PendingMediaGroup>();

function splitMessage(text: string, max = 3500): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += max) chunks.push(text.slice(i, i + max));
  return chunks;
}

async function replyLong(ctx: Context, text: string, parseMode?: "HTML"): Promise<void> {
  for (const chunk of splitMessage(text))
    await ctx.reply(chunk, parseMode ? { parse_mode: parseMode } : undefined);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
}

function buildCommands(): string {
  return [
    "repo all - list repos",
    "repo &lt;n&gt; - select a repo",
    "repo current - show selected repo",
    "repo reset - clear thread",
    "repo compact - compress thread",
  ].join("\n");
}

function buildRepoList(repos: RepoInfo[], selectedPath?: string): string {
  const nameWidth = Math.max(...repos.map((r) => r.name.length), 4);
  const rows = repos.map((r) => {
    const tag = r.path === selectedPath ? " *" : "  ";
    const num = String(r.index).padStart(2);
    const name = r.name.padEnd(nameWidth);
    return `${num}. ${name}  ${r.lastCommitText}${tag}`;
  });
  const commands = buildCommands()
    .split("\n")
    .map((c) => `  ${c}`)
    .join("\n");
  return (
    `<b>Top ${repos.length} repos under ${env.codeRoot}:</b>\n` +
    `<pre>${rows.join("\n")}</pre>\n` +
    `<b>Commands:</b>\n<pre>${commands}</pre>`
  );
}

function buildPrompt(
  repoName: string,
  repoPath: string,
  userMessage: string,
  imageCount = 0
): string {
  const requestText =
    userMessage.trim() ||
    (imageCount
      ? `The Telegram request included ${imageCount} attached image(s) and no text. Use the images to understand the request and respond helpfully.`
      : "Respond helpfully to the user's request.");

  return [
    `Repo: ${repoName}`,
    `Path: ${repoPath}`,
    "",
    "Be concise and practical. Inspect the repository in the current working directory.",
    imageCount ? `The Telegram request includes ${imageCount} attached image(s). Use them as part of your answer.` : "",
    "",
    requestText,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCodexInput(
  repoName: string,
  repoPath: string,
  requestText: string,
  imagePaths: string[]
): Input {
  const prompt = buildPrompt(repoName, repoPath, requestText, imagePaths.length);
  if (!imagePaths.length) return prompt;

  return [
    { type: "text", text: prompt },
    ...imagePaths.map((imagePath) => ({ type: "local_image" as const, path: imagePath })),
  ];
}

function getMessageText(message: Message): string {
  return (message.text ?? message.caption ?? "").trim();
}

function isBotCommandMessage(message: Message): boolean {
  if (!message.text?.trim()) return false;
  return !!message.entities?.some((entity) => entity.type === "bot_command" && entity.offset === 0);
}

function getLargestPhoto(message: Message) {
  return message.photo?.at(-1);
}

function isImageDocument(message: Message): boolean {
  if (!message.document) return false;

  const mimeType = message.document.mime_type?.toLowerCase();
  return !!mimeType?.startsWith("image/");
}

function extractTelegramImages(message: Message): TelegramImageRef[] {
  const photo = getLargestPhoto(message);
  if (photo) return [{ fileId: photo.file_id }];

  if (isImageDocument(message) && message.document) {
    return [{ fileId: message.document.file_id }];
  }

  return [];
}

function buildTelegramRequest(messages: Message[]): TelegramRequest {
  const sorted = [...messages].sort((a, b) => a.message_id - b.message_id);
  const seenText = new Set<string>();
  const textParts: string[] = [];

  for (const message of sorted) {
    const text = getMessageText(message);
    if (text && !seenText.has(text)) {
      seenText.add(text);
      textParts.push(text);
    }
  }

  return {
    text: textParts.join("\n\n"),
    images: sorted.flatMap(extractTelegramImages),
  };
}

function describeIncomingRequest(request: TelegramRequest): string {
  const imageLabel = request.images.length
    ? `${request.images.length} image${request.images.length === 1 ? "" : "s"}`
    : "";

  if (request.text && imageLabel) return `${truncate(request.text, 100)} + ${imageLabel}`;
  if (request.text) return truncate(request.text, 100);
  return imageLabel || "(empty request)";
}

function buildThinkingMessage(repoName: string, imageCount: number): string {
  if (!imageCount) return `Thinking in ${repoName}...`;
  return `Thinking in ${repoName} with ${imageCount} image${imageCount === 1 ? "" : "s"}...`;
}

function pickDownloadedImageExtension(filePath?: string): string {
  const extension = path.extname(filePath ?? "").toLowerCase();
  return extension || ".jpg";
}

function getChatId(ctx: Context): number {
  const chatId = ctx.chat?.id;
  if (chatId == null) throw new Error("Telegram message is missing a chat id.");
  return chatId;
}

async function downloadTelegramImages(
  ctx: Context,
  images: TelegramImageRef[]
): Promise<DownloadedImages | undefined> {
  if (!images.length) return undefined;

  const directory = path.join(TELEGRAM_MEDIA_ROOT, `${Date.now()}-${randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });

  try {
    const paths: string[] = [];

    for (const [index, image] of images.entries()) {
      const file = await ctx.api.getFile(image.fileId);
      if (!file.file_path) throw new Error(`Telegram did not return a file path for ${image.fileId}`);

      const response = await fetch(
        `https://api.telegram.org/file/bot${env.telegramBotToken}/${file.file_path}`
      );
      if (!response.ok) {
        throw new Error(`Telegram download failed with status ${response.status}`);
      }

      const filePath = path.join(
        directory,
        `${String(index + 1).padStart(2, "0")}${pickDownloadedImageExtension(file.file_path)}`
      );

      await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
      paths.push(filePath);
    }

    return { directory, paths };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function cleanupDownloadedImages(downloaded?: DownloadedImages): Promise<void> {
  if (!downloaded) return;
  await fs.rm(downloaded.directory, { recursive: true, force: true });
}

async function handleRepoCommand(
  ctx: Context,
  text: string,
  state: PersistedState,
  chat: ChatState
): Promise<boolean> {
  const lower = text.trim().toLowerCase();
  const chatId = getChatId(ctx);

  if (lower === "repo all") {
    const repos = await getTopRepos(env.codeRoot, 15);
    if (!repos.length) {
      await ctx.reply(`No git repos found under ${env.codeRoot}`);
      return true;
    }

    lastRepoLists.set(chatId, repos);
    await replyLong(ctx, buildRepoList(repos, chat.selectedRepoPath), "HTML");
    return true;
  }

  if (lower === "repo current") {
    if (!chat.selectedRepoName || !chat.selectedRepoPath) {
      await ctx.reply("No repo selected. Run `repo all` then `repo <n>`.");
      return true;
    }

    const threadId = getThreadId(chat);
    await ctx.reply(
      [
        `Current repo: ${chat.selectedRepoName}`,
        chat.selectedRepoPath,
        `Thread: ${threadId ? "saved" : "none"}`,
      ].join("\n")
    );
    return true;
  }

  if (lower === "repo reset") {
    if (!chat.selectedRepoName) {
      await ctx.reply("No repo selected.");
      return true;
    }

    clearThreadId(chat);
    saveState(state);
    await ctx.reply(`Cleared saved thread for ${chat.selectedRepoName}.`);
    return true;
  }

  if (lower === "repo compact") {
    if (!chat.selectedRepoName || !chat.selectedRepoPath) {
      await ctx.reply("No repo selected.");
      return true;
    }

    const threadId = getThreadId(chat);
    if (!threadId) {
      await ctx.reply("No saved thread yet for this repo.");
      return true;
    }

    await ctx.reply(`Compacting thread for ${chat.selectedRepoName}...`);
    const result = await compactRepoThread(
      chat.selectedRepoPath,
      chat.selectedRepoName,
      threadId,
      env.codexReasoningEffort,
      env.codexSandboxMode,
      env.codexModel
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
    return true;
  }

  const numMatch = lower.match(/^repo\s+(\d{1,2})$/);
  if (numMatch) {
    const list = lastRepoLists.get(chatId);
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
  }

  return false;
}

async function handleCodexRequest(
  ctx: Context,
  request: TelegramRequest,
  state: PersistedState,
  chat: ChatState
): Promise<void> {
  if (!chat.selectedRepoName || !chat.selectedRepoPath) {
    await ctx.reply("Pick a repo first: `repo all` then `repo 1`.");
    return;
  }

  let downloaded: DownloadedImages | undefined;

  try {
    await ctx.reply(buildThinkingMessage(chat.selectedRepoName, request.images.length));
    downloaded = await downloadTelegramImages(ctx, request.images);

    const result = await runCodexInRepo(
      chat.selectedRepoPath,
      buildCodexInput(
        chat.selectedRepoName,
        chat.selectedRepoPath,
        request.text,
        downloaded?.paths ?? []
      ),
      getThreadId(chat),
      env.codexReasoningEffort,
      env.codexSandboxMode,
      env.codexModel,
      downloaded ? [downloaded.directory] : []
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
    await cleanupDownloadedImages(downloaded);
  }
}

async function handleMessageBatch(ctx: Context, messages: Message[]): Promise<void> {
  const request = buildTelegramRequest(messages);
  if (!request.text && !request.images.length) {
    await ctx.reply("Send a text message or an image with an optional caption.");
    return;
  }

  const state = loadState();
  const chat = getChatState(state, getChatId(ctx));

  if (messages.length === 1 && !request.images.length && request.text) {
    const handledCommand = await handleRepoCommand(ctx, request.text, state, chat);
    if (handledCommand) return;
  }

  await handleCodexRequest(ctx, request, state, chat);
}

function queueMediaGroup(ctx: Context): void {
  const message = ctx.message;
  const mediaGroupId = message?.media_group_id;
  if (!message || !mediaGroupId) return;

  const key = `${getChatId(ctx)}:${mediaGroupId}`;
  const pending = pendingMediaGroups.get(key) ?? { ctx, messages: [] };

  pending.ctx = ctx;
  pending.messages.push(message);

  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    pendingMediaGroups.delete(key);
    void handleMessageBatch(pending.ctx, pending.messages).catch(async (error) => {
      console.error(error);
      await pending.ctx.reply(
        "Something failed. Check that git and Codex are installed and the selected repo exists."
      );
    });
  }, MEDIA_GROUP_SETTLE_MS);

  pendingMediaGroups.set(key, pending);
}

// --- Bot ---

const bot = new Bot(env.telegramBotToken);

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

  try {
    if (ctx.message.media_group_id) {
      if (extractTelegramImages(ctx.message).length) queueMediaGroup(ctx);
      return;
    }

    await handleMessageBatch(ctx, [ctx.message]);
  } catch (error) {
    console.error(error);
    await ctx.reply(
      "Something failed. Check that git and Codex are installed and the selected repo exists."
    );
  }
});

bot.catch((err) => console.error("Bot error:", err.error));

console.log("Andy bot running...");
console.log(`Repo root: ${env.codeRoot}`);
console.log(`Codex reasoning effort: ${env.codexReasoningEffort}`);
console.log(`Codex sandbox mode: ${env.codexSandboxMode}`);
if (env.codexModel) console.log(`Codex model: ${env.codexModel}`);
bot.start();
