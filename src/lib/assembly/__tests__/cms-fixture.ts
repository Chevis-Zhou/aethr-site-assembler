import type { AssemblyCmsInput } from "../collections";

export function cmsFixture(): AssemblyCmsInput {
  return {
    canonicalBase: "https://collections.example",
    editorOrigin: "https://portal.aethrdesign.com",
    bindings: [{ id: "journal", collection: "post", type: "post", listPath: "/journal", detailPath: "/journal/{slug}", title: "Journal", description: "Synthetic journal entries for assembler verification.", fields: { title: "title", description: "excerpt", image: "photo", body: "body", author: "author", authorName: "name" }, oldRoutePolicy: "404" }],
    view: { v: 1, documents: {
      "post-one": { _id: "post-one", _type: "post", title: "Frozen first entry", excerpt: "A synthetic frozen entry.", author: { _ref: "author-one" }, photo: { asset: { _ref: "image-one" }, alt: "Synthetic illustration" }, body: [{ _type: "block", _key: "block-one", style: "normal", children: [{ _type: "span", text: "Frozen body.", marks: [] }] }] },
      "author-one": { _id: "author-one", _type: "author", name: "Synthetic author" },
    }, routes: [{ path: "/journal", collection: "post", id: "collection-post" }, { path: "/journal/first-entry", collection: "post", id: "post-one" }], assets: { "image-one": { src: "/assets/synthetic.webp", alt: "Synthetic illustration" } } },
  };
}
