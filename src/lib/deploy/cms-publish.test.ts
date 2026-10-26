import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { verifyCmsCheckout, fetchCmsBuildAssets, verifyCmsAssetBytes, prepareCmsPublish, cmsBuildEnvironment, deriveCmsBuildAssets, writeCmsAssetManifest, type CheckoutFacts } from "../../../scripts/lib/cms-publish";
import { sharp, optimizeImages } from "../qa/image-pipeline/optimize-images";
import { checkAssetManifest } from "../qa/asset-check";
import { digest } from "../edit/shared/cms/contract.mjs";
import { cmsFixture } from "../assembly/__tests__/cms-fixture";
import { siteSpecSchema } from "../assembly/site-spec";

const sha = (text:string | Uint8Array)=>`sha256:${createHash("sha256").update(text).digest("hex")}`;
const root = path.resolve(".deploy/cms-runner-tests");
const facts:CheckoutFacts = {root,commit:"a".repeat(40),tree:"b".repeat(40),dirty:"",lockfile:new TextEncoder().encode("fixed lock"),toolchain:"node:test;pnpm:test;next:test"};
const pins = ()=>({renderer:sha(facts.tree),template:sha(facts.tree),validators:sha(facts.tree),lockfile:sha(facts.lockfile),toolchain:facts.toolchain,recipe:"assembled-cms@1",routeMapping:sha("route"),config:sha("config")});
afterEach(()=>{fs.rmSync(root,{recursive:true,force:true});});

test("CMS builds require exact clean source, tree, dependency, template, validator and toolchain pins",()=>{
  assert.doesNotThrow(()=>verifyCmsCheckout(pins(),{sourceCommit:facts.commit},facts));
  for (const name of ["renderer","template","validators","lockfile","toolchain"] as const) {
    assert.throws(()=>verifyCmsCheckout({...pins(),[name]:"wrong"},{sourceCommit:facts.commit},facts),/pin/);
  }
  assert.throws(()=>verifyCmsCheckout(pins(),{sourceCommit:"c".repeat(40)},facts),/commit/);
  assert.throws(()=>verifyCmsCheckout(pins(),{sourceCommit:facts.commit},{...facts,dirty:"M src/app/page.tsx"}),/clean/);
  assert.throws(()=>verifyCmsCheckout(pins(),{},facts),/sourceCommit/);
  assert.equal(fs.existsSync(root),false);
});

const bytes = new Uint8Array([1,2,3]);
const hash = sha(bytes),asset = {path:`cms-assets/${hash.slice(7)}.png`,ref:"image-test",sha256:hash,bytes:bytes.byteLength,contentType:"image/png",
  url:"https://portal.example/api/deploy/cms-asset?job=job-a&runner=runner-a&attempt=1&ref=image-test"};
const identity = {jobId:"job-a",runner:"runner-a",attempt:1,portalBase:"https://portal.example",buildSecret:"synthetic-secret"};

test("immutable asset fetch sends the runner credential only to the exact Portal origin and verifies bytes",async()=>{
  let authorization:string | null = null;
  const fetcher = (async(_url:unknown,init?:RequestInit)=>{authorization = new Headers(init?.headers).get("authorization");return new Response(bytes,{headers:{"content-type":"image/png"}});}) as typeof fetch;
  await fetchCmsBuildAssets(root,[asset],identity,fetcher);
  assert.equal(authorization,"Bearer synthetic-secret");
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(root,"public",asset.path))),bytes);
  assert.doesNotThrow(()=>verifyCmsAssetBytes(root,[asset]));
  fs.writeFileSync(path.join(root,"public",asset.path),new Uint8Array([9,9,9]));
  assert.throws(()=>verifyCmsAssetBytes(root,[asset]),/optimizer changed/);
});

