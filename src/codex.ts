import { Codex, type RunResult } from "@openai/codex-sdk";

const codex = new Codex();

export async function runCodexInRepo(
  repoPath: string,
  prompt: string,
  existingThreadId?: string
): Promise<{ text: string; threadId?: string }> {
  const thread = existingThreadId
    ? codex.resumeThread(existingThreadId, { workingDirectory: repoPath })
    : codex.startThread({ workingDirectory: repoPath });

  const turn: RunResult = await thread.run(prompt);

  return {
    text: turn.finalResponse,
    threadId: thread.id ?? existingThreadId,
  };
}

const COMPACT_PROMPT = [
  "Create a compact handoff summary for continuing work in a fresh thread.",
  "Keep it concise but complete. Return plain text with these sections:",
  "1. Goal  2. Current state  3. Important files",
  "4. Decisions made  5. Open questions  6. Next steps",
].join("\n");

export async function compactRepoThread(
  repoPath: string,
  repoName: string,
  existingThreadId: string
): Promise<{ summary: string; newThreadId?: string }> {
  // Summarize the old thread
  const oldThread = codex.resumeThread(existingThreadId, { workingDirectory: repoPath });
  const summaryTurn: RunResult = await oldThread.run(`${COMPACT_PROMPT}\nRepo: ${repoName}`);
  const summary = summaryTurn.finalResponse;

  // Seed a new thread with the summary
  const newThread = codex.startThread({ workingDirectory: repoPath });
  await newThread.run(
    "This is a compact handoff summary from a previous thread. " +
      "Use it as starting context. Do not repeat it back unless asked.\n\n" +
      summary
  );

  return { summary, newThreadId: newThread.id ?? undefined };
}
