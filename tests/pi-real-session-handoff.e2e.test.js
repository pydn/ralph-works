import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RUN_PI_E2E = process.env.RALPH_WORKS_PI_E2E === "1";
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  "g",
);

class PiRpcClient {
  constructor({ command, args, cwd, env }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.events = [];
    this.pending = new Map();
    this.rawStdout = "";
    this.stderr = "";
    this.stdoutBuffer = "";
    this.nextId = 0;
    this.spawnError = undefined;
  }

  async start() {
    this.process = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout.on("data", (chunk) => {
      this.handleStdout(chunk.toString("utf8"));
    });
    this.process.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    this.process.once("error", (error) => {
      this.spawnError = error;
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    if (this.spawnError) {
      throw new Error(
        [
          `failed to spawn Pi RPC process: ${this.spawnError.message}`,
          `command: ${this.command}`,
          `args: ${JSON.stringify(this.args)}`,
        ].join("\n"),
      );
    }
    if (this.process.exitCode !== null) {
      throw new Error(
        [
          `pi exited during startup with code ${this.process.exitCode}.`,
          `stderr:\n${this.stderr}`,
          `stdout:\n${this.rawStdout}`,
          `events:\n${JSON.stringify(this.events, null, 2)}`,
        ].join("\n\n"),
      );
    }
  }

  async stop() {
    if (!this.process || this.process.exitCode !== null) {
      return;
    }

    this.process.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.process.kill("SIGKILL");
        resolve();
      }, 1000);
      this.process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  handleStdout(chunk) {
    this.rawStdout += chunk;
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.stderr += `\n[non-json stdout] ${line}`;
      return;
    }

    if (
      message.type === "response" &&
      message.id &&
      this.pending.has(message.id)
    ) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.success === false) {
        reject(new Error(message.error ?? `RPC ${message.command} failed`));
      } else {
        resolve(message.data);
      }
      return;
    }

    this.events.push(message);
  }

  send(command, timeoutMs = 30_000) {
    if (!this.process?.stdin || this.process.exitCode !== null) {
      throw new Error(`pi RPC process is not running.\n${this.stderr}`);
    }

    const id = `test-${++this.nextId}`;
    const message = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timed out waiting for RPC ${command.type} response.\n${this.stderr}`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  getState() {
    return this.send({ type: "get_state" });
  }
}

async function readProviderLog(logFile) {
  try {
    const text = await readFile(logFile, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function listSessionFiles(sessionDir) {
  const entries = await readdir(sessionDir, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => path.join(sessionDir, entry));
}

async function readSessionHeader(sessionFile) {
  const text = await readFile(sessionFile, "utf8");
  return JSON.parse(text.split("\n")[0]);
}

async function waitForObservation(fn, { timeoutMs = 8_000 } = {}) {
  const startedAt = Date.now();
  let latest;

  while (Date.now() - startedAt < timeoutMs) {
    latest = await fn();
    if (latest?.done) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    ...latest,
    timedOut: true,
  };
}

function summarizeEvent(event) {
  if (event.type === "extension_ui_request") {
    return {
      type: event.type,
      method: event.method,
      statusKey: event.statusKey,
      statusText: event.statusText,
      widgetKey: event.widgetKey,
      widgetLines: event.widgetLines?.map((line) =>
        line.replace(ANSI_ESCAPE_PATTERN, ""),
      ),
    };
  }

  if (event.type === "queue_update") {
    return {
      type: event.type,
      steering: event.steering,
      followUp: event.followUp,
    };
  }

  return { type: event.type };
}

function summarizeEvents(events) {
  return events.slice(-30).map(summarizeEvent);
}

function pathIsExecutable(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCommandPath(command) {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    assert.ok(pathIsExecutable(command), `${command} is not executable`);
    return realpathSync(command);
  }

  const matches = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, command))
    .filter(pathIsExecutable);
  assert.ok(matches.length > 0, `Unable to locate ${command} on PATH`);
  return realpathSync(matches[0]);
}

async function writePiMainBootstrap(tempDir, cliPath) {
  const packageRoot = path.resolve(path.dirname(cliPath), "..");
  const bootstrapPath = path.join(tempDir, "run-pi-main.mjs");
  const mainUrl = pathToFileURL(path.join(packageRoot, "dist", "main.js"));
  const dispatcherUrl = pathToFileURL(
    path.join(packageRoot, "dist", "core", "http-dispatcher.js"),
  );

  await writeFile(
    bootstrapPath,
    [
      `import { configureHttpDispatcher } from ${JSON.stringify(dispatcherUrl.href)};`,
      `import { main } from ${JSON.stringify(mainUrl.href)};`,
      'process.title = "pi";',
      'process.env.PI_CODING_AGENT = "true";',
      "process.emitWarning = () => {};",
      "configureHttpDispatcher();",
      "await main(process.argv.slice(2));",
      "",
    ].join("\n"),
    "utf8",
  );

  return bootstrapPath;
}

test("real Pi creates a replacement session for marker-driven phase handoff", {
  skip: RUN_PI_E2E ? false : "set RALPH_WORKS_PI_E2E=1 to run real Pi E2E",
}, async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ralph-pi-e2e-"));
  const agentDir = path.join(tempDir, "agent");
  const sessionDir = path.join(tempDir, "sessions");
  const providerLog = path.join(tempDir, "provider-log.jsonl");
  const piBin = process.env.RALPH_WORKS_PI_BIN ?? "pi";
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    RALPH_E2E_PROVIDER_LOG: providerLog,
  };
  const client = new PiRpcClient({
    command: process.execPath,
    args: [],
    cwd: REPO_ROOT,
    env,
  });

  try {
    await mkdir(sessionDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const bootstrapPath = await writePiMainBootstrap(
      tempDir,
      resolveCommandPath(piBin),
    );
    client.args = [
      bootstrapPath,
      "--mode",
      "rpc",
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--session-dir",
      sessionDir,
      "--extension",
      path.join(__dirname, "fixtures", "scripted-pi-provider.js"),
      "--extension",
      path.join(REPO_ROOT, "index.ts"),
      "--model",
      "ralph-e2e/scripted",
    ];
    await client.start();

    const initialState = await client.getState();
    assert.ok(initialState.sessionFile, "expected initial Pi session file");

    await client.send({
      type: "prompt",
      message: "/ralph-works start hello-world Build a hello world example.",
    });

    const observation = await waitForObservation(async () => {
      const [providerCalls, currentState] = await Promise.all([
        readProviderLog(providerLog),
        client.getState(),
      ]);
      const sawHandoffAsModelPrompt = providerCalls.some(
        (entry) => entry.sawHandoffCommand,
      );
      const sawRedTeamPrompt = providerCalls.some(
        (entry) => entry.sawRedTeamPrompt,
      );
      const sessionChanged =
        currentState.sessionFile &&
        currentState.sessionFile !== initialState.sessionFile;

      return {
        done: sawHandoffAsModelPrompt || (sawRedTeamPrompt && sessionChanged),
        providerCalls,
        currentState,
        sawHandoffAsModelPrompt,
        sawRedTeamPrompt,
        sessionChanged,
      };
    });

    assert.equal(
      observation.timedOut,
      undefined,
      [
        "Timed out waiting for a real Pi session handoff.",
        `stderr:\n${client.stderr}`,
        `provider calls:\n${JSON.stringify(observation.providerCalls ?? [], null, 2)}`,
        `recent events:\n${JSON.stringify(summarizeEvents(client.events), null, 2)}`,
      ].join("\n\n"),
    );
    assert.equal(
      observation.sawHandoffAsModelPrompt,
      false,
      "the internal /ralph-works handoff command reached the model instead of executing as a Pi extension command",
    );
    assert.equal(
      observation.sessionChanged,
      true,
      "expected ctx.newSession to replace the active Pi session between generate_spec and red_team",
    );
    assert.equal(
      observation.sawRedTeamPrompt,
      true,
      "expected the red_team phase prompt to launch in the replacement session",
    );

    const sessionFiles = await listSessionFiles(sessionDir);
    assert.ok(
      sessionFiles.length >= 2,
      `expected at least two persisted Pi sessions, found ${sessionFiles.length}`,
    );

    const replacementHeader = await readSessionHeader(
      observation.currentState.sessionFile,
    );
    assert.equal(
      replacementHeader.parentSession,
      initialState.sessionFile,
      "replacement session should record the source session as parentSession",
    );
  } finally {
    await client.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
