import { Marked } from "marked";
import katex from "katex";

// Parse math before Markdown can consume LaTeX escapes or underscores. Code
// spans and fenced blocks remain code because Marked handles their boundaries.
export function renderRichText(node, text, purify, openLink) {
  const formulas = [];
  const slot = token => {
    const id = formulas.push(token) - 1;
    return `<span data-llm-math="${id}"></span>${token.display ? "\n" : ""}`;
  };
  const parser = new Marked({ breaks: true, gfm: true, async: false, extensions: [
    {
      name: "mathBlock", level: "block",
      start: src => src.match(/^[ \t]{0,3}(?:\$\$|\\\[)/m)?.index,
      tokenizer(src) {
        const match = /^(?: {0,3})\$\$([\s\S]+?)\$\$(?:[ \t]*(?:\n|$))/.exec(src)
          || /^(?: {0,3})\\\[([\s\S]+?)\\\](?:[ \t]*(?:\n|$))/.exec(src);
        if (match) return { type: "mathBlock", raw: match[0], text: match[1].trim(), display: true };
      }, renderer: slot
    },
    {
      name: "mathInline", level: "inline",
      start: src => src.search(/\$|\\\(|\\\[/),
      tokenizer(src) {
        const display = /^\$\$([\s\S]+?)\$\$/.exec(src) || /^\\\[([\s\S]+?)\\\]/.exec(src);
        const match = display || /^\\\(([\s\S]+?)\\\)/.exec(src)
          || /^\$(?!\$)((?:\\[^\n]|[^\\$\n])+?)\$(?!\d)/.exec(src);
        if (match && match[1].trim() && (src[0] !== "$" || match[1] === match[1].trim())) {
          return { type: "mathInline", raw: match[0], text: match[1], display: !!display };
        }
      }, renderer: slot
    }
  ] });
  const fragment = purify.sanitize(parser.parse(text), {
    ALLOWED_TAGS: ["p", "br", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td", "hr", "a", "span"],
    ALLOWED_ATTR: ["href", "title", "data-llm-math"], ALLOW_DATA_ATTR: false, RETURN_DOM_FRAGMENT: true
  });
  // Only KaTeX's own trusted=false renderer may add math markup and styles.
  // Untrusted message HTML never receives permission to inject them.
  fragment.querySelectorAll("[data-llm-math]").forEach(element => {
    const formula = formulas[Number(element.getAttribute("data-llm-math"))];
    element.removeAttribute("data-llm-math");
    if (!formula) return;
    element.innerHTML = katex.renderToString(formula.text, { displayMode: formula.display, throwOnError: false,
      trust: false, strict: "ignore", maxExpand: 1000, maxSize: 10, output: "htmlAndMathml" });
  });
  // Zotero's XML/XUL document cannot parse ordinary HTML void tags or entities.
  // Build both Markdown and math in the HTML fragment before importing its DOM.
  node.replaceChildren(node.ownerDocument.importNode(fragment, true));
  node.querySelectorAll("a").forEach(a => a.addEventListener("click", event => {
    event.preventDefault(); if (/^https?:\/\//.test(a.href)) openLink(a.href);
  }));
}
