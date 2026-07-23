#!/usr/bin/env node
/**
 * Read-only validation for a GitHub repository-settings snapshot.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateRepositorySettings } from "../skills/agent-skill-maintainer/scripts/lib/core.mjs";

/** Runs the read-only repository settings validator. */
export function main(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--input");
  if (index < 0 || argv[index + 1] === undefined) {
    process.stderr.write('{"error":"缺少必要參數：--input"}\n');
    return 1;
  }
  try {
    const settings = JSON.parse(readFileSync(argv[index + 1], "utf8"));
    const report = validateRepositorySettings(settings);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.compliant ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main();
}
