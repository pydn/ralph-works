import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

let callCount = 0;
let tddPromptCount = 0;

function usage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function contentToText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function lastUserText(messages) {
  for (const message of [...messages].reverse()) {
    if (message?.role === "user") {
      return contentToText(message.content);
    }
  }

  return "";
}

function logProviderCall(entry) {
  const logFile = process.env.RALPH_E2E_PROVIDER_LOG;
  if (!logFile) {
    return;
  }

  mkdirSync(path.dirname(logFile), { recursive: true });
  appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf8");
}

function scriptedResponseFor(prompt) {
  const trimmedPrompt = prompt.trim();
  if (/^\/ralph-works handoff\b/.test(trimmedPrompt)) {
    return "SCRIPTED_PROVIDER_SAW_HANDOFF_COMMAND";
  }

  if (/# ralph-works Phase: Generate Spec/.test(prompt)) {
    return [
      "Generated spec written to docs/hello-world-generated-spec.md.",
      "",
      "RALPH_PHASE_COMPLETE",
    ].join("\n");
  }

  if (/# ralph-works Phase: Red Team Pass/.test(prompt)) {
    if (process.env.RALPH_E2E_SCENARIO === "tdd-handoff") {
      return "Red team findings written.\n\nRALPH_PHASE_COMPLETE";
    }

    return "Red team prompt reached in the replacement session.";
  }

  if (/# ralph-works Phase: Harden Spec/.test(prompt)) {
    return "Hardened spec written.\n\nRALPH_PHASE_COMPLETE";
  }

  if (/# ralph-works Phase: Task Creation/.test(prompt)) {
    return "Task list written.\n\nRALPH_PHASE_COMPLETE";
  }

  if (/# ralph-works Phase: Red-Green TDD Implement/.test(prompt)) {
    tddPromptCount += 1;
    if (tddPromptCount === 1) {
      return "T001 complete.\n\nRALPH_TDD_TASK_COMPLETE T001";
    }

    return "Second TDD task prompt reached in the replacement session.";
  }

  return "SCRIPTED_PROVIDER_UNEXPECTED_PROMPT";
}

function excerpt(text, limit = 1200) {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}... [truncated ${text.length - limit} chars]`;
}

function streamScriptedResponse(model, context, options) {
  const stream = createAssistantMessageEventStream();

  queueMicrotask(() => {
    const prompt = lastUserText(context.messages);
    const text = scriptedResponseFor(prompt);
    const output = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: usage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };

    logProviderCall({
      call: ++callCount,
      lastUserText: excerpt(prompt),
      promptLength: prompt.length,
      sawGenerateSpecPrompt: /# ralph-works Phase: Generate Spec/.test(prompt),
      sawRedTeamPrompt: /# ralph-works Phase: Red Team Pass/.test(prompt),
      sawHardenSpecPrompt: /# ralph-works Phase: Harden Spec/.test(prompt),
      sawTaskCreationPrompt: /# ralph-works Phase: Task Creation/.test(prompt),
      sawTddPrompt: /# ralph-works Phase: Red-Green TDD Implement/.test(prompt),
      sawHandoffCommand: /^\/ralph-works handoff\b/.test(prompt.trim()),
      responseText: text,
      timestamp: new Date().toISOString(),
    });

    try {
      stream.push({ type: "start", partial: output });
      const contentIndex = output.content.length;
      output.content.push({ type: "text", text: "" });
      stream.push({ type: "text_start", contentIndex, partial: output });

      output.content[contentIndex].text = text;
      output.usage.output = text.length;
      output.usage.totalTokens = text.length;
      stream.push({
        type: "text_delta",
        contentIndex,
        delta: text,
        partial: output,
      });
      stream.push({
        type: "text_end",
        contentIndex,
        content: text,
        partial: output,
      });
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      stream.push({
        type: "error",
        reason: output.stopReason,
        error: output,
      });
      stream.end();
    }
  });

  return stream;
}

export default function scriptedPiProvider(pi) {
  pi.registerProvider("ralph-e2e", {
    name: "RalphWorks E2E Scripted Provider",
    api: "openai-completions",
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:9",
    streamSimple: streamScriptedResponse,
    models: [
      {
        id: "scripted",
        name: "Scripted",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
}