test("foreign origins, stale attempts, unregistered keys, bad digests and escaping paths cannot write",async()=>{
  let calls = 0;
  const fetcher = (async()=>{calls++;return new Response(bytes,{headers:{"content-type":"image/png"}});}) as typeof fetch;
  for (const changed of [{url:asset.url.replace("portal.example","foreign.example")},{url:asset.url.replace("attempt=1","attempt=2")},
    {url:asset.url + "&key=secret"},{path:"../outside"},{path:"/cms-assets/absolute"},{path:"cms-assets/../outside"}]) {
    await assert.rejects(fetchCmsBuildAssets(root,[{...asset,...changed}],identity,fetcher));
  }
  assert.equal(calls,0);
  await assert.rejects(fetchCmsBuildAssets(root,[asset],identity,(async()=>new Response(new Uint8Array([9,9,9]),{headers:{"content-type":"image/png"}})) as typeof fetch),/checksum/);
  assert.equal(fs.existsSync(path.join(root,"public",asset.path)),false);
});

test("asset paths cannot cross a symlink and downloaded bytes cannot exceed the frozen length",async()=>{
  fs.mkdirSync(path.join(root,"public"),{recursive:true});
  fs.symlinkSync(path.dirname(root),path.join(root,"public","cms-assets"));
  await assert.rejects(fetchCmsBuildAssets(root,[asset],identity,(async()=>new Response(bytes)) as typeof fetch),/symlink/);
  fs.unlinkSync(path.join(root,"public","cms-assets"));
  await assert.rejects(fetchCmsBuildAssets(root,[asset],identity,(async()=>new Response(new Uint8Array([1,2,3,4]),{headers:{"content-type":"image/png"}})) as typeof fetch),/length/);
});

test("assembled runner consumes the frozen binding/view, refuses drift and requires an explicit editor origin",async()=>{
  const input = cmsFixture(),ref = "image-abc123-1x1-png";
  input.view.assets = {[ref]:{src:`/${asset.path}`,alt:"Synthetic image"}};
  input.view.documents["post-one"].photo = {asset:{_ref:ref},alt:"Synthetic image"};
  const {view,...assembly} = input;
  const config = {kind:"assembled",sourceCommit:facts.commit,assembly};
  const build = {...pins(),config:await digest(config)};
  const manifest = {v:1,snapshotId:"cms-snapshot",schemaHash:sha("schema"),provider:"sanity",revisions:{"post-one":"d1","author-one":"p1"},tombstones:[],
    cutoff:{kind:"boundedReread",value:sha("membership")},assets:[{ref,sha256:asset.sha256,bytes:asset.bytes,contentType:asset.contentType}],routes:view.routes,build,checksum:sha("accepted snapshot")};
  const payload = {view,config,build,manifest,recipeRevision:build.recipe,assets:[{...asset,ref}]};
  const vector = {site:{version:1},cms:{snapshotId:manifest.snapshotId,checksum:manifest.checksum}};
  const spec = siteSpecSchema.parse({...JSON.parse(fs.readFileSync("src/lib/assembly/sample-specs/creative-studio.json","utf8")),collections:[{binding:"journal"}]});
  const prepared = await prepareCmsPublish(payload,spec,root,vector,facts);
  assert.deepEqual(prepared.cmsPages.map(page=>page.slug),["/journal","/journal/first-entry"]);
  assert.equal(prepared.input.view.documents["post-one"].title,"Frozen first entry");
  view.documents["post-one"].title = "Later N+1";
  assert.equal(prepared.input.view.documents["post-one"].title,"Frozen first entry");
  await assert.rejects(prepareCmsPublish({...payload,config:{...config,kind:"html"}},spec,root,vector,facts),/assembled/);
  await assert.rejects(prepareCmsPublish({...payload,build:{...build,renderer:"later"}},spec,root,vector,facts),/pins/);
  await assert.rejects(prepareCmsPublish(payload,spec,root,{...vector,site:{absent:true}},facts),/vector/);
  const overrideConfig = {...config,assembly:{...assembly,view:{v:1,documents:{},routes:[],assets:{}}}};
  const overrideBuild = {...build,config:await digest(overrideConfig)};
  await assert.rejects(prepareCmsPublish({...payload,config:overrideConfig,build:overrideBuild,manifest:{...manifest,build:overrideBuild}},spec,root,vector,facts),/assembly configuration/);
  await assert.rejects(prepareCmsPublish({...payload,view:{...view,routes:[]}},spec,root,vector,facts),/route manifest/);
  const missingOrigin = structuredClone(config);delete (missingOrigin.assembly as {editorOrigin?:string}).editorOrigin;
  const changedBuild = {...build,config:await digest(missingOrigin)};
  await assert.rejects(prepareCmsPublish({...payload,config:missingOrigin,build:changedBuild,manifest:{...manifest,build:changedBuild}},spec,root,vector,facts));
});

