import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assembleFromSpec } from "../assemble";
import { generateClientConfig, generatePage } from "../generate";
import { siteSpecSchema } from "../site-spec";
import { prepareCollections } from "../collections";

import { cmsFixture } from "./cms-fixture";
export const sampleSpec = () => siteSpecSchema.parse(JSON.parse(fs.readFileSync(path.join(__dirname, "../sample-specs/creative-studio.json"), "utf8")));
const specWithCms = () => ({ ...sampleSpec(), collections: [{ binding: "journal" }] });
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assembler-cms-"));
  fs.mkdirSync(path.join(root, "src/lib"), { recursive: true });
  const specPath = path.join(root, "spec.json");
  fs.writeFileSync(specPath, JSON.stringify(specWithCms()));
  return { root, specPath };
}

test("all pre-CMS sample outputs remain byte-identical", t => {
  t.mock.method(Date.prototype, "getFullYear", () => 2026);
  const expected = {
    "_all-sections.json": "99a51b5f995596657c162d85e57c1dbb0a5f3a569e21e82777ce99ae4eb92caf",
    "consulting-firm.json": "317d65ef29301c90ac59e6f6d5ac4593a83528c5ea847496550059f4fe99adba",
    "creative-studio.json": "30e9b7e1b2afbf28c9f6cc48b82a6d1b608a25450e7971d6532a77ae03dc196b",
    "service-business.json": "f76a0b1569eec4ff8b4fe696b41312f4bb22312460cf7cd0020a2e93fb4804ff",
  };
  for (const [name, hash] of Object.entries(expected)) {
    const spec = siteSpecSchema.parse(JSON.parse(fs.readFileSync(path.join(__dirname, "../sample-specs", name), "utf8")));
    assert.equal(createHash("sha256").update(JSON.stringify([generateClientConfig(spec), ...spec.pages.map(generatePage)])).digest("hex"), hash);
  }
});

test("SiteSpec preserves only a developer binding reference, not collection documents", () => {
  assert.deepEqual(siteSpecSchema.parse(specWithCms()).collections, [{ binding: "journal" }]);
  assert.throws(() => siteSpecSchema.parse({ ...specWithCms(), collections: [{ binding: "journal", documents: {} }] }));
});

test("frozen routes retain only routed entries plus their reference closure", () => {
  const cms = cmsFixture();
  cms.view.documents["unselected"] = { _id: "unselected", _type: "post", title: "UNSELECTED_SENTINEL" };
  const prepared = prepareCollections(specWithCms(), cms);
  assert.deepEqual(prepared.pages.map(p => p.slug), ["/journal", "/journal/first-entry"]);
  assert.deepEqual(Object.keys(prepared.view.documents).sort(), ["author-one", "post-one"]);
  assert.equal(JSON.stringify(prepared).includes("UNSELECTED_SENTINEL"), false);
  cms.view.documents["post-one"].title = "N_PLUS_ONE";
  assert.equal(prepared.view.documents["post-one"].title, "Frozen first entry");
});

