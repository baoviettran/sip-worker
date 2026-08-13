import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readManifest = async (path) => JSON.parse(await readFile(path, "utf8"));

test("workspace manifests define the approved graph", async () => {
  const [root, core, browser, node] = await Promise.all([
    readManifest("package.json"),
    readManifest("packages/core/package.json"),
    readManifest("packages/browser/package.json"),
    readManifest("packages/node/package.json"),
  ]);
  assert.equal(root.private, true);
  assert.deepEqual(root.workspaces, ["packages/core", "packages/browser", "packages/node"]);
  assert.equal(core.name, "@sip-worker/core");
  assert.equal(browser.name, "sip-worker");
  assert.equal(node.name, "@sip-worker/node");
  for (const pkg of [core, browser, node]) {
    assert.equal(pkg.version, "0.5.0");
    assert.equal(pkg.type, "module");
    assert.equal(pkg.sideEffects, false);
    assert.deepEqual(pkg.files, ["dist"]);
  }
  assert.equal(browser.dependencies["@sip-worker/core"], "0.5.0");
  assert.equal(node.dependencies["@sip-worker/core"], "0.5.0");
  assert.equal(core.dependencies?.["sip-worker"], undefined);
  assert.equal(core.dependencies?.["@sip-worker/node"], undefined);
  assert.equal(browser.dependencies?.["@sip-worker/node"], undefined);
  assert.equal(node.dependencies?.["sip-worker"], undefined);
  assert.equal(root.publishConfig, undefined);
  assert.deepEqual(Object.keys(core.exports), [
    ".", "./messages", "./stream", "./transport", "./transactions", "./dialogs",
    "./auth", "./ua", "./media", "./reliability", "./bridge",
  ]);
  assert.deepEqual(Object.keys(browser.exports), [".", "./transport", "./media"]);
  assert.equal(browser.exports["./media"].types, "./dist/media/index.d.ts");
  assert.deepEqual(Object.keys(node.exports), [".", "./transport", "./reliability"]);
});
