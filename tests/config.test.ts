import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BRIDGE_COMMANDS,
  BUILT_IN_AGENTS,
  buildAgentSessionScope,
  defaultConfig,
  matchBridgeCommand,
  parseResourceInlineLimit,
  parseSessionResumePolicy,
  resolveAgentSelection,
  validateCommandAliases,
} from "../src/config.js";

test("opencode presets target v1 and v2 through distinct npm packages", () => {
  // OpenCode 1 (opencode-ai) and OpenCode 2 (@opencode/cli) both install the
  // `opencode` command and are never side by side, so each preset must pin
  // its own npm package and go through npx rather than a global binary.
  const v1 = resolveAgentSelection("opencode");
  assert.deepEqual(v1, {
    id: "opencode",
    label: "OpenCode",
    command: "npx",
    args: ["opencode-ai", "acp"],
    env: undefined,
    source: "preset",
  });

  const v2 = resolveAgentSelection("opencode2");
  assert.deepEqual(v2, {
    id: "opencode2",
    label: "OpenCode 2",
    command: "npx",
    args: ["@opencode/cli", "acp"],
    env: undefined,
    source: "preset",
  });

  // Both expose `acp` as the last argument so the ACP stdio server starts.
  assert.equal(BUILT_IN_AGENTS.opencode.args.at(-1), "acp");
  assert.equal(BUILT_IN_AGENTS.opencode2.args.at(-1), "acp");
  // Distinct preset IDs keep persisted session scopes from colliding.
  assert.notEqual(
    buildAgentSessionScope({ preset: "opencode", command: "npx", args: [], cwd: "." }),
    buildAgentSessionScope({ preset: "opencode2", command: "npx", args: [], cwd: "." }),
  );
});

test("preset session scope ignores bundled command changes", () => {
  const first = buildAgentSessionScope({
    preset: "copilot",
    command: "npx",
    args: ["@github/copilot", "--acp"],
    cwd: ".",
  });
  const second = buildAgentSessionScope({
    preset: "copilot",
    command: "copilot",
    args: ["--acp", "--new-default"],
    cwd: ".",
  });

  assert.equal(first, second);
});

test("raw agent session scope includes command, args, and cwd", () => {
  const base = {
    command: "agent",
    args: ["--acp"],
    cwd: ".",
  };
  assert.notEqual(
    buildAgentSessionScope(base),
    buildAgentSessionScope({ ...base, args: ["--acp", "--other"] }),
  );
  assert.notEqual(
    buildAgentSessionScope(base),
    buildAgentSessionScope({ ...base, cwd: ".." }),
  );
});

test("session resume policy accepts only documented modes", () => {
  assert.equal(parseSessionResumePolicy("off"), "off");
  assert.equal(parseSessionResumePolicy("auto"), "auto");
  assert.equal(parseSessionResumePolicy("required"), "required");
  assert.throws(() => parseSessionResumePolicy("yes"), /Invalid session resume policy/);
});

test("resource inline limit defaults to 1000 and accepts 0 through 4000", () => {
  assert.equal(defaultConfig().agent.resourceInlineLimit, 1000);
  assert.equal(parseResourceInlineLimit(0), 0);
  assert.equal(parseResourceInlineLimit(1000), 1000);
  assert.equal(parseResourceInlineLimit(4000), 4000);
  assert.throws(() => parseResourceInlineLimit(-1), /Invalid resource inline limit/);
  assert.throws(() => parseResourceInlineLimit(4001), /Invalid resource inline limit/);
  assert.throws(() => parseResourceInlineLimit(1.5), /Invalid resource inline limit/);
  assert.throws(() => parseResourceInlineLimit("1000"), /Invalid resource inline limit/);
});

test("acp-more aliases validate and bare aliases match only the full message", () => {
  const aliases = {
    [BRIDGE_COMMANDS.acpMore]: ["/acp-fetch-msg", "."],
  };
  assert.doesNotThrow(() => validateCommandAliases(aliases));
  assert.equal(
    matchBridgeCommand("/acp-fetch-msg", BRIDGE_COMMANDS.acpMore, aliases),
    BRIDGE_COMMANDS.acpMore,
  );
  assert.equal(
    matchBridgeCommand(".", BRIDGE_COMMANDS.acpMore, aliases),
    BRIDGE_COMMANDS.acpMore,
  );
  assert.equal(matchBridgeCommand(". extra", BRIDGE_COMMANDS.acpMore, aliases), null);
});

test("acp-new supports a configurable clear alias", () => {
  const aliases = {
    [BRIDGE_COMMANDS.acpNew]: ["/acp-clear"],
  };
  assert.doesNotThrow(() => validateCommandAliases(aliases));
  assert.equal(
    matchBridgeCommand("/acp-clear", BRIDGE_COMMANDS.acpNew, aliases),
    BRIDGE_COMMANDS.acpNew,
  );
});