test("ambient public environment cannot change a frozen CMS build",()=>{
  const ambient = {PATH:"synthetic-path",NEXT_PUBLIC_BANNER:"later-content",NEXT_PUBLIC_ENDPOINT:"later-endpoint"};
  const result = cmsBuildEnvironment({NEXT_PUBLIC_ENDPOINT:"frozen-endpoint"},ambient);
  assert.equal(result.PATH,"synthetic-path");
  assert.equal(result.NEXT_PUBLIC_BANNER,undefined);
  assert.equal(result.NEXT_PUBLIC_ENDPOINT,"frozen-endpoint");
});

test("frozen raster inputs derive bounded content addressed output through the real optimizer and manifest gate",async()=>{
  const sourceBytes = await sharp({create:{width:3000,height:12,channels:4,background:{r:20,g:80,b:120,alpha:0.5}}}).png().toBuffer();
  const sourceSHA = sha(sourceBytes),source = {...asset,path:`cms-assets/${sourceSHA.slice(7)}.png`,sha256:sourceSHA,bytes:sourceBytes.byteLength};
  const input = cmsFixture();input.view.assets = {[source.ref]:{src:`/${source.path}`,alt:"Frozen raster"}};
  const originalView = structuredClone(input.view);
  await fetchCmsBuildAssets(root,[source],identity,(async()=>new Response(sourceBytes,{headers:{"content-type":"image/png"}})) as typeof fetch);
  const derived = await deriveCmsBuildAssets(root,{input,assets:[source]});
  const output = derived.assets[0],bytes = fs.readFileSync(path.join(root,"public",output.path));
  assert.equal(output.sha256,sha(bytes));assert.equal(output.path,`cms-assets/${sha(bytes).slice(7)}.webp`);
  assert.equal((await sharp(bytes).metadata()).width,2500);
  assert.equal(input.view.assets[source.ref].src,`/${output.path}`);
  assert.equal(originalView.assets[source.ref].src,`/${source.path}`);
  assert.equal(fs.existsSync(path.join(root,"public",source.path)),false);
  assert.deepEqual(fs.readFileSync(path.join(root,".cms-inputs",path.basename(source.path))),sourceBytes);
  assert.equal(derived.manifest[0].sourceSHA,sourceSHA);
  assert.equal(derived.manifest[0].sourceRef,source.ref);
  sourceBytes.fill(0); // Later source bytes cannot change an already derived N artifact.
  await optimizeImages(root,path.join(root,"public"));
  assert.doesNotThrow(()=>verifyCmsAssetBytes(root,derived.assets));
  fs.mkdirSync(path.join(root,"out","cms-assets"),{recursive:true});
  fs.copyFileSync(path.join(root,"public",output.path),path.join(root,"out",output.path));
  writeCmsAssetManifest(path.join(root,"out"),derived.manifest);
  assert.deepEqual(await checkAssetManifest(path.join(root,"out"),root),[]);
  const recorded = JSON.parse(fs.readFileSync(path.join(root,"out","cms-asset-manifest.json"),"utf8"));
  assert.equal(recorded.assets[0].sha256,sha(bytes));
});

test("PDF assets retain the exact frozen public bytes",async()=>{
  const source = {...asset,path:`cms-assets/${hash.slice(7)}.pdf`,contentType:"application/pdf"};
  await fetchCmsBuildAssets(root,[source],identity,(async()=>new Response(bytes,{headers:{"content-type":"application/pdf"}})) as typeof fetch);
  const input = cmsFixture();input.view.assets = {[source.ref]:{src:`/${source.path}`,alt:"Frozen PDF"}};
  const derived = await deriveCmsBuildAssets(root,{input,assets:[source]});
  assert.equal(derived.manifest[0].transform,"identity");assert.deepEqual(derived.assets,[source]);
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(root,"public",source.path))),bytes);
});
