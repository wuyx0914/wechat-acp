/**
 * Spawn and manage ACP agent subprocesses.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import packageJson from "../../package.json" with { type: "json" };
import type { WeChatAcpClient } from "./client.js";
import type { SessionResumePolicy } from "../config.js";
import { trackException } from "../telemetry/index.js";

export type AgentSessionOutcome = "new" | "loaded" | "unsupported" | "not_found";

export interface AgentProcessInfo {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
  configOptions: acp.SessionConfigOption[];
  sessionOutcome: AgentSessionOutcome;
}

export class AgentProcessCleanupError extends AggregateError {
  constructor(
    startupError: unknown,
    cleanupError: unknown,
    readonly process: ChildProcess,
  ) {
    super(
      [startupError, cleanupError],
      "Agent startup failed and the process could not be stopped",
    );
    this.name = "AgentProcessCleanupError";
  }
}

const uncertainWindowsProcessTrees = new WeakMap<
  ChildProcess,
  { error: unknown }
>();

export async function spawnAgent(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  client: WeChatAcpClient;
  mcpServers?: acp.McpServer[];
  resumePolicy?: SessionResumePolicy;
  persistedSessionId?: string;
  signal?: AbortSignal;
  log: (msg: string) => void;
}): Promise<AgentProcessInfo> {
  const {
    command,
    args,
    cwd,
    env,
    client,
    mcpServers = [],
    resumePolicy = "off",
    persistedSessionId,
    signal,
    log,
  } = params;
  if (signal?.aborted) {
    throw new Error("Agent spawn aborted");
  }

  // On Windows, shell mode avoids EINVAL/ENOENT for command shims like npx/claude/gemini.
  const useShell = process.platform === "win32";

  log(`Spawning agent: ${command} ${args.join(" ")} (cwd: ${cwd}, shell=${useShell})`);

  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
    env: { ...process.env, ...env },
    shell: useShell,
    detached: !useShell,
    windowsHide: true,
  });

  proc.on("error", (err) => {
    log(`Agent process error: ${String(err)}`);
    trackException(err, "agent_spawn");
  });

  proc.on("exit", (code, signal) => {
    log(`Agent process exited: code=${code} signal=${signal}`);
  });

  try {
    if (!proc.stdin || !proc.stdout) {
      const err = new Error("Failed to get agent process stdio");
      trackException(err, "agent_spawn");
      throw err;
    }

    const input = Writable.toWeb(proc.stdin);
    const output = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const connection = new acp.ClientSideConnection(() => client, stream);

    // Initialize
    log("Initializing ACP connection...");
    const initResult = await abortable(
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: {
          name: packageJson.name,
          title: packageJson.name,
          version: packageJson.version,
        },
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
      }),
      signal,
    );
    log(`ACP initialized (protocol v${initResult.protocolVersion})`);

    // Create or load session
    const supportsHttpMcp = initResult.agentCapabilities?.mcpCapabilities?.http === true;
    const sessionMcpServers = supportsHttpMcp
      ? mcpServers.filter(
          (server): server is acp.McpServerHttp & { type: "http" } =>
            "type" in server && server.type === "http",
        )
      : [];
    if (mcpServers.length > 0 && !supportsHttpMcp) {
      log("Agent does not advertise HTTP MCP support; file attachments are unavailable");
    }

    let sessionOutcome: AgentSessionOutcome = "new";
    if (persistedSessionId && resumePolicy !== "off") {
      if (initResult.agentCapabilities?.loadSession !== true) {
        if (resumePolicy === "required") {
          throw new Error(
            `Agent does not support loading persisted ACP session ${persistedSessionId}`,
          );
        }
        sessionOutcome = "unsupported";
        log("Agent does not advertise session/load; creating a new ACP session");
      } else {
        log(`Loading ACP session: ${persistedSessionId}`);
        client.beginSessionReplay();
        try {
          const loadResult = await abortable(
            connection.loadSession({
              cwd,
              mcpServers: sessionMcpServers,
              sessionId: persistedSessionId,
            }),
            signal,
          );
          await client.endSessionReplay();
          log(`ACP session loaded: ${persistedSessionId}`);
          return {
            process: proc,
            connection,
            sessionId: persistedSessionId,
            configOptions: loadResult.configOptions ?? [],
            sessionOutcome: "loaded",
          };
        } catch (err) {
          await client.endSessionReplay();
          if (resumePolicy !== "auto" || !isResourceNotFound(err)) {
            throw normalizeError(err);
          }
          sessionOutcome = "not_found";
          log(`Persisted ACP session not found: ${persistedSessionId}; creating a new session`);
        }
      }
    }

    log("Creating ACP session...");
    const sessionResult = await abortable(
      connection.newSession({
        cwd,
        mcpServers: sessionMcpServers,
      }),
      signal,
    );
    log(`ACP session created: ${sessionResult.sessionId}`);

    return {
      process: proc,
      connection,
      sessionId: sessionResult.sessionId,
      configOptions: sessionResult.configOptions ?? [],
      sessionOutcome,
    };
  } catch (err) {
    try {
      await killAgentAndWait(proc);
    } catch (cleanupErr) {
      throw new AgentProcessCleanupError(err, cleanupErr, proc);
    }
    throw err;
  }

  function isResourceNotFound(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === -32002
    );
  }

  function normalizeError(err: unknown): Error {
    if (err instanceof Error) return err;
    if (
      typeof err === "object" &&
      err !== null &&
      "message" in err &&
      typeof err.message === "string"
    ) {
      return new Error(err.message, { cause: err });
    }
    return new Error(String(err), { cause: err });
  }
}

export function killAgent(proc: ChildProcess): void {
  if (process.platform !== "win32" && proc.pid !== undefined) {
    const groupPid = proc.pid;
    try {
      if (!signalPosixProcessGroup(groupPid, "SIGTERM")) return;
      setTimeout(() => {
        try {
          if (isPosixProcessGroupRunning(groupPid)) {
            signalPosixProcessGroup(groupPid, "SIGKILL");
          }
        } catch {
          proc.kill("SIGKILL");
        }
      }, 5_000).unref();
      return;
    } catch {
      // Fall back to the direct child when the process is not a group leader.
    }
  }
  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGTERM");
    // Force kill after 5s if still alive
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
      }
    }, 5_000).unref();
  }
}

export async function killAgentAndWait(
  proc: ChildProcess,
  timeoutMs = 6_000,
  options: {
    platform?: NodeJS.Platform;
    killWindowsProcessTree?: (pid: number, timeoutMs: number) => Promise<void>;
    killPosixProcessGroup?: (pid: number, timeoutMs: number) => Promise<void>;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const retainedFailure = uncertainWindowsProcessTrees.get(proc);
    const wrapperExited =
      proc.exitCode !== null || proc.signalCode !== null;
    if (retainedFailure && wrapperExited) throw retainedFailure.error;
    if (wrapperExited) {
      // A natural shell exit has no actionable tree root. Only a prior
      // taskkill failure leaves evidence that cleanup is uncertain.
      return;
    }
    if (proc.pid === undefined) {
      throw new Error("Cannot stop agent process tree without a process ID");
    }
    try {
      await (
        options.killWindowsProcessTree ?? killWindowsProcessTree
      )(proc.pid, timeoutMs);
    } catch (err) {
      // If the wrapper exits before a later retry, its PID can be reused and
      // Windows cannot prove that every former descendant is gone.
      uncertainWindowsProcessTrees.set(proc, { error: err });
      throw err;
    }
    uncertainWindowsProcessTrees.delete(proc);
    return;
  }

  if (proc.pid !== undefined) {
    await (
      options.killPosixProcessGroup ?? killPosixProcessGroup
    )(proc.pid, timeoutMs);
    return;
  }
  if (proc.exitCode !== null || proc.signalCode !== null) return;

  let settle!: () => void;
  const exited = new Promise<void>((resolve) => {
    settle = resolve;
    proc.once("exit", settle);
    proc.once("close", settle);
  });
  killAgent(proc);
  if (proc.exitCode !== null || proc.signalCode !== null) {
    proc.off("exit", settle);
    proc.off("close", settle);
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Agent process did not exit within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    proc.off("exit", settle);
    proc.off("close", settle);
  }
}

async function killPosixProcessGroup(
  pid: number,
  timeoutMs: number,
): Promise<void> {
  // Some agents (e.g. OpenCode v2) call setsid() in their children, so
  // every descendant lives in its own process group and signalling `-pid`
  // alone leaves them orphaned. Snapshot the whole descendant tree first,
  // collect every distinct pgid, then signal each group.
  const descendants = listPosixDescendants(pid);
  const groups = new Set<number>([pid]);
  for (const child of descendants) groups.add(child.pgid);
  for (const group of groups) {
    if (!signalPosixProcessGroup(group, "SIGTERM")) groups.delete(group);
  }

  const startedAt = Date.now();
  const forceAfterMs = Math.min(5_000, Math.max(0, timeoutMs - 100));
  let forceSent = false;

  while (isPosixProcessGroupRunning(pid) || [...groups].some(isPosixProcessGroupRunning)) {
    const elapsed = Date.now() - startedAt;
    if (!forceSent && elapsed >= forceAfterMs) {
      for (const group of groups) {
        if (!signalPosixProcessGroup(group, "SIGKILL")) groups.delete(group);
      }
      // Belt and braces: descendants that escaped the group signal (e.g.
      // they changed pgid again after the snapshot) are killed by pid.
      for (const child of descendants) killPosixPid(child.pid, "SIGKILL");
      forceSent = true;
    }
    if (elapsed >= timeoutMs) {
      throw new Error(
        `Agent process group ${pid} did not exit within ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface PosixProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
}

/**
 * List every descendant of `rootPid` together with its process group id.
 * Reads the process table once and walks the parent/child graph breadth
 * first, so grandchildren that called setsid() and live in their own
 * session/process group are still found. Returns an empty list when the
 * table cannot be read (non-Darwin/Linux or `ps` unavailable).
 */
