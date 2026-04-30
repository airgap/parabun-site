// Re-renders every <pre data-lang="X"><code>...</code></pre> block on
// public/index.html through Shiki, using the same parabun TextMate
// grammar that powers the docs site. The previous markup was hand-
// rolled <span class="kw|fn|str|...">…</span> which drifted out of
// sync with reality on every edit.
//
// Run: bun run scripts/highlight-landing.ts
//
// The script reads public/index.html, finds each tabbed code block,
// strips the existing span markup and decodes entities to recover the
// raw source, runs it through Shiki with the parabun grammar, and
// writes the result back. Idempotent — re-running it on already-
// highlighted output produces the same output.

import { createHighlighter } from "shiki";
import parabunTs from "../src/grammars/parabun-ts.tmLanguage.json" with { type: "json" };
import parabunTsx from "../src/grammars/parabun-tsx.tmLanguage.json" with { type: "json" };
import parabunJs from "../src/grammars/parabun-js.tmLanguage.json" with { type: "json" };
import parabunJsx from "../src/grammars/parabun-jsx.tmLanguage.json" with { type: "json" };
import parabunInject from "../src/grammars/parabun-inject.tmLanguage.json" with { type: "json" };

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#x27": "'",
  "#x60": "`",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  rarr: "→",
  larr: "←",
  uarr: "↑",
  darr: "↓",
  hellip: "…",
  sup2: "²",
  sup3: "³",
};

function decodeEntities(s: string): string {
  return s.replace(/&([a-zA-Z]+|#x?\w+);/g, (m, name) => {
    if (name in ENTITIES) return ENTITIES[name];
    if (name.startsWith("#x")) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return m;
  });
}

function stripSpans(html: string): string {
  // Drop opening <span ...> and closing </span> tags. Keep inner text.
  return html.replace(/<span\b[^>]*>/g, "").replace(/<\/span>/g, "");
}

function rawCode(blockHtml: string): string {
  return decodeEntities(stripSpans(blockHtml));
}

const indexPath = new URL("../public/index.html", import.meta.url).pathname;
const original = await Bun.file(indexPath).text();

const highlighter = await createHighlighter({
  langs: [
    "typescript",
    "tsx",
    "javascript",
    "jsx",
    parabunTs as any,
    parabunTsx as any,
    parabunJs as any,
    parabunJsx as any,
    parabunInject as any,
  ],
  themes: ["github-dark"],
  langAlias: {
    parabun: "parabun-ts",
    pts: "parabun-ts",
    ptsx: "parabun-tsx",
    pjs: "parabun-js",
    pjsx: "parabun-jsx",
  },
});

let blockCount = 0;
const rewritten = original.replace(
  /<pre\b([^>]*)>([\s\S]*?<code>)([\s\S]*?)(<\/code>[\s\S]*?)<\/pre>/g,
  (_m, preAttrs, preToCode, body, codeToEnd) => {
    const langMatch = preAttrs.match(/\bdata-lang=["']([\w-]+)["']/);
    const lang = langMatch ? langMatch[1] : "ts";
    const code = rawCode(body);
    const targetLang = lang === "ts" ? "typescript" : lang;
    const html = highlighter.codeToHtml(code, { lang: targetLang, theme: "github-dark" });
    const innerMatch = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
    const inner = innerMatch ? innerMatch[1] : code;
    blockCount++;
    return `<pre${preAttrs}>${preToCode}${inner}${codeToEnd}</pre>`;
  },
);

await Bun.write(indexPath, rewritten);
highlighter.dispose();
console.log(`re-highlighted ${blockCount} code blocks → ${indexPath}`);
