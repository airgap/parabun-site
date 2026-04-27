// Static site build for parabun-site.
//
// Inputs:
//   index.html             — landing page, copied verbatim (with <meta> refresh of the build hash)
//   configure.html         — configurator, copied verbatim
//   docs/*.md              — per-module + topic docs, rendered to dist/docs/{slug}/index.html
//   styles.css, fx.js      — assets, copied verbatim
//
// Output:
//   dist/index.html
//   dist/configure/index.html
//   dist/docs/index.html               (auto-built nav + per-module summaries)
//   dist/docs/{slug}/index.html
//   dist/styles.css, dist/fx.js
//
// No npm deps. Markdown rendering is a small purpose-built parser that
// handles what the docs actually use (ATX headings, fenced code, inline
// code, bold, italic, links, paragraphs, ul/ol lists, GFM tables, hr).

import { readdir, mkdir, cp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const ROOT = import.meta.dir;
const DIST = join(ROOT, "dist");

// ─── Markdown renderer ────────────────────────────────────────────────────

type RenderState = { headings: Array<{ depth: number; text: string; id: string }> };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`<>"'&]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── Syntax highlighting ─────────────────────────────────────────────────
//
// Purpose-built tokenizers for the four languages used in the docs (ts,
// parabun, py, bash). Each emits `<span class="X">` tokens matching the
// classes already styled in styles.css (.kw .str .com .num .fn .type and
// the parabun-specific .pb-kw .pb-op .pb-signal-ref), so the rendered
// output reads the same way as the hand-tuned blocks on the landing page.

const TS_KEYWORDS = new Set([
  "import", "from", "export", "default",
  "const", "let", "var",
  "function", "return",
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
  "new", "class", "extends", "implements", "interface", "type",
  "typeof", "instanceof", "in", "of", "as",
  "async", "await", "try", "catch", "finally", "throw",
  "null", "undefined", "true", "false", "void",
  "this", "super", "enum",
  "public", "private", "protected", "readonly", "static",
  "yield", "delete", "keyof",
]);

const TS_PRIMITIVE_TYPES = new Set([
  "number", "string", "boolean", "bigint", "symbol",
  "any", "unknown", "never", "object",
]);

const PB_KEYWORDS = new Set([
  "memo", "signal", "effect", "arena", "defer", "pure",
]);

const PY_KEYWORDS = new Set([
  "def", "class", "import", "from", "as", "return",
  "if", "elif", "else", "for", "while", "in", "not", "and", "or", "is",
  "True", "False", "None",
  "lambda", "with", "try", "except", "finally", "raise", "pass",
  "break", "continue", "yield", "global", "nonlocal",
  "async", "await", "self",
]);

function tokenSpan(cls: string, text: string): string {
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

function highlightTsLike(src: string, parabun: boolean): string {
  // Pre-scan for parabun signal declarations after stripping comments and
  // strings, so identifiers later in the same block can be tagged.
  const signals = new Set<string>();
  if (parabun) {
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
      .replace(/`(?:\\.|[^`\\])*`/g, "``");
    const re = /\bsignal\s+([A-Za-z_$][\w$]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) signals.add(m[1]);
  }

  const out: string[] = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const c = src[i];
    const c2 = src.slice(i, i + 2);

    // Line comment.
    if (c2 === "//") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      out.push(tokenSpan("com", src.slice(i, j)));
      i = j;
      continue;
    }
    // Block comment.
    if (c2 === "/*") {
      let j = i + 2;
      while (j < n - 1 && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(j + 2, n);
      out.push(tokenSpan("com", src.slice(i, j)));
      i = j;
      continue;
    }
    // String literals (incl. template literals — interpolation passed
    // through as part of the string for simplicity, since the docs don't
    // mix language-level highlighting inside `${...}`).
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === quote) { j++; break; }
        if (quote !== "`" && src[j] === "\n") break;
        j++;
      }
      out.push(tokenSpan("str", src.slice(i, j)));
      i = j;
      continue;
    }
    // Parabun multi-char operators (longest match first).
    if (parabun) {
      if (src.startsWith("..=", i)) { out.push(tokenSpan("pb-op", "..=")); i += 3; continue; }
      if (src.startsWith("..!", i)) { out.push(tokenSpan("pb-op", "..!")); i += 3; continue; }
      if (src.startsWith("..&", i)) { out.push(tokenSpan("pb-op", "..&")); i += 3; continue; }
      if (src.startsWith("~>", i))  { out.push(tokenSpan("pb-op", "~>"));  i += 2; continue; }
      if (src.startsWith("|>", i))  { out.push(tokenSpan("pb-op", "|>"));  i += 2; continue; }
    }
    // Numbers (incl. _ separators, decimals, exponents, hex/bin/oct, BigInt n).
    const isDigit = c >= "0" && c <= "9";
    const isLeadingDot = c === "." && src[i + 1] >= "0" && src[i + 1] <= "9";
    if (isDigit || isLeadingDot) {
      let j = i;
      if (src[i] === "0" && /[xXbBoO]/.test(src[i + 1] ?? "")) {
        j = i + 2;
        while (j < n && /[0-9a-fA-F_]/.test(src[j])) j++;
      } else {
        while (j < n && /[0-9_]/.test(src[j])) j++;
        if (src[j] === "." && (src[j + 1] >= "0" && src[j + 1] <= "9")) {
          j++;
          while (j < n && /[0-9_]/.test(src[j])) j++;
        }
        if (j < n && (src[j] === "e" || src[j] === "E")) {
          j++;
          if (src[j] === "+" || src[j] === "-") j++;
          while (j < n && /[0-9_]/.test(src[j])) j++;
        }
        if (src[j] === "n") j++;
      }
      out.push(tokenSpan("num", src.slice(i, j)));
      i = j;
      continue;
    }
    // Identifier / keyword.
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (parabun && PB_KEYWORDS.has(word)) {
        out.push(tokenSpan("pb-kw", word));
      } else if (parabun && signals.has(word)) {
        out.push(tokenSpan("pb-signal-ref", word));
      } else if (TS_KEYWORDS.has(word)) {
        out.push(tokenSpan("kw", word));
      } else if (TS_PRIMITIVE_TYPES.has(word) || /^[A-Z]/.test(word)) {
        out.push(tokenSpan("type", word));
      } else {
        let k = j;
        while (k < n && (src[k] === " " || src[k] === "\t")) k++;
        if (src[k] === "(") {
          out.push(tokenSpan("fn", word));
        } else {
          out.push(escapeHtml(word));
        }
      }
      i = j;
      continue;
    }
    out.push(escapeHtml(c));
    i++;
  }
  return out.join("");
}

