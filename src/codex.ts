import { Codex, type ModelReasoningEffort, type RunResult, type SandboxMode } from "@openai/codex-sdk";

const codex = new Codex();

function openThread(
  repoPath: string,
  reasoningEffort: ModelReasoningEffort,
  sandboxMode: SandboxMode,
  existingThreadId?: string
) {
  const opts = {
    workingDirectory: repoPath,
    modelReasoningEffort: reasoningEffort,
    sandboxMode,
  };
  return existingThreadId
    ? codex.resumeThread(existingThreadId, opts)
    : codex.startThread(opts);
}

export async function runCodexInRepo(
  repoPath: string,
  prompt: string,
  existingThreadId?: string,
  reasoningEffort: ModelReasoningEffort = "medium",
  sandboxMode: SandboxMode = "read-only"
): Promise<{ text: string; threadId?: string }> {
  const thread = openThread(repoPath, reasoningEffort, sandboxMode, existingThreadId);

  const { events } = await thread.runStreamed(prompt);
  let finalResponse = "";

  for await (const event of events) {
    if (event.type === "item.completed" && event.item.type === "agent_message") {
      finalResponse = event.item.text;
    }
  }

  return {
    text: finalResponse,
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
  existingThreadId: string,
  reasoningEffort: ModelReasoningEffort = "medium",
  sandboxMode: SandboxMode = "read-only"
): Promise<{ summary: string; newThreadId?: string }> {
  const oldThread = openThread(repoPath, reasoningEffort, sandboxMode, existingThreadId);
  const summaryTurn: RunResult = await oldThread.run(`${COMPACT_PROMPT}\nRepo: ${repoName}`);
  const summary = summaryTurn.finalResponse;

  const newThread = openThread(repoPath, reasoningEffort, sandboxMode);
  await newThread.run(
    "This is a compact handoff summary from a previous thread. " +
      "Use it as starting context. Do not repeat it back unless asked.\n\n" +
      summary
  );

  return { summary, newThreadId: newThread.id ?? undefined };
}