test("invalid inputs fail before assembly changes authored files", async () => {
  const { root, specPath } = workspace();
  try {
    const config = path.join(root, "src/lib/client-config.ts"); fs.writeFileSync(config, "KEEP");
    const cms = cmsFixture(); cms.view.routes[1].path = "/../escape";
    await assert.rejects(assembleFromSpec(specPath, root, { cms }), /route|path|segment/i);
    assert.equal(fs.readFileSync(config, "utf8"), "KEEP");
    assert.throws(() => prepareCollections(specWithCms(), { ...cmsFixture(), bindings: [] }), /binding/i);
    assert.throws(() => prepareCollections({ ...specWithCms(), pages: [...sampleSpec().pages, { slug: "/journal", title: "Conflict", sections: sampleSpec().pages[0].sections }] }, cmsFixture()), /collision|conflict/i);
    const draft = cmsFixture(); draft.view.documents["drafts.post-one"] = { _id: "drafts.post-one", _type: "post" };
    assert.throws(() => prepareCollections(specWithCms(), draft), /draft/i);
    const privateView = cmsFixture(); privateView.view.documents["post-one"]._rev = "PRIVATE_REVISION";
    assert.throws(() => prepareCollections(specWithCms(), privateView), /metadata|revision|DTO/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("assembly generates actual Next routes and safely removes stale owned routes", async () => {
  const { root, specPath } = workspace();
  try {
    const cms = cmsFixture();
    const result = await assembleFromSpec(specPath, root, { cms });
    assert.equal(result.cmsPages?.length, 2);
    const detail = fs.readFileSync(path.join(root, "src/app/journal/[slug]/page.tsx"), "utf8");
    assert.match(detail, /generateStaticParams/); assert.match(detail, /CollectionView/); assert.match(detail, /generateMetadata/);
    const preview = fs.readFileSync(path.join(root, "src/app/cms-preview/page.tsx"), "utf8");
    assert.match(preview, /CollectionView/); assert.match(preview, /connectPreview/);
    fs.writeFileSync(path.join(root, "src/app/journal/handwritten.txt"), "KEEP");
    cms.bindings[0].listPath = "/updates"; cms.bindings[0].detailPath = "/updates/{slug}";
    cms.view.routes = cms.view.routes.map(r => ({ ...r, path: r.path.replace("/journal", "/updates") }));
    await assembleFromSpec(specPath, root, { cms });
    assert.equal(fs.existsSync(path.join(root, "src/app/journal/[slug]/page.tsx")), false);
    assert.equal(fs.readFileSync(path.join(root, "src/app/journal/handwritten.txt"), "utf8"), "KEEP");
    fs.writeFileSync(path.join(root, "src/app/updates/[slug]/page.tsx"), "MANUAL_EDIT");
    cms.bindings[0].listPath = "/latest"; cms.bindings[0].detailPath = "/latest/{slug}";
    cms.view.routes = cms.view.routes.map(r => ({ ...r, path: r.path.replace("/updates", "/latest") }));
    await assert.rejects(assembleFromSpec(specPath, root, { cms }), /changed|modified|owned/i);
    assert.equal(fs.readFileSync(path.join(root, "src/app/updates/[slug]/page.tsx"), "utf8"), "MANUAL_EDIT");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("CMS removal can hand a former list route back to an authored page", async () => {
  const { root, specPath } = workspace();
  try {
    await assembleFromSpec(specPath, root, { cms: cmsFixture() });
    const spec = sampleSpec(); spec.pages.push({ slug: "/journal", title: "Authored journal", sections: [{ type: "disclosure", props: { body: "Handwritten route content." } }] });
    fs.writeFileSync(specPath, JSON.stringify(spec));
    await assembleFromSpec(specPath, root);
    assert.match(fs.readFileSync(path.join(root, "src/app/journal/page.tsx"), "utf8"), /Authored journal/);
    assert.equal(fs.existsSync(path.join(root, "src/app/journal/[slug]/page.tsx")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("reserved route prefixes and symlink writes are rejected before changes", async () => {
  const cms = cmsFixture(); cms.bindings[0].detailPath = "/cms-preview/{slug}";
  assert.throws(() => prepareCollections(specWithCms(), cms), /route|path/i);
  const { root, specPath } = workspace();
  try {
    const config = path.join(root, "src/lib/client-config.ts"); fs.writeFileSync(config, "KEEP");
    fs.mkdirSync(path.join(root, "src/app"), { recursive: true });
    fs.symlinkSync(path.join(root, "does-not-exist"), path.join(root, "src/app/journal"));
    await assert.rejects(assembleFromSpec(specPath, root, { cms: cmsFixture() }), /symlink/i);
    assert.equal(fs.readFileSync(config, "utf8"), "KEEP");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
