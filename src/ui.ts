import { Context } from "grammy";
import type { RepoInfo } from "./state.js";
import type { TelegramRequest } from "./telegram-input.js";

export function splitMessage(text: string, max = 3500): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += max) chunks.push(text.slice(i, i + max));
  return chunks;
}

export async function replyLong(ctx: Context, text: string, parseMode?: "HTML"): Promise<void> {
  for (const chunk of splitMessage(text)) {
    await ctx.reply(chunk, parseMode ? { parse_mode: parseMode } : undefined);
  }
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
}

export function buildCommands(): string {
  return [
    "repo all - list repos",
    "repo &lt;n&gt; - select a repo",
    "repo current - show selected repo",
    "repo reset - clear thread",
    "repo compact - compress thread",
  ].join("\n");
}

export function buildRepoList(repos: RepoInfo[], codeRoot: string, selectedPath?: string): string {
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
    `<b>Top ${repos.length} repos under ${codeRoot}:</b>\n` +
    `<pre>${rows.join("\n")}</pre>\n` +
    `<b>Commands:</b>\n<pre>${commands}</pre>`
  );
}

export function buildPrompt(
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

export function describeIncomingRequest(request: TelegramRequest): string {
  const imageLabel = request.images.length
    ? `${request.images.length} image${request.images.length === 1 ? "" : "s"}`
    : "";

  if (request.text && imageLabel) return `${truncate(request.text, 100)} + ${imageLabel}`;
  if (request.text) return truncate(request.text, 100);
  return imageLabel || "(empty request)";
}

export function buildThinkingMessage(repoName: string, imageCount: number): string {
  if (!imageCount) return `Thinking in ${repoName}...`;
  return `Thinking in ${repoName} with ${imageCount} image${imageCount === 1 ? "" : "s"}...`;
}
