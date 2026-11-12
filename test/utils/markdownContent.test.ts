import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "../../src/components/uis/MarkdownContent";

function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(MarkdownContent, { children: markdown }),
  );
}

describe("MarkdownContent", () => {
  it("renders GFM tables instead of literal pipes", () => {
    const html = render(
      "| Check | Coverage |\n| --- | --- |\n| Receipt `ENTITLED` | Passed |",
    );

    expect(html).toContain('<div class="markdown-table" tabindex="0"><table>');
    expect(html).toContain("<th>Check</th>");
    expect(html).toContain("<code>ENTITLED</code>");
    expect(html).not.toContain("| ---");
  });

  it("renders task lists and strikethrough", () => {
    const html = render("- [x] Done\n- [ ] Todo\n\n~~old~~");

    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<del>old</del>");
  });

  it("keeps GitHub's safe HTML and drops comments", () => {
    const html = render(
      "<!-- Edited by gitdog.dev -->\n\n<details><summary>Logs</summary>\n\nBody\n\n</details>\n\nH<sub>2</sub>O",
    );

    expect(html).toContain("<details>");
    expect(html).toContain("<summary>Logs</summary>");
    expect(html).toContain("<sub>2</sub>");
    expect(html).not.toContain("Edited by gitdog.dev");
  });

  it("removes scripts, event handlers, and javascript links", () => {
    const html = render(
      '<script>alert(1)</script>\n\n<img src="https://example.com/a.png" onerror="alert(2)">\n\n<iframe src="https://example.com"></iframe>\n\n[click](javascript:alert(3))\n\n<a href="javascript:alert(4)">raw</a>',
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("javascript:");
  });

  it("shows GitHub's filtered tags as text without losing nearby content", () => {
    const html = render(
      "Before <script> tag and <title> text.\n\nUse <textarea> here.",
    );

    expect(html).toContain("Before &lt;script&gt; tag and &lt;title&gt; text.");
    expect(html).toContain("Use &lt;textarea&gt; here.");
  });

  it("keeps content after template and select tags", () => {
    const html = render(
      "Use the <template> tag.\n\nBug in <select> here.\n\n**Next** survives.\n\n- item",
    );

    expect(html).toContain("&lt;template&gt; tag.");
    expect(html).toContain("&lt;select&gt; here.");
    expect(html).toContain("<strong>Next</strong> survives.");
    expect(html).toContain("<li>item</li>");
  });

  it("points footnote links at the prefixed ids", () => {
    const html = render("Claim[^1]\n\n[^1]: Source");
    const href = html.match(/href="#([^"]*fn-1)"/)?.[1];

    expect(href).toBeTruthy();
    expect(html).toContain(`id="${href}"`);
    expect(html).not.toContain("user-content-user-content");
  });

  it("marks loose task lists and GitHub alerts", () => {
    const html = render("- [x] a\n\n- [ ] b\n\n> [!WARNING]\n> Careful");

    expect(html).toContain('class="task-list-item"');
    expect(html).toContain('class="markdown-alert"');
    expect(html).toContain('<p class="markdown-alert-title">Warning</p>');
    expect(html).not.toContain("[!WARNING]");
  });

  it("treats protocol-relative links as external", () => {
    expect(render("[x](//example.com/a)")).toContain('target="_blank"');
  });

  it("opens external links safely and lazy-loads images", () => {
    const html = render(
      "[docs](https://example.com) ![shot](https://example.com/a.png)",
    );

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('loading="lazy"');
  });
});
