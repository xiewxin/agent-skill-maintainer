import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CONTROLLER_PATH = fileURLToPath(
  new URL("../scripts/neutral-evaluation-controller.mjs", import.meta.url),
);

test(
  "neutral evaluator fails closed when Windows cannot prove owner-only key permissions",
  {
    skip: process.platform === "win32"
      ? false
      : "Windows permission semantics only",
  },
  (context) => {
    const root = mkdtempSync(
      join(tmpdir(), "maintainer-windows-private-key-"),
    );
    context.after(() => {
      rmSync(root, { recursive: true, force: true });
    });
    const requestPath = join(root, "request.json");
    const privateKeyPath = join(root, "authority-private.pem");
    writeFileSync(requestPath, "{}\n", "utf8");
    writeFileSync(privateKeyPath, "not-a-private-key\n", {
      encoding: "utf8",
      mode: 0o600,
    });

    const result = spawnSync(
      process.execPath,
      [CONTROLLER_PATH, requestPath, privateKeyPath],
      { encoding: "utf8" },
    );

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /evaluator private key must be a private regular file/u,
    );
  },
);
