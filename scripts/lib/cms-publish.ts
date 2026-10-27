import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { digest, parseSnapshotManifest, parseSourceVector, type BuildPins } from "../../src/lib/edit/shared/cms/contract.mjs";
import { prepareCollections, type AssemblyCmsInput, type CmsPage } from "../../src/lib/assembly/collections";
import type { SiteSpec } from "../../src/lib/assembly/site-spec";
import { sharp, MAX_WIDTH } from "../../src/lib/qa/image-pipeline/optimize-images";

const hash = (value:string | Uint8Array)=>`sha256:${createHash("sha256").update(value).digest("hex")}`;
const object = (value:unknown):value is Record<string,unknown>=>!!value && typeof value === "object" && !Array.isArray(value);
export interface CheckoutFacts {root:string;commit:string;tree:string;dirty:string;lockfile:Uint8Array;toolchain:string;}
export interface FrozenBuildAsset {path:string;url:string;ref:string;sha256:string;bytes:number;contentType:string;}
export interface CmsBuildIdentity {jobId:string;runner:string;attempt:number;portalBase:string;buildSecret:string;}
export interface PreparedCmsPublish {
  input:AssemblyCmsInput;cmsPages:CmsPage[];assets:FrozenBuildAsset[];sourceCommit:string;facts:CheckoutFacts;buildEnv:Record<string,string>;
}

/** Recipe convention: sourceCommit is a full clean Git commit. renderer/template/validators
 * pin SHA256(raw Git tree id), lockfile pins its raw bytes, toolchain pins exact versions.
 * This runner refuses unavailable original inputs; it never substitutes the current tree. */
export function verifyCmsCheckout(pins:BuildPins,config:{sourceCommit?:unknown},facts:CheckoutFacts):void {
  if (typeof config.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(config.sourceCommit)) throw new Error("CMS sourceCommit must identify the original source");
  if (facts.commit !== config.sourceCommit) throw new Error("CMS source commit pin is unavailable");
  if (facts.dirty) throw new Error("CMS builds require a clean source checkout");
  for (const name of ["renderer","template","validators"] as const)
    if (pins[name] !== hash(facts.tree)) throw new Error(`CMS ${name} pin is incompatible with this source tree`);
  if (pins.lockfile !== hash(facts.lockfile)) throw new Error("CMS lockfile pin is incompatible");
  if (pins.toolchain !== facts.toolchain) throw new Error("CMS toolchain pin is incompatible");
}

export function inspectCmsCheckout(root:string):CheckoutFacts {
  const git = (...args:string[])=>execFileSync("git",args,{cwd:root}).toString().trim();
  if (fs.realpathSync(git("rev-parse","--show-toplevel")) !== fs.realpathSync(root)) throw new Error("CMS source must be the repository root");
  const require = createRequire(path.join(root,"package.json"));
  const next = JSON.parse(fs.readFileSync(require.resolve("next/package.json"),"utf8")) as {version:string};
  const pnpm = execFileSync("pnpm",["--version"],{cwd:root}).toString().trim();
  return {root,commit:git("rev-parse","HEAD"),tree:git("rev-parse","HEAD^{tree}"),dirty:git("status","--porcelain"),
    lockfile:new Uint8Array(fs.readFileSync(path.join(root,"pnpm-lock.yaml"))),toolchain:`node:${process.versions.node};pnpm:${pnpm};next:${next.version};sharp:${sharp.versions.sharp};libvips:${sharp.versions.vips}`};
}

