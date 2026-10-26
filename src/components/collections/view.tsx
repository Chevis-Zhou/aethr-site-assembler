"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { CollectionBinding } from "../../lib/assembly/collections";
import type { CmsView } from "../../lib/edit/shared/cms/view-model.mjs";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const normalized = (path: string) => path.replace(/\/$/, "") || "/";

function Photo({ value, view }: { value: unknown; view: CmsView }) {
  const image = record(value), asset = view.assets[text(record(image.asset)._ref)];
  if (!asset) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- frozen assets are validated public paths; static export has no image service
    <img src={asset.src} alt={text(image.alt) || asset.alt} width={800} height={600} className="h-auto w-full rounded-lg object-cover" loading="lazy" />
  );
}
function Body({ value, view }: { value: unknown; view: CmsView }) {
  return (Array.isArray(value) ? value : []).map((item, index) => {
    const block = record(item), key = text(block._key) || String(index);
    if (block._type === "image") return <Photo key={key} value={block} view={view} />;
    if (block._type === "separator") return <hr key={key} className="border-border" />;
    if (block._type !== "block") return <p key={key} data-unsupported-block>Unsupported content block</p>;
    const marks = Array.isArray(block.markDefs) ? block.markDefs.map(record) : [];
    const children = (Array.isArray(block.children) ? block.children : []).map((item, index) => {
      const span = record(item); let child: ReactNode = text(span.text);
      for (const mark of Array.isArray(span.marks) ? span.marks : []) {
        if (mark === "strong") child = <strong>{child}</strong>;
        else if (mark === "em") child = <em>{child}</em>;
        else if (mark === "code") child = <code>{child}</code>;
        else {
          const annotation = marks.find(value => value._key === mark);
          const href = text(annotation?.href);
          if (annotation?._type === "link" && /^(https:\/\/|mailto:)/i.test(href)) child = <a href={href} target="_blank" rel="noopener" className="underline underline-offset-4">{child}</a>;
        }
      }
      return <span key={text(span._key) || index}>{child}</span>;
    });
    if (block.listItem === "bullet") return <ul key={key} className="list-disc pl-6"><li>{children}</li></ul>;
    if (block.listItem === "number") return <ol key={key} className="list-decimal pl-6"><li>{children}</li></ol>;
    if (block.style === "h2") return <h2 key={key} className="font-heading text-2xl font-semibold text-foreground">{children}</h2>;
    if (block.style === "h3") return <h3 key={key} className="font-heading text-xl font-semibold text-foreground">{children}</h3>;
    if (block.style === "blockquote") return <blockquote key={key} className="border-l-2 border-primary pl-6">{children}</blockquote>;
    return <p key={key}>{children}</p>;
  });
}

/** Production and authorized preview both render the same serializable display DTO. */
export function CollectionView({ view, bindings, page }: { view: CmsView; bindings: CollectionBinding[]; page: string }) {
  const route = view.routes.find(route => normalized(route.path) === normalized(page));
  const binding = bindings.find(binding => binding.collection === route?.collection);
  if (!route || !binding) return <section className="px-4 py-16"><h1>Page not found</h1></section>;
  const doc = view.documents[route.id];
  const entries = view.routes.filter(route => route.collection === binding.collection && view.documents[route.id]?._type === binding.type);
  return <section className="py-16 md:py-24">
    <div className="mx-auto max-w-7xl px-4 sm:px-6">
      {!doc ? <>
        <h1 className="font-heading text-3xl font-bold tracking-tight text-foreground sm:text-4xl">{binding.title}</h1>
        <ul className="mt-10 grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map(route => {
            const entry = view.documents[route.id];
            return <li key={route.id} className="space-y-4">
              {binding.fields.image && <Photo value={entry[binding.fields.image]} view={view} />}
              <h2 className="font-heading text-xl font-semibold"><Link href={route.path + "/"} className="inline-block py-2 underline decoration-border underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-4">{text(entry[binding.fields.title])}</Link></h2>
              {binding.fields.description && <p className="leading-relaxed text-muted-foreground">{text(entry[binding.fields.description])}</p>}
            </li>;
          })}
        </ul>
      </> : <article data-cms-entry={route.id} className="mx-auto max-w-3xl space-y-6">
        <Link href={binding.listPath + "/"} className="inline-block py-2 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4">{binding.title}</Link>
        <h1 className="font-heading text-3xl font-bold tracking-tight text-foreground sm:text-4xl">{text(doc[binding.fields.title])}</h1>
        {binding.fields.description && <p className="text-lg leading-relaxed text-muted-foreground">{text(doc[binding.fields.description])}</p>}
        {binding.fields.author && binding.fields.authorName && <p>{text(view.documents[text(record(doc[binding.fields.author])._ref)]?.[binding.fields.authorName])}</p>}
        {binding.fields.image && <Photo value={doc[binding.fields.image]} view={view} />}
        {binding.fields.body && <div className="space-y-4 leading-relaxed text-muted-foreground"><Body value={doc[binding.fields.body]} view={view} /></div>}
      </article>}
    </div>
  </section>;
}
