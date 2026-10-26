import type { CollectionBinding, PreparedCollections } from "./collections";
import { canonicalUrl, detailPrefix } from "./collections";

const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const imports = `import type { Metadata } from "next";
import { CollectionView } from "@/components/collections/view";
import { cms } from "@/lib/edit/shared/cms/site-data";`;

export function generateCollectionFiles(prepared: PreparedCollections, authored: { slug: string }[]): Map<string, string> {
  const files = new Map<string, string>();
  files.set("src/lib/edit/shared/cms/site-data.ts", `import type { PreparedCollections } from "../../../assembly/collections";\nexport const cms = ${json(prepared)} as PreparedCollections;\n`);
  for (const binding of prepared.bindings) {
    files.set(`src/app${binding.listPath}/page.tsx`, `${imports}
export const metadata: Metadata = { title: ${json(binding.title)}, ${binding.description === undefined ? "" : `description: ${json(binding.description)}, `}alternates: { canonical: ${json(canonicalUrl(prepared.canonicalBase, binding.listPath))} } };
export default function Page() { return <CollectionView view={cms.view} bindings={cms.bindings} page=${json(binding.listPath)} />; }
`);
    files.set(`src/app${detailPrefix(binding)}/[slug]/page.tsx`, generateDetail(binding));
  }
  files.set("src/app/cms-preview/page.tsx", `"use client";
import { useEffect, useState } from "react";
import { connectPreview } from "@/lib/edit/shared/native-runtime.mjs";
import type { CmsView } from "@/lib/edit/shared/cms/view-model.mjs";
import { CollectionView } from "@/components/collections/view";
import { cms } from "@/lib/edit/shared/cms/site-data";
export default function Preview() {
  const [view, setView] = useState<{content:CmsView;page:string}|null>(null);
  useEffect(() => connectPreview({ editorOrigin: cms.editorOrigin, onRender: ({content,page}) => setView({content:content as unknown as CmsView,page}) }), []);
  return view ? <CollectionView view={view.content} bindings={cms.bindings} page={view.page} /> : <p>Waiting for authorized preview</p>;
}
`);
  files.set("src/app/cms-preview/layout.tsx", `import type { ReactNode } from "react";
export const metadata = { robots: { index: false, follow: false } };
export default function Layout({children}:{children:ReactNode}) { return children; }
`);
  const urls = [...authored, ...prepared.pages].map(page => canonicalUrl(prepared.canonicalBase, page.slug));
  files.set("src/app/sitemap.ts", `import type { MetadataRoute } from "next";\nexport const dynamic = "force-static";\nexport default function sitemap(): MetadataRoute.Sitemap { return ${json(urls)}.map(url => ({url})); }\n`);
  return files;
}

function generateDetail(binding: CollectionBinding): string {
  return `${imports}
import { notFound } from "next/navigation";
const collection = ${json(binding.collection)};
const prefix = ${json(detailPrefix(binding))};
export const dynamicParams = false;
export function generateStaticParams() {
  return cms.view.routes.filter(route => route.collection === collection && cms.view.documents[route.id]).map(route => ({slug:route.path.slice(prefix.length + 1)}));
}
async function routeFor(params: Promise<{slug:string}>) {
  const {slug} = await params;
  return cms.view.routes.find(route => route.collection === collection && route.path === prefix + "/" + slug && cms.view.documents[route.id]);
}
export async function generateMetadata({params}:{params:Promise<{slug:string}>}): Promise<Metadata> {
  const route = await routeFor(params); if (!route) notFound();
  const page = cms.pages.find(page => page.slug === route.path)!;
  return {title:page.title,description:page.description,alternates:{canonical:cms.canonicalBase.replace(/\\/$/, "") + route.path + "/"}};
}
export default async function Page({params}:{params:Promise<{slug:string}>}) {
  const route = await routeFor(params); if (!route) notFound();
  return <CollectionView view={cms.view} bindings={cms.bindings} page={route.path} />;
}
`;
}
