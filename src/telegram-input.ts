import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Context } from "grammy";
import type { Message } from "grammy/types";

export const DEFAULT_MEDIA_GROUP_SETTLE_MS = 1200;

export type TelegramImageRef = {
  fileId: string;
};

export type TelegramRequest = {
  text: string;
  images: TelegramImageRef[];
};

export type DownloadedImages = {
  directory: string;
  paths: string[];
};

type PendingMediaGroup = {
  ctx: Context;
  messages: Message[];
  timer?: NodeJS.Timeout;
};

export function getChatId(ctx: Context): number {
  const chatId = ctx.chat?.id;
  if (chatId == null) throw new Error("Telegram message is missing a chat id.");
  return chatId;
}

function getMessageText(message: Message): string {
  return (message.text ?? message.caption ?? "").trim();
}

function getLargestPhoto(message: Message) {
  return message.photo?.at(-1);
}

function isImageDocument(message: Message): boolean {
  if (!message.document) return false;
  const mimeType = message.document.mime_type?.toLowerCase();
  return !!mimeType?.startsWith("image/");
}

function pickDownloadedImageExtension(filePath?: string): string {
  const extension = path.extname(filePath ?? "").toLowerCase();
  return extension || ".jpg";
}

export function isBotCommandMessage(message: Message): boolean {
  if (!message.text?.trim()) return false;
  return !!message.entities?.some((entity) => entity.type === "bot_command" && entity.offset === 0);
}

export function extractTelegramImages(message: Message): TelegramImageRef[] {
  const photo = getLargestPhoto(message);
  if (photo) return [{ fileId: photo.file_id }];

  if (isImageDocument(message) && message.document) {
    return [{ fileId: message.document.file_id }];
  }

  return [];
}

export function buildTelegramRequest(messages: Message[]): TelegramRequest {
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

export async function downloadTelegramImages(
  ctx: Context,
  images: TelegramImageRef[],
  botToken: string,
  mediaRoot: string
): Promise<DownloadedImages | undefined> {
  if (!images.length) return undefined;

  const directory = path.join(mediaRoot, `${Date.now()}-${randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });

  try {
    const paths: string[] = [];

    for (const [index, image] of images.entries()) {
      const file = await ctx.api.getFile(image.fileId);
      if (!file.file_path) throw new Error(`Telegram did not return a file path for ${image.fileId}`);

      const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
      if (!response.ok) throw new Error(`Telegram download failed with status ${response.status}`);

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

export async function cleanupDownloadedImages(downloaded?: DownloadedImages): Promise<void> {
  if (!downloaded) return;
  await fs.rm(downloaded.directory, { recursive: true, force: true });
}

export class MediaGroupCollector {
  private readonly pending = new Map<string, PendingMediaGroup>();

  constructor(private readonly settleMs = DEFAULT_MEDIA_GROUP_SETTLE_MS) {}

  queue(
    ctx: Context,
    onReady: (ctx: Context, messages: Message[]) => Promise<void>
  ): boolean {
    const message = ctx.message;
    const mediaGroupId = message?.media_group_id;
    if (!message || !mediaGroupId) return false;

    const key = `${getChatId(ctx)}:${mediaGroupId}`;
    const pending = this.pending.get(key) ?? { ctx, messages: [] };

    pending.ctx = ctx;
    pending.messages.push(message);

    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      this.pending.delete(key);
      void onReady(pending.ctx, pending.messages);
    }, this.settleMs);

    this.pending.set(key, pending);
    return true;
  }
}