export async function prepareCmsPublish(value:unknown,spec:SiteSpec,root:string,vectorInput:unknown,facts:CheckoutFacts = inspectCmsCheckout(root)):Promise<PreparedCmsPublish> {
  if (!object(value) || !object(value.config) || value.config.kind !== "assembled" || !object(value.config.assembly)
    || !Array.isArray(value.assets) || !object(value.view)) throw new Error("This runner requires an assembled frozen CMS recipe");
  const manifest = parseSnapshotManifest(value.manifest),vector = parseSourceVector(vectorInput);
  if ("absent" in vector.cms || "absent" in vector.site || vector.cms.snapshotId !== manifest.snapshotId || vector.cms.checksum !== manifest.checksum)
    throw new Error("Frozen CMS build vector does not match the manifest");
  if (await digest(value.build) !== await digest(manifest.build) || await digest(value.config) !== manifest.build.config
    || value.recipeRevision !== manifest.build.recipe) throw new Error("Frozen CMS build pins changed");
  if (Object.keys(value.config.assembly).some(key=>!["bindings","canonicalBase","editorOrigin"].includes(key)))
    throw new Error("Unexpected CMS assembly configuration");
  if (await digest(value.view.routes) !== await digest(manifest.routes)) throw new Error("Frozen CMS route manifest changed");
  const buildEnv = value.config.buildEnv ?? {};
  if (!object(buildEnv) || Object.entries(buildEnv).some(([key,value])=>!/^NEXT_PUBLIC_[A-Z0-9_]+$/.test(key) || typeof value !== "string"))
    throw new Error("CMS buildEnv must contain explicit public build values");
  const input = {...value.config.assembly,view:value.view} as unknown as AssemblyCmsInput;
  const prepared = prepareCollections(spec,input);
  const assets = value.assets as FrozenBuildAsset[];
  if (assets.length !== manifest.assets.length || new Set(assets.map(asset=>asset.ref)).size !== assets.length
    || assets.some(asset=>!manifest.assets.some(record=>record.ref === asset.ref && record.sha256 === asset.sha256 && record.bytes === asset.bytes && record.contentType === asset.contentType)))
    throw new Error("Frozen CMS asset manifest changed");
  for (const asset of assets) if (input.view.assets[asset.ref]?.src !== `/${asset.path}`) throw new Error("CMS view uses unfrozen asset addresses");
  verifyCmsCheckout(manifest.build,value.config,facts);
  return {input:prepared,cmsPages:prepared.pages,assets,sourceCommit:facts.commit,facts,buildEnv:buildEnv as Record<string,string>};
}

export function cmsBuildEnvironment(explicit:Record<string,string>,ambient:Record<string,string|undefined> = process.env):NodeJS.ProcessEnv {
  return {...Object.fromEntries(Object.entries(ambient).filter(([key])=>!key.startsWith("NEXT_PUBLIC_"))),...explicit,NODE_ENV:"production"};
}

/** Archive the verified source into its own ignored SSD build directory. Only integrity-
 * checked shared transport files are copied from the generated cache into that source. */
export function isolatedCmsBuild(prepared:PreparedCmsPublish):string {
  const {facts} = prepared,shared: {relative:string;bytes:Buffer}[] = [];
  for (const filename of ["edit-layer-lock.json","edit-layer-cms-lock.json"]) {
    const lock = JSON.parse(fs.readFileSync(path.join(facts.root,"scripts",filename),"utf8")) as {files:Record<string,string>};
    for (const [relative,expected] of Object.entries(lock.files)) {
      if (!/^[A-Za-z0-9_./-]+$/.test(relative) || relative.split("/").includes("..") || relative.startsWith("/")) throw new Error("Invalid shared module path");
      const bytes = fs.readFileSync(path.join(facts.root,"src/lib/edit/shared",relative));
      if (hash(bytes) !== `sha256:${expected}`) throw new Error("CMS shared transport cache does not match original source pins");
      shared.push({relative,bytes});
    }
  }
  const fresh = inspectCmsCheckout(facts.root);
  if (fresh.commit !== facts.commit || fresh.tree !== facts.tree || fresh.dirty || hash(fresh.lockfile) !== hash(facts.lockfile) || fresh.toolchain !== facts.toolchain)
    throw new Error("CMS source changed before isolation");
  const archive = execFileSync("git",["archive","--format=tar",facts.commit],{cwd:facts.root,maxBuffer:100 * 1024 * 1024});
  const parent = path.join(facts.root,".deploy");fs.mkdirSync(parent,{recursive:true});
  const target = fs.mkdtempSync(path.join(parent,"cms-build-"));
  try {
    execFileSync("tar",["-xf","-","-C",target],{input:archive});
    for (const item of shared) {
      const filename = path.join(target,"src/lib/edit/shared",item.relative);
      fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,item.bytes);
    }
    // Install only the archived lock, from the existing store; no latest dependency fallback.
    execFileSync("pnpm",["install","--offline","--frozen-lockfile","--ignore-scripts"],{cwd:target,stdio:"inherit"});
    const require = createRequire(path.join(target,"package.json"));
    const installed = JSON.parse(fs.readFileSync(require.resolve("next/package.json"),"utf8")) as {version:string};
    if (!facts.toolchain.includes(`;next:${installed.version};`)) throw new Error("Isolated CMS dependency toolchain differs from its pin");
    // Sharp does not export package.json; verify the installed runtime directly.
    const isolatedSharp = require("sharp") as {versions:{sharp:string;vips:string}};
    if (isolatedSharp.versions.sharp !== sharp.versions.sharp || isolatedSharp.versions.vips !== sharp.versions.vips)
      throw new Error("Isolated CMS raster toolchain differs from its pin");
    return target;
  } catch (error) {fs.rmSync(target,{recursive:true,force:true});throw error;}
}

