import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import shikiTypescript from "@shikijs/langs/typescript";
import shikiTsx from "@shikijs/langs/tsx";
import shikiJavascript from "@shikijs/langs/javascript";
import shikiJsx from "@shikijs/langs/jsx";
import parabunTsGrammar from "./src/grammars/parabun-ts.tmLanguage.json" with { type: "json" };
import parabunTsxGrammar from "./src/grammars/parabun-tsx.tmLanguage.json" with { type: "json" };
import parabunJsGrammar from "./src/grammars/parabun-js.tmLanguage.json" with { type: "json" };
import parabunJsxGrammar from "./src/grammars/parabun-jsx.tmLanguage.json" with { type: "json" };
import parabunInjectGrammar from "./src/grammars/parabun-inject.tmLanguage.json" with { type: "json" };

// Hand-curated sidebar — the docs sit flat under src/content/docs/docs/* to
// preserve existing /docs/<slug>/ URLs, so autogen-from-directory isn't a
// natural fit. Two groups (Guides + Modules) match the section split the
// previous build used.
const docsRoot = "/docs";
const guides = [
  { label: "ParaBun docs", link: `${docsRoot}/` },
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
].map(slug => ({ label: `para:${slug}`, link: `${docsRoot}/${slug}/` }));

export default defineConfig({
  site: "https://parabun.script.dev",
  integrations: [
    starlight({
      title: "ParaBun",
      description:
        "A fork of Bun with extra runtime modules: parallel CPU work, GPU compute, codecs, capture, on-device LLM inference.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/airgap/parabun" }],
      customCss: ["./src/styles/parabun.css"],
      components: { SiteTitle: "./src/components/SiteTitle.astro" },
      // Canvas-based starfield + nebulae renderer. Replaces the old
      // pseudo-element parallax (see public/space.js for why).
      head: [{ tag: "script", attrs: { src: "/space.js", defer: true } }],
      sidebar: [
        { label: "Guides", items: guides },
        { label: "Modules", items: modules },
      ],
      expressiveCode: {
        // Custom TextMate grammars for `.pts` / `.ptsx` / `.pjs` / `.pjsx`.
        // Each grammar embeds the matching base TS/TSX/JS/JSX grammar via
        // `embeddedLangs`, then layers ParaBun keywords (memo / pure / fun /
        // signal / effect / arena / defer) and operators (|> ~> -> ..= ..! ..&)
        // on top.
        shiki: {
          langs: [
            shikiTypescript,
            shikiTsx,
            shikiJavascript,
            shikiJsx,
            parabunTsGrammar,
            parabunTsxGrammar,
            parabunJsGrammar,
            parabunJsxGrammar,
            parabunInjectGrammar,
          ],
          langAlias: {
            parabun: "parabun-ts",
            pts: "parabun-ts",
            ptsx: "parabun-tsx",
            pjs: "parabun-js",
            pjsx: "parabun-jsx",
          },
        },
        // Stellar Atlas pair — Tokyo Night for the night-sky default
        // (slate bg, periwinkle keywords, warm-amber strings — sits
        // naturally inside the cosmic page); min-light for the atlas
        // alternate (parchment-friendly, low-saturation tokens).
        themes: ["min-light", "tokyo-night"],
      },
    }),
  ],
});