export function listPosixDescendants(rootPid: number): PosixProcessRow[] {
  if (process.platform !== "darwin" && process.platform !== "linux") return [];
  let output: string;
  try {
    output = execFileSync("ps", ["-axo", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      timeout: 2_000,
    });
  } catch {
    return [];
  }
  const childrenOf = new Map<number, PosixProcessRow[]>();
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/).map(Number);
    if (fields.length !== 3 || !fields.every(Number.isInteger)) continue;
    const [pid, ppid, pgid] = fields;
    const list = childrenOf.get(ppid) ?? [];
    list.push({ pid, ppid, pgid });
    childrenOf.set(ppid, list);
  }
  const result: PosixProcessRow[] = [];
  const queue = [rootPid];
  const visited = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of childrenOf.get(parent) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

function killPosixPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    if (hasErrorCode(err, "ESRCH")) return;
    throw err;
  }
}

function signalPosixProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if (hasErrorCode(err, "ESRCH")) return false;
    throw err;
  }
}

function isPosixProcessGroupRunning(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    if (hasErrorCode(err, "ESRCH")) return false;
    if (hasErrorCode(err, "EPERM")) return true;
    throw err;
  }
}

function hasErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === code
  );
}

async function killWindowsProcessTree(
  pid: number,
  timeoutMs: number,
): Promise<void> {
  const taskkill = spawn(
    "taskkill.exe",
    ["/PID", String(pid), "/T", "/F"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  taskkill.stderr?.setEncoding("utf8");
  taskkill.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      taskkill.off("error", onError);
      taskkill.off("close", onClose);
      if (err) reject(err);
      else resolve();
    };
    const onError = (err: Error) => {
      finish(new Error(`Failed to start taskkill for agent process ${pid}`, {
        cause: err,
      }));
    };
    const onClose = (code: number | null) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim();
      finish(
        new Error(
          `taskkill failed for agent process ${pid} with exit code ${String(code)}${detail ? `: ${detail}` : ""}`,
        ),
      );
    };
    const timeout = setTimeout(() => {
      taskkill.kill();
      finish(
        new Error(
          `Agent process tree ${pid} did not exit within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    timeout.unref();
    taskkill.once("error", onError);
    taskkill.once("close", onClose);
  });
}

function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new Error("Agent spawn aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error("Agent spawn aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