function assetTarget(root:string,asset:FrozenBuildAsset):string {
  if (!/^cms-assets\/[0-9a-f]{64}\.(png|jpg|gif|webp|avif|pdf)$/.test(asset.path) || !/^sha256:[0-9a-f]{64}$/.test(asset.sha256)
    || !asset.path.startsWith(`cms-assets/${asset.sha256.slice(7)}.`) || !Number.isInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 100_000_000)
    throw new Error("Invalid frozen CMS asset path or length");
  const base = path.resolve(root,"public"),target = path.resolve(base,asset.path);
  if (!target.startsWith(base + path.sep)) throw new Error("CMS asset path escapes public");
  let current = target;
  while (current !== path.resolve(root)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("CMS asset path crosses a symlink");
    current = path.dirname(current);
  }
  return target;
}

export async function fetchCmsBuildAssets(root:string,assets:FrozenBuildAsset[],identity:CmsBuildIdentity,fetcher:typeof fetch = fetch):Promise<void> {
  const portal = new URL(identity.portalBase);
  if (portal.username || portal.password || portal.origin !== identity.portalBase.replace(/\/$/,"")
    || !(portal.protocol === "https:" || portal.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(portal.hostname)))
    throw new Error("Portal base must be an exact secure origin");
  // Validate every destination and request before sending any credentials or writing a file.
  const destinations = assets.map(asset=>{
    const target = assetTarget(root,asset),url = new URL(asset.url);
    const params = url.searchParams;
    if (url.origin !== portal.origin || url.username || url.password || url.hash || url.pathname !== "/api/deploy/cms-asset"
      || params.get("job") !== identity.jobId || params.get("runner") !== identity.runner || params.get("attempt") !== String(identity.attempt)
      || params.get("ref") !== asset.ref || [...params.keys()].length !== 4 || new Set(params.keys()).size !== 4)
      throw new Error("CMS asset request does not match the Portal build lease");
    return {asset,target,url};
  });
  for (const {asset,target,url} of destinations) {
    const response = await fetcher(url,{headers:{Authorization:`Bearer ${identity.buildSecret}`},redirect:"error",signal:AbortSignal.timeout(30_000)});
    if (!response.ok || response.redirected || !response.body) throw new Error("Frozen CMS asset download failed");
    if (response.headers.get("content-type")?.split(";")[0] !== asset.contentType) throw new Error("Frozen CMS asset content type changed");
    const reader = response.body.getReader(),chunks:Uint8Array[] = [];let size = 0;
    while (true) {
      const part = await reader.read();if (part.done) break;
      size += part.value.byteLength;
      if (size > asset.bytes) {await reader.cancel();throw new Error("Frozen CMS asset length exceeded");}
      chunks.push(part.value);
    }
    const bytes = Buffer.concat(chunks);
    if (size !== asset.bytes || hash(bytes) !== asset.sha256) throw new Error("Frozen CMS asset checksum or length changed");
    assetTarget(root,asset);
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
  }
}

