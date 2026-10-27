import { z } from "zod/v4";
import { checkRouteNamespace, normalizeRoute } from "../edit/shared/cms/contract.mjs";
import type { CmsView } from "../edit/shared/cms/view-model.mjs";
import type { SiteSpec } from "./site-spec";

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).refine(value => !["constructor", "prototype", "__proto__"].includes(value));
const bindingSchema = z.object({
  id: name, collection: name, type: name, listPath: z.string(), detailPath: z.string(), title: z.string(), description: z.string().optional(),
  fields: z.object({ title: name, description: name.optional(), image: name.optional(), body: name.optional(), author: name.optional(), authorName: name.optional() }).strict(),
  oldRoutePolicy: z.literal("404"),
}).strict();
export type CollectionBinding = z.infer<typeof bindingSchema>;
export interface AssemblyCmsInput {
  view: CmsView;
  bindings: CollectionBinding[];
  canonicalBase: string;
  editorOrigin: string;
}
export interface CmsPage { slug: string; title: string; description?: string; }
export interface PreparedCollections extends AssemblyCmsInput { pages: CmsPage[]; }
const text = (value: unknown) => typeof value === "string" ? value : "";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function collectionPath(input: string): string {
  const route = normalizeRoute(input);
  if (route === "/" || ["/cms-preview", "/ae-preview", "/api", "/_next"].some(prefix => route === prefix || route.startsWith(prefix + "/")) || route.split("/").slice(1).some(segment => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(segment))) {
    throw new Error(`Unsupported collection route path: ${input}`);
  }
  return route;
}
export function detailPrefix(binding: CollectionBinding): string {
  if (!binding.detailPath.endsWith("/{slug}") || binding.detailPath.indexOf("{slug}") !== binding.detailPath.length - 6) throw new Error("Collection detail route must end in /{slug}");
  return collectionPath(binding.detailPath.slice(0, -7));
}
export const canonicalUrl = (base: string, route: string) => base.replace(/\/$/, "") + (route === "/" ? "/" : route.replace(/\/$/, "") + "/");

/** Build input is an already authorized display DTO; provider snapshots never enter generated source. */
export function prepareCollections(spec: SiteSpec, input: AssemblyCmsInput): PreparedCollections {
  const bindings = z.array(bindingSchema).parse(input.bindings);
  const canonical = new URL(input.canonicalBase);
  if (canonical.protocol !== "https:" || canonical.username || canonical.password || canonical.search || canonical.hash) throw new Error("CMS canonicalBase must be HTTPS without credentials/query/fragment");
  const editor = new URL(input.editorOrigin);
  if (editor.origin !== input.editorOrigin || editor.username || editor.password || !(editor.protocol === "https:" || editor.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(editor.hostname))) throw new Error("CMS editorOrigin must be an exact secure origin");
  const requested = spec.collections?.map(ref => ref.binding) ?? [];
  if (!requested.length || new Set(requested).size !== requested.length) throw new Error("CMS input requires unique authorized SiteSpec binding references");
  if (new Set(bindings.map(binding => binding.id)).size !== bindings.length || bindings.length !== requested.length || bindings.some(binding => !requested.includes(binding.id))) throw new Error("CMS binding configuration does not match SiteSpec references");
  const view = structuredClone(input.view);
  if (!object(view) || view.v !== 1 || Object.keys(view).some(key => !["v", "documents", "routes", "assets"].includes(key)) || !object(view.documents) || !Array.isArray(view.routes) || !object(view.assets)) throw new Error("Invalid CMS display DTO");
  for (const [id, doc] of Object.entries(view.documents)) {
    if (id.startsWith("drafts.") || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) || ["constructor", "prototype", "__proto__"].includes(id) || !object(doc) || doc._id !== id) throw new Error("CMS display DTO must contain logical document ids, never drafts");
    if (Object.keys(doc).some(key => key.startsWith("_") && !["_id", "_type"].includes(key))) throw new Error("CMS display DTO contains private provider metadata");
  }
  for (const asset of Object.values(view.assets)) {
    if (!object(asset) || typeof asset.src !== "string" || typeof asset.alt !== "string" || Object.keys(asset).some(key => !["src", "alt"].includes(key)) || !(asset.src.startsWith("/") && !asset.src.startsWith("//") && !asset.src.includes("\\") || /^https:\/\//.test(asset.src))) throw new Error("CMS assets require a public local path or HTTPS");
  }
  const pages: CmsPage[] = [];
  const routes: CmsView["routes"] = [];
  const included = new Set<string>();
  const collections = new Set(bindings.map(binding => binding.collection));
  for (const route of view.routes) {
    if (!object(route) || Object.keys(route).some(key => !["path", "collection", "id"].includes(key)) || typeof route.id !== "string" || typeof route.collection !== "string" || typeof route.path !== "string") throw new Error("Invalid CMS route DTO");
    collectionPath(route.path);
    if (!collections.has(route.collection)) continue;
    routes.push({ ...route, path: collectionPath(route.path) });
  }
  for (const binding of bindings) {
    binding.listPath = collectionPath(binding.listPath);
    const prefix = detailPrefix(binding);
    const entries = routes.filter(route => route.collection === binding.collection);
    if (entries.filter(route => route.path === binding.listPath && !view.documents[route.id]).length !== 1) throw new Error(`Missing list route for CMS binding ${binding.id}`);
    pages.push({ slug: binding.listPath, title: binding.title, ...(binding.description === undefined ? {} : { description: binding.description }) });
    for (const route of entries) {
      if (route.path === binding.listPath) continue;
      const doc = view.documents[route.id];
      if (!doc || doc._type !== binding.type || !route.path.startsWith(prefix + "/") || route.path.slice(prefix.length + 1).includes("/")) throw new Error(`CMS detail route does not match binding ${binding.id}`);
      included.add(route.id);
      pages.push({ slug: route.path, title: text(doc[binding.fields.title]), ...(binding.fields.description ? { description: text(doc[binding.fields.description]) } : {}) });
    }
  }
  const conflicts = checkRouteNamespace({ authored: spec.pages.map(page => page.slug), reserved: ["/cms-preview", "/ae-preview", "/api/contact", "/sitemap.xml", "/robots.txt"], entries: routes });
  if (conflicts.length) throw new Error(`CMS route collision: ${JSON.stringify(conflicts)}`);
  for (const binding of bindings) {
    const prefix = detailPrefix(binding);
    if (spec.pages.some(page => page.slug.startsWith(prefix + "/")) || bindings.some(other => other !== binding && (other.listPath.startsWith(prefix + "/") || detailPrefix(other) === prefix))) throw new Error("CMS dynamic route namespace conflict");
  }
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!object(value)) return;
    if (typeof value._ref === "string" && Object.hasOwn(view.documents, value._ref) && !included.has(value._ref)) { included.add(value._ref); visit(view.documents[value._ref]); }
    Object.values(value).forEach(visit);
  };
  [...included].forEach(id => visit(view.documents[id]));
  view.documents = Object.fromEntries([...included].map(id => [id, view.documents[id]]));
  view.routes = routes;
  const assetRefs = new Set<string>();
  const findAssets = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(findAssets); return; }
    if (!object(value)) return;
    if (typeof value._ref === "string" && Object.hasOwn(view.assets, value._ref)) assetRefs.add(value._ref);
    Object.values(value).forEach(findAssets);
  };
  Object.values(view.documents).forEach(findAssets);
  view.assets = Object.fromEntries([...assetRefs].map(ref => [ref, view.assets[ref]]));
  return { view, bindings, canonicalBase: input.canonicalBase, editorOrigin: input.editorOrigin, pages };
}