function highlightPy(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "#") {
      let j = i + 1;
      while (j < n && src[j] !== "\n") j++;
      out.push(tokenSpan("com", src.slice(i, j)));
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      const triple = src[i + 1] === quote && src[i + 2] === quote;
      let j = triple ? i + 3 : i + 1;
      if (triple) {
        while (j < n - 2 && !(src[j] === quote && src[j + 1] === quote && src[j + 2] === quote)) j++;
        j = Math.min(j + 3, n);
      } else {
        while (j < n) {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === quote) { j++; break; }
          if (src[j] === "\n") break;
          j++;
        }
      }
      out.push(tokenSpan("str", src.slice(i, j)));
      i = j;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i + 1;
      while (j < n && /[0-9_.]/.test(src[j])) j++;
      out.push(tokenSpan("num", src.slice(i, j)));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (PY_KEYWORDS.has(word)) {
        out.push(tokenSpan("kw", word));
      } else {
        let k = j;
        while (k < n && (src[k] === " " || src[k] === "\t")) k++;
        if (src[k] === "(") {
          out.push(tokenSpan("fn", word));
        } else {
          out.push(escapeHtml(word));
        }
      }
      i = j;
      continue;
    }
    out.push(escapeHtml(c));
    i++;
  }
  return out.join("");
}

function highlightBash(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    // Comments — line-leading or after whitespace, never mid-token (so
    // URLs like https://...#fragment don't get truncated).
    if (c === "#" && (i === 0 || /\s/.test(src[i - 1]))) {
      let j = i + 1;
      while (j < n && src[j] !== "\n") j++;
      out.push(tokenSpan("com", src.slice(i, j)));
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (quote === '"' && src[j] === "\\") { j += 2; continue; }
        if (src[j] === quote) { j++; break; }
        if (src[j] === "\n") break;
        j++;
      }
      out.push(tokenSpan("str", src.slice(i, j)));
      i = j;
      continue;
    }
    out.push(escapeHtml(c));
    i++;
  }
  return out.join("");
}