/** Optimization must not rewrite a URL whose name promises the original frozen bytes. */
export function verifyCmsAssetBytes(root:string,assets:FrozenBuildAsset[]):void {
  for (const asset of assets) {
    const bytes = fs.readFileSync(assetTarget(root,asset));
    if (bytes.byteLength !== asset.bytes || hash(bytes) !== asset.sha256)
      throw new Error("The optimizer changed frozen CMS asset bytes. Optimize source media before registering this snapshot.");
  }
}

export interface CmsAssetDerivation {
  sourceRef:string;sourceSHA:string;sourceBytes:number;path:string;sha256:string;bytes:number;contentType:string;
  transform:"bounded-lossless-webp-v1" | "identity";
}

/** Frozen originals remain recovery inputs. Raster output gets its own content address;
 * the detached render view changes, never the accepted snapshot or its source hashes. */
export async function deriveCmsBuildAssets(root:string,prepared:Pick<PreparedCmsPublish,"input"|"assets">):Promise<{assets:FrozenBuildAsset[];manifest:CmsAssetDerivation[]}> {
  verifyCmsAssetBytes(root,prepared.assets);
  const outputs: Array<{source:FrozenBuildAsset;output:FrozenBuildAsset;bytes:Buffer;record:CmsAssetDerivation}> = [];
  for (const source of prepared.assets) {
    const original = fs.readFileSync(assetTarget(root,source));
    if (source.contentType === "application/pdf") {
      outputs.push({source,output:source,bytes:original,record:{sourceRef:source.ref,sourceSHA:source.sha256,sourceBytes:source.bytes,path:source.path,sha256:source.sha256,bytes:source.bytes,contentType:source.contentType,transform:"identity"}});
      continue;
    }
    const metadata = await sharp(original,{animated:true,failOn:"error"}).metadata();
    const animated = (metadata.pages ?? 1) > 1;
    let pipeline = sharp(original,{animated:true,failOn:"error"}).keepIccProfile();
    if (!animated) pipeline = pipeline.rotate();
    const bytes = await pipeline.resize({width:MAX_WIDTH,height:MAX_WIDTH,fit:"inside",withoutEnlargement:true}).webp({lossless:true,exact:true,effort:6}).toBuffer();
    const sha256 = hash(bytes),output = {...source,path:`cms-assets/${sha256.slice(7)}.webp`,sha256,bytes:bytes.byteLength,contentType:"image/webp"};
    outputs.push({source,output,bytes,record:{sourceRef:source.ref,sourceSHA:source.sha256,sourceBytes:source.bytes,path:output.path,sha256,bytes:bytes.byteLength,contentType:output.contentType,transform:"bounded-lossless-webp-v1"}});
  }
  const inputs = path.join(root,".cms-inputs");
  if (fs.existsSync(inputs) && fs.lstatSync(inputs).isSymbolicLink()) throw new Error("CMS private inputs cannot cross a symlink");
  fs.mkdirSync(inputs,{recursive:true});
  // Read and derive every source before removing any shared source filename.
  for (const {source,record} of outputs) if (record.transform !== "identity") {
    const sourcePath = assetTarget(root,source),privatePath = path.join(inputs,path.basename(source.path));
    if (fs.existsSync(privatePath) && fs.lstatSync(privatePath).isSymbolicLink()) throw new Error("CMS private input cannot cross a symlink");
    if (fs.existsSync(sourcePath)) {fs.writeFileSync(privatePath,fs.readFileSync(sourcePath));fs.unlinkSync(sourcePath);}
  }
  for (const {source,output,bytes} of outputs) {
    const target = assetTarget(root,output);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
    if (prepared.input.view.assets[source.ref]) prepared.input.view.assets[source.ref].src = `/${output.path}`;
  }
  return {assets:outputs.map(value=>value.output),manifest:outputs.map(value=>value.record)};
}

export function writeCmsAssetManifest(outDir:string,records:CmsAssetDerivation[]):void {
  fs.writeFileSync(path.join(outDir,"cms-asset-manifest.json"),JSON.stringify({v:1,assets:records},null,2)+"\n");
}
