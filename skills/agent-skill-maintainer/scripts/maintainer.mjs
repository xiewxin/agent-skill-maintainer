#!/usr/bin/env node
/**
 * Local deterministic Agent Skill Maintainer CLI.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  SCHEMA_NAMES,
  selectTargets,
  validateDocument,
} from "./lib/core.mjs";
import { createRun, readRun } from "./lib/state.mjs";

const DEFAULT_STATE_ROOT = resolve(homedir(), ".agent-skill-maintainer");

/** Parses one command and rejects unknown or ambiguous arguments. */
function parseArguments(argv) {
  const [command, ...tokens] = argv;
  if (!["target", "start", "status", "validate"].includes(command)) {
    throw new Error("未知或缺少命令");
  }
  const values = {};
  const repeated = { explicit: [], candidate: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--") || token.length === 2) {
      throw new Error(`不合法參數：${token}`);
    }
    const name = token.slice(2);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`參數缺少值：--${name}`);
    }
    index += 1;
    if (Object.hasOwn(repeated, name)) {
      repeated[name].push(value);
    } else {
      if (Object.hasOwn(values, name)) {
        throw new Error(`參數不可重複：--${name}`);
      }
      values[name] = value;
    }
  }
  const allowed = {
    target: new Set(["explicit", "candidate"]),
    start: new Set([
      "state-root",
      "run-id",
      "binding-id",
      "skill",
      "repository",
    ]),
    status: new Set(["state-root", "run-id"]),
    validate: new Set(["schema", "input"]),
  }[command];
  const supplied = [
    ...Object.keys(values),
    ...Object.keys(repeated).filter((name) => repeated[name].length > 0),
  ];
  const unknown = supplied.filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new Error(`未知參數：${unknown.map((name) => `--${name}`).join(", ")}`);
  }
  return { command, values, repeated };
}

/** Requires one non-empty option value. */
function required(values, name) {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`缺少必要參數：--${name}`);
  }
  return value;
}

/** Executes a parsed local-only command. */
function execute({ command, values, repeated }) {
  if (command === "target") {
    return selectTargets({
      explicitTargets: repeated.explicit,
      evidenceCandidates: repeated.candidate,
      installedSkills: [],
    });
  }
  if (command === "start") {
    const target = { skill: required(values, "skill") };
    if (values.repository !== undefined) {
      target.repository = values.repository;
    }
    return createRun(values["state-root"] ?? DEFAULT_STATE_ROOT, {
      runId: required(values, "run-id"),
      bindingId: required(values, "binding-id"),
      target,
    });
  }
  if (command === "status") {
    return readRun(
      values["state-root"] ?? DEFAULT_STATE_ROOT,
      required(values, "run-id"),
    );
  }
  if (command === "validate") {
    const schema = required(values, "schema");
    if (!SCHEMA_NAMES.includes(schema)) {
      throw new Error(`未知 schema：${schema}`);
    }
    const document = JSON.parse(readFileSync(required(values, "input"), "utf8"));
    validateDocument(schema, document);
    return { schema, valid: true };
  }
  throw new Error(`未知命令：${command}`);
}

/** Runs the CLI with machine-readable stdout and stderr. */
export function main(argv = process.argv.slice(2)) {
  let command = argv[0] ?? null;
  try {
    const parsed = parseArguments(argv);
    command = parsed.command;
    process.stdout.write(`${JSON.stringify(execute(parsed))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        command,
        error: error.message,
        valid: false,
      })}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main();
}
