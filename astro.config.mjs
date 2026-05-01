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
// preserve existing /docs/<slug>/ URLs. ParaBun docs cover hardware-bound
// runtime modules; portable language modules (signals, parallel, pipeline,
// arena, simd, csv, arrow) and the language sugar itself live on
// para.script.dev — we link there rather than mirror.
const docsRoot = "/docs";
const guides = [
  { label: "ParaBun docs", link: `${docsRoot}/` },
  { label: "Install", link: `${docsRoot}/install/` },
];
// Hardware-bound and runtime-only modules — not portable to other JS
// runtimes, so they live here.
const runtimeModules = [
  "assistant",
  "audio",
  "camera",
  "gpio",
  "gpu",
  "i2c",
  "image",
  "llm",
  "speech",
  "spi",
  "video",
  "vision",
].map(slug => ({ label: `parabun:${slug}`, link: `${docsRoot}/${slug}/` }));
// Portable Para modules — pure JS / WASM, run anywhere; documented on
// para.script.dev so the language story stays in one place. Listed here so
// readers see what ParaBun ships, with the link pointing at the canonical doc.
const portableModules = ["arena", "arrow", "csv", "mcp", "parallel", "pipeline", "rtp", "signals", "simd"].map(
  slug => ({
    label: `para:${slug}`,
    link: `https://para.script.dev/docs/${slug}/`,
  }),
);

// Old /docs/<slug>/ paths for portable modules — preserved as 301s so any
// social or LLM-cached link keeps working after the page moved to para.script.dev.
const portableSlugs = ["arena", "arrow", "csv", "language", "mcp", "parallel", "pipeline", "rtp", "signals", "simd"];
const docsRedirects = Object.fromEntries(
  portableSlugs.map(slug => [`/docs/${slug}/`, `https://para.script.dev/docs/${slug}/`]),
);

export default defineConfig({
  site: "https://parabun.script.dev",
  redirects: docsRedirects,
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
        { label: "Runtime modules", items: runtimeModules },
        { label: "Para modules (cross-runtime)", items: portableModules },
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
