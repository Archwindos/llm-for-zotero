import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import { renderRichText } from "../src/render.mjs";
import { runtime } from "./helpers.mjs";

test("Markdown HTML fragments render in XML and XUL owner documents", () => {
  for (const contentType of ["text/html", "application/xhtml+xml", "application/vnd.mozilla.xul+xml"]) {
    const dom = new JSDOM('<html xmlns="http://www.w3.org/1999/xhtml"><body><div></div></body></html>', { contentType });
    try {
      const node = dom.window.document.querySelector("div"); let opened;
      const text = '第一行\n第二行\n\n---\n\nA&nbsp;B &copy;\n\n| 模型 | 公式 |\n| --- | --- |\n| A | $x_i$ |\n\n\\(y_i\\)\n\n$$\\frac{1}{n}$$\n\n\\[\\sqrt{x}\\]\n\n[来源](https://example.test/paper)\n\n<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)" onclick="alert(1)">危险链接</a>';
      assert.doesNotThrow(() => renderRichText(node, text, createDOMPurify(dom.window), url => { opened = url; }), contentType);
      for (const selector of ["br", "hr", "table th", "td .katex", "math", "svg"]) assert.ok(node.querySelector(selector), `${contentType}: ${selector}`);
      assert.equal(node.querySelectorAll(".katex").length, 4); assert.equal(node.querySelectorAll(".katex-display").length, 2);
      assert.match(node.textContent, /A\u00a0B ©/);
      assert.equal(node.querySelector("script, img, [onerror], [onclick]"), null);
      assert.ok(!node.innerHTML.includes("javascript:"));
      assert.equal(node.querySelector("table").namespaceURI, "http://www.w3.org/1999/xhtml");
      assert.equal(node.querySelector("math").namespaceURI, "http://www.w3.org/1998/Math/MathML");
      assert.equal(node.querySelector("svg").namespaceURI, "http://www.w3.org/2000/svg");
      node.querySelector('a[href="https://example.test/paper"]').click(); assert.equal(opened, "https://example.test/paper");
    } finally { dom.window.close(); }
  }
});

test("Markdown headings, lists, tables, links and code render as structured message content", t => {
  const { panel, host } = runtime(t), node = panel.el("div"); let opened;
  host.openExternal = url => { opened = url; };
  panel.renderMarkdown(node, '# 标题\n\n**重点**与*解释*\n\n- 条件一\n- 条件二\n\n| 模型 | 目标 |\n| --- | --- |\n| A | B |\n\n```python\nx = 1\n```\n\n[来源](https://example.test/paper)');
  for (const selector of ["h1", "strong", "em", "ul > li", "table th", "pre > code", "a"]) assert.ok(node.querySelector(selector), selector);
  node.querySelector("a").click(); assert.equal(opened, "https://example.test/paper");
});

test("all four LaTeX delimiters render without Markdown corrupting escapes or subscripts", t => {
  const { panel } = runtime(t), node = panel.el("div");
  panel.renderMarkdown(node, String.raw`预测 $v_\theta$ 与 \(x_i + y_i\)。

$$
\mathcal{L}=\frac{1}{n}\sum_{i=1}^{n}(x_i-y_i)^2
$$

\[
\begin{pmatrix}a&b\\c&d\end{pmatrix}
\]`);
  assert.equal(node.querySelectorAll(".katex").length, 4);
  assert.equal(node.querySelectorAll(".katex-display").length, 2);
  assert.equal(node.querySelectorAll("math").length, 4);
  assert.ok(node.querySelector("msub")); assert.ok(node.querySelector("mfrac")); assert.ok(node.querySelector("mtable"));
  assert.ok(!node.querySelector(".katex-error"));
});

test("math does not alter inline code, code blocks, escaped dollars or currency", t => {
  const { panel } = runtime(t), node = panel.el("div");
  panel.renderMarkdown(node, '`$x_i$` 和 `\\(y\\)`\n\n```latex\n$$z$$\n```\n\n价格 \\$5 and $10。正常 $x$。');
  assert.equal(node.querySelectorAll(".katex").length, 1);
  assert.equal(node.querySelector("pre code").textContent.trim(), "$$z$$");
  assert.match(node.querySelector("code").textContent, /\$x_i\$/);
  assert.ok(node.textContent.includes("$5 and $10"));
});

test("malformed and unfinished formulas remain visible while unsafe HTML and LaTeX stay inert", t => {
  const { panel } = runtime(t), node = panel.el("div");
  panel.renderMarkdown(node, String.raw`**段落** $\badcommand{x}$ 和未完成 \(x_`);
  assert.ok(node.querySelector("strong")); assert.match(node.textContent, /badcommand/); assert.match(node.textContent, /未完成/);
  panel.renderMarkdown(node, String.raw`<img src="https://bad.test/a" onerror="alert(1)"><svg onload="alert(1)"></svg><p style="color:red">正文</p> $\href{javascript:alert(1)}{点击}$ $\includegraphics{https://bad.test/a}$ $\htmlStyle{position:fixed}{x}$`);
  assert.equal(node.querySelector("img,svg,script,iframe,[onclick],[onerror],[onload],a"), null);
  assert.ok(!node.querySelector('p[style]')); assert.ok(!node.querySelector('[style*="fixed"]'));
});
