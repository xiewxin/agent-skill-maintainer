import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_ROOT = dirname(fileURLToPath(import.meta.url));
const EXCLUDED_FILES = new Set([
  // This module materializes signed evaluator fixtures during module load.
  "state.test.mjs",
]);
const SIGNED_EVALUATOR_TEST_PATTERN = [
  "PR-ready validation requires",
  "forward binding rejects",
  "forward binding preserves",
  "CLI binds schema v5",
  "neutral controller independently rejects",
  "branch push transition rejects",
  "GitHub apply revalidates the exact binding",
  "CLI branch push",
  "CLI applied reconcile",
  "CLI contributor branch push",
  "CLI creates one verified personal Fork",
  "CLI Fork preflight",
].join("|");

const testFiles = readdirSync(TESTS_ROOT)
  .filter(
    (name) =>
      name.endsWith(".test.mjs") && !EXCLUDED_FILES.has(name),
  )
  .sort()
  .map((name) => join(TESTS_ROOT, name));
const result = spawnSync(
  process.execPath,
  [
    "--test",
    `--test-skip-pattern=(${SIGNED_EVALUATOR_TEST_PATTERN})`,
    ...testFiles,
  ],
  { stdio: "inherit" },
);

if (result.error !== undefined) {
  throw result.error;
}
if (result.status === null) {
  throw new Error("Windows-portable test process ended without an exit status");
}
process.exitCode = result.status;