function highlightCode(src: string, lang: string): string {
  const norm = lang.toLowerCase();
  if (norm === "ts" || norm === "tsx" || norm === "typescript" || norm === "js" || norm === "javascript") {
    return highlightTsLike(src, false);
  }
  if (norm === "parabun") {
    return highlightTsLike(src, true);
  }
  if (norm === "py" || norm === "python") {
    return highlightPy(src);
  }
  if (norm === "bash" || norm === "sh" || norm === "shell") {
    return highlightBash(src);
  }
  return escapeHtml(src);
}

// Inline rendering: code, bold, italic, links — applied after escapeHtml.
function renderInline(input: string): string {
  // Inline code first (so its contents aren't re-processed).
  const codeStash: string[] = [];
  let s = input.replace(/`([^`]+)`/g, (_, c) => {
    codeStash.push(`<code>${escapeHtml(c)}</code>`);
    return `\x00${codeStash.length - 1}\x00`;
  });
  s = escapeHtml(s);
  // Bold / italic — order matters, bold first.
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // Links [text](url).
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${escapeAttr(u)}">${t}</a>`);
  // Restore inline code.
  s = s.replace(/\x00(\d+)\x00/g, (_, i) => codeStash[Number(i)]);
  return s;
}

function renderMarkdown(src: string, state: RenderState): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  const flushPara = (buf: string[]): void => {
    if (buf.length === 0) return;
    out.push(`<p>${renderInline(buf.join(" "))}</p>`);
    buf.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — paragraph break.
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // Fenced code block.
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // closing fence
      const langAttr = lang ? ` data-lang="${escapeAttr(lang)}"` : "";
      const langPill = lang
        ? `<figcaption class="code-header"><span class="code-lang">${escapeHtml(lang)}</span></figcaption>`
        : "";
      out.push(
        `<figure class="code"${langAttr}>${langPill}<pre><code>${highlightCode(codeLines.join("\n"), lang)}</code></pre></figure>`,
      );
      continue;
    }

    // ATX heading.
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const depth = heading[1].length;
      const text = heading[2];
      const id = slugify(text);
      state.headings.push({ depth, text, id });
      out.push(`<h${depth} id="${escapeAttr(id)}">${renderInline(text)}</h${depth}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*-{3,}\s*$/.test(line) || /^\s*\*{3,}\s*$/.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }

    // Table (GFM): row | row, separator on next line.
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|/.test(lines[i + 1])) {
      const splitRow = (row: string): string[] => {
        const trimmed = row.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
        // Pipe-split, but respect backtick-quoted inline code so that
        // `<\|foo\|>`-shaped cells aren't shredded into columns.
        const cells: string[] = [];
        let buf = "";
        let inCode = false;
        for (let i = 0; i < trimmed.length; i++) {
          const ch = trimmed[i];
          if (ch === "`") {
            inCode = !inCode;
            buf += ch;
          } else if (ch === "\\" && i + 1 < trimmed.length && trimmed[i + 1] === "|") {
            // Author-escaped pipe — drop the backslash, keep the pipe in cell.
            buf += "|";
            i++;
          } else if (ch === "|" && !inCode) {
            cells.push(buf.trim());
            buf = "";
          } else {
            buf += ch;
          }
        }
        cells.push(buf.trim());
        return cells;
      };
      const headers = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(c => {
        const left = c.startsWith(":");
        const right = c.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        return "left";
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const alignAttr = (idx: number): string => (aligns[idx] === "left" ? "" : ` style="text-align:${aligns[idx]}"`);
      const head = headers.map((h, idx) => `<th${alignAttr(idx)}>${renderInline(h)}</th>`).join("");
      const body = rows
        .map(r => "<tr>" + r.map((c, idx) => `<td${alignAttr(idx)}>${renderInline(c)}</td>`).join("") + "</tr>")
        .join("");
      out.push(`<table class="bench"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    // Lists.
    const ulMatch = /^(\s*)[-*+]\s+(.+)$/.exec(line);
    const olMatch = /^(\s*)(\d+)\.\s+(.+)$/.exec(line);
    if (ulMatch || olMatch) {
      const tag = ulMatch ? "ul" : "ol";
      const items: string[] = [];
      while (i < lines.length) {
        const u = /^(\s*)[-*+]\s+(.+)$/.exec(lines[i]);
        const o = /^(\s*)(\d+)\.\s+(.+)$/.exec(lines[i]);
        if (!u && !o) break;
        const text = u ? u[2] : o![3];
        items.push(`<li>${renderInline(text)}</li>`);
        i++;
        // Continuation lines (paragraph wrap) — concatenate with previous.
        while (
          i < lines.length &&
          /^\s+\S/.test(lines[i]) &&
          !/^\s*[-*+]\s+/.test(lines[i]) &&
          !/^\s*\d+\.\s+/.test(lines[i])
        ) {
          items[items.length - 1] = items[items.length - 1].replace(
            /<\/li>$/,
            " " + renderInline(lines[i].trim()) + "</li>",
          );
          i++;
        }
      }
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    // Blockquote.
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderInline(quoted.join(" "))}</blockquote>`);
      continue;
    }

    // Paragraph — accumulate lines until blank or special.
    const paraBuf: string[] = [line];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) break;
      if (/^#{1,6}\s+/.test(l)) break;
      if (/^```/.test(l)) break;
      if (/^\s*-{3,}\s*$/.test(l)) break;
      if (/^\s*[-*+]\s+/.test(l)) break;
      if (/^\s*\d+\.\s+/.test(l)) break;
      if (/^\s*\|/.test(l)) break;
      if (/^\s*>/.test(l)) break;
      paraBuf.push(l);
      i++;
    }
    flushPara(paraBuf);
  }

  return out.join("\n");
}

// ─── Page shell ───────────────────────────────────────────────────────────

interface DocPageMeta {
  slug: string;
  title: string;
  tagline?: string;
  section: "modules" | "guides";
}

function pageShell(opts: {
  title: string;
  description: string;
  body: string;
  isDocs: boolean;
  pages: DocPageMeta[];
  currentSlug: string | null;
  pathPrefix: string; // "" for root, "../" for /docs/{slug}/
}): string {
  const { title, description, body, isDocs, pages, currentSlug, pathPrefix } = opts;
  const docsLink = pathPrefix + "docs/";
  const homeLink = pathPrefix === "" ? "./" : pathPrefix;
  const stylesHref = pathPrefix + "styles.css";

  // Sidebar nav for docs pages.
  let docsNav = "";
  if (isDocs) {
    const modPages = pages.filter(p => p.section === "modules");
    const guidePages = pages.filter(p => p.section === "guides");
    const linkFor = (p: DocPageMeta): string => {
      const isCurrent = p.slug === currentSlug;
      const href = p.slug === "index" ? docsLink : `${docsLink}${p.slug}/`;
      const cls = isCurrent ? ' class="active"' : "";
      return `<li><a href="${href}"${cls}>${escapeHtml(p.title)}</a></li>`;
    };
    docsNav = `
      <aside class="docs-side">
        <nav>
          <h4>Guides</h4>
          <ul>${guidePages.map(linkFor).join("")}</ul>
          <h4>Modules</h4>
          <ul>${modPages.map(linkFor).join("")}</ul>
        </nav>
      </aside>`;
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeAttr(description)}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" />
    <link rel="stylesheet" href="${stylesHref}" />
    <script>
      try {
        const pref = localStorage.getItem("parabun-ligatures");
        if (pref !== "off") document.documentElement.classList.add("ligatures");
      } catch {
        document.documentElement.classList.add("ligatures");
      }
    </script>
  </head>
  <body${isDocs ? ' class="docs-body"' : ""}>
    <main class="page${isDocs ? " docs-layout" : ""}">
      <header>
        <a class="brand" href="${homeLink}"><span class="marker">/</span> parabun</a>
        <nav class="nav">
          <a href="${homeLink}#stack">stack</a>
          <a href="${homeLink}#runtime-modules">modules</a>
          <a href="${docsLink}">docs</a>
          <a href="${homeLink}#roadmap">roadmap</a>
          <a href="${pathPrefix}configure/">configure</a>
          <a href="https://github.com/airgap/parabun" target="_blank" rel="noopener">github</a>
        </nav>
      </header>
      ${docsNav}
      <article${isDocs ? ' class="docs-content"' : ""}>
        ${body}
      </article>
    </main>
    <button id="lig-fab" class="fab" type="button" aria-pressed="true" title="Toggle contextual ligatures in code">
      ligatures ON
    </button>
    <script>
      (() => {
        const btn = document.getElementById("lig-fab");
        if (!btn) return;
        const root = document.documentElement;
        const sync = on => {
          root.classList.toggle("ligatures", on);
          btn.setAttribute("aria-pressed", on ? "true" : "false");
          btn.textContent = on ? "ligatures ON" : "ligatures OFF";
        };
        sync(root.classList.contains("ligatures"));
        btn.addEventListener("click", () => {
          const next = !root.classList.contains("ligatures");
          sync(next);
          try {
            localStorage.setItem("parabun-ligatures", next ? "on" : "off");
          } catch {}
        });
      })();
    </script>
    <script src="${pathPrefix}fx.js" defer></script>
  </body>
</html>
`;
}

// ─── Build pipeline ───────────────────────────────────────────────────────

async function build(): Promise<void> {
  // Clean output.
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // Copy static assets.
  await cp(join(ROOT, "styles.css"), join(DIST, "styles.css"));
  await cp(join(ROOT, "fx.js"), join(DIST, "fx.js"));

  // Read frontmatter + body from each docs/*.md.
  const docFiles = (await readdir(join(ROOT, "docs"))).filter(f => f.endsWith(".md"));
  type LoadedDoc = { slug: string; meta: { title: string; tagline?: string; section?: string }; body: string };
  const loaded: LoadedDoc[] = [];
  for (const f of docFiles) {
    const raw = await readFile(join(ROOT, "docs", f), "utf8");
    const slug = f.replace(/\.md$/, "");
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
    const meta: { title: string; tagline?: string; section?: string } = { title: slug };
    let body = raw;
    if (fm) {
      body = raw.slice(fm[0].length);
      for (const line of fm[1].split("\n")) {
        const m = /^(\w+):\s*(.+?)\s*$/.exec(line);
        if (!m) continue;
        const [, k, v] = m;
        const val = v.replace(/^"(.*)"$/, "$1");
        if (k === "title") meta.title = val;
        else if (k === "tagline") meta.tagline = val;
        else if (k === "section") meta.section = val;
      }
    }
    loaded.push({ slug, meta, body });
  }
  // Stable sort: index first, then sections in declaration order, then alpha.
  const order = (d: LoadedDoc): number => {
    if (d.slug === "index") return 0;
    if (d.meta.section === "guides") return 1;
    return 2;
  };
  loaded.sort((a, b) => order(a) - order(b) || a.slug.localeCompare(b.slug));

  const pages: DocPageMeta[] = loaded.map(d => ({
    slug: d.slug,
    title: d.meta.title,
    tagline: d.meta.tagline,
    section: d.meta.section === "guides" ? "guides" : "modules",
  }));

  // Render each docs page.
  for (const d of loaded) {
    const isIndex = d.slug === "index";
    const state: RenderState = { headings: [] };
    const html = renderMarkdown(d.body, state);
    const taglineEl = d.meta.tagline ? `<p class="lede">${renderInline(d.meta.tagline)}</p>` : "";
    const titleEl = `<h1>${renderInline(d.meta.title)}</h1>`;
    const article = `${titleEl}${taglineEl}${html}`;
    const pathPrefix = isIndex ? "../" : "../../";
    const shell = pageShell({
      title: d.meta.title === "Parabun docs" ? "Parabun docs" : `${d.meta.title} — Parabun`,
      description: d.meta.tagline ?? d.meta.title,
      body: article,
      isDocs: true,
      pages,
      currentSlug: d.slug,
      pathPrefix,
    });
    const outDir = isIndex ? join(DIST, "docs") : join(DIST, "docs", d.slug);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "index.html"), shell);
  }

  // Copy the existing landing page + configurator verbatim — they're
  // hand-tuned HTML, not Markdown-rendered. The shell we generate is for
  // /docs only.
  const indexHtml = await readFile(join(ROOT, "index.html"), "utf8");
  await writeFile(join(DIST, "index.html"), indexHtml);

  await mkdir(join(DIST, "configure"), { recursive: true });
  const configureHtml = await readFile(join(ROOT, "configure.html"), "utf8");
  await writeFile(join(DIST, "configure", "index.html"), configureHtml);
  await cp(join(ROOT, "styles.css"), join(DIST, "configure", "styles.css"));

  console.log(`[build] ${loaded.length} docs pages, dist/ in ${join(ROOT, "dist")}`);
}

await build();
