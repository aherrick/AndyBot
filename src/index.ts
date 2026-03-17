import "dotenv/config";
import type { ModelReasoningEffort, SandboxMode } from "@openai/codex-sdk";
import { Bot, Context } from "grammy";
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
  type RepoInfo,
} from "./state.js";

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
    "repo all – list repos",
    "repo &lt;n&gt; – select a repo",
    "repo current – show selected repo",
    "repo reset – clear thread",
    "repo compact – compress thread",
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

function buildPrompt(repoName: string, repoPath: string, userMessage: string): string {
  return [
    `Repo: ${repoName}`,
    `Path: ${repoPath}`,
    "",
    "Be concise and practical. Inspect the repository in the current working directory.",
    "",
    userMessage,
  ].join("\n");
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
      "Then just type your question.",
    ].join("\n"),
    { parse_mode: "HTML" }
  )
);

bot.command("help", (ctx) =>
  ctx.reply(buildCommands(), { parse_mode: "HTML" })
);

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text) return ctx.reply("Send me a message.");

  const lower = text.toLowerCase();
  const state = loadState();
  const chat = getChatState(state, ctx.chat.id);

  try {
    // --- repo all ---
    if (lower === "repo all") {
      const repos = await getTopRepos(env.codeRoot, 15);
      if (!repos.length) return ctx.reply(`No git repos found under ${env.codeRoot}`);
      lastRepoLists.set(ctx.chat.id, repos);
      return replyLong(ctx, buildRepoList(repos, chat.selectedRepoPath), "HTML");
    }

    // --- repo current ---
    if (lower === "repo current") {
      if (!chat.selectedRepoName || !chat.selectedRepoPath)
        return ctx.reply("No repo selected. Run `repo all` then `repo <n>`.");
      const threadId = getThreadId(chat);
      return ctx.reply(
        [
          `Current repo: ${chat.selectedRepoName}`,
          chat.selectedRepoPath,
          `Thread: ${threadId ? "saved" : "none"}`,
        ].join("\n")
      );
    }

    // --- repo reset ---
    if (lower === "repo reset") {
      if (!chat.selectedRepoName) return ctx.reply("No repo selected.");
      clearThreadId(chat);
      saveState(state);
      return ctx.reply(`Cleared saved thread for ${chat.selectedRepoName}.`);
    }

    // --- repo compact ---
    if (lower === "repo compact") {
      if (!chat.selectedRepoName || !chat.selectedRepoPath)
        return ctx.reply("No repo selected.");
      const threadId = getThreadId(chat);
      if (!threadId) return ctx.reply("No saved thread yet for this repo.");

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
      return replyLong(ctx, `Fresh thread for ${chat.selectedRepoName}.\n\n${result.summary}`);
    }

    // --- repo <n> ---
    const numMatch = lower.match(/^repo\s+(\d{1,2})$/);
    if (numMatch) {
      const list = lastRepoLists.get(ctx.chat.id);
      if (!list?.length) return ctx.reply("Run `repo all` first.");
      const chosen = list.find((r) => r.index === Number(numMatch[1]));
      if (!chosen) return ctx.reply(`Pick 1–${list.length}.`);

      setSelectedRepo(chat, chosen.name, chosen.path);
      saveState(state);

      const hasThread = !!getThreadId(chat);
      return ctx.reply(
        `Using repo ${chosen.index}: ${chosen.name}\n${chosen.path}\n\n` +
          (hasThread ? "Resuming saved thread." : "No saved thread yet.")
      );
    }

    // --- Free-form message → Codex ---
    if (!chat.selectedRepoName || !chat.selectedRepoPath)
      return ctx.reply("Pick a repo first: `repo all` then `repo 1`.");

    await ctx.reply(`Thinking in ${chat.selectedRepoName}...`);

    const result = await runCodexInRepo(
      chat.selectedRepoPath,
      buildPrompt(chat.selectedRepoName, chat.selectedRepoPath, text),
      getThreadId(chat),
      env.codexReasoningEffort,
      env.codexSandboxMode,
      env.codexModel
    );

    if (result.threadId) {
      setThreadId(chat, result.threadId);
      saveState(state);
    }
    appendWorkLog({
      repoName: chat.selectedRepoName,
      repoPath: chat.selectedRepoPath,
      type: "message",
      request: truncate(text, 140),
      summary: truncate(result.text, 220),
    });

    await replyLong(ctx, result.text || "(No response)");
  } catch (error) {
    console.error(error);
    await ctx.reply(
      "Something failed. Check that git & Codex are installed and the selected repo exists."
    );
  }
});

bot.catch((err) => console.error("Bot error:", err.error));

console.log("Andy bot running…");
console.log(`Repo root: ${env.codeRoot}`);
console.log(`Codex reasoning effort: ${env.codexReasoningEffort}`);
console.log(`Codex sandbox mode: ${env.codexSandboxMode}`);
if (env.codexModel) console.log(`Codex model: ${env.codexModel}`);
bot.start();
