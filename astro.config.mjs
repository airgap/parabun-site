import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Hand-curated sidebar — the docs sit flat under src/content/docs/docs/* to
// preserve existing /docs/<slug>/ URLs, so autogen-from-directory isn't a
// natural fit. Two groups (Guides + Modules) match the section split the
// previous build used.
const docsRoot = "/docs";
const guides = [
  { label: "Parabun docs", link: `${docsRoot}/` },
  { label: "Install", link: `${docsRoot}/install/` },
  { label: "Language extensions", link: `${docsRoot}/language/` },
];
const modules = [
  "arena",
  "arrow",
  "assistant",
  "audio",
  "camera",
  "csv",
  "gpio",
  "gpu",
  "i2c",
  "image",
  "llm",
  "mcp",
  "parallel",
  "pipeline",
  "rtp",
  "signals",
  "simd",
  "speech",
  "spi",
  "video",
  "vision",
].map(slug => ({ label: `bun:${slug}`, link: `${docsRoot}/${slug}/` }));

export default defineConfig({
  site: "https://parabun.script.dev",
  integrations: [
    starlight({
      title: "Parabun",
      description:
        "A fork of Bun with extra runtime modules: parallel CPU work, GPU compute, codecs, capture, on-device LLM inference.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/airgap/parabun" }],
      customCss: ["./src/styles/parabun.css"],
      sidebar: [
        { label: "Guides", items: guides },
        { label: "Modules", items: modules },
      ],
      expressiveCode: {
        // Alias the existing ```parabun fences to TypeScript so they highlight.
        // Parabun-specific tokens (memo / signal / effect / arena / defer / |> ~>
        // ..= ..! ..&) render as plain identifiers / operators for now — the
        // custom TextMate grammar is a follow-up tracked in PLAN-bun-assistant.md
        // section "Where the line is".
        shiki: { langAlias: { parabun: "typescript" } },
        themes: ["github-dark"],
      },
    }),
  ],
});
