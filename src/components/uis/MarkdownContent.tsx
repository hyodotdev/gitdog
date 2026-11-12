import { useId, useMemo } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { cn } from "../../utils/cn";

// GitHub's GFM tagfilter, plus template and select, which take over HTML parsing
// and would hide or flatten everything after them. These render as literal text.
const FILTERED_TAG =
  /<(?=\/?(?:title|textarea|style|xmp|iframe|noembed|noframes|script|plaintext|template|select)\b)/gi;
const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/;

type MarkdownNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
};

function remarkTagFilter() {
  const visit = (node: MarkdownNode) => {
    if (node.type === "html" && node.value) {
      node.value = node.value.replace(FILTERED_TAG, "&lt;");
    }
    node.children?.forEach(visit);
  };
  return visit;
}

function formatAlert(blockquote: MarkdownNode) {
  const paragraph = blockquote.children?.find(
    (child) => child.type === "element",
  );
  const marker = paragraph?.children?.[0];
  const match =
    paragraph?.tagName === "p" && marker?.type === "text"
      ? marker.value?.match(ALERT_MARKER)
      : null;
  if (!blockquote.children || !marker || !match) return;

  marker.value = marker.value?.slice(match[0].length);
  const label = match[1];
  blockquote.properties = { className: ["markdown-alert"] };
  blockquote.children.unshift({
    type: "element",
    tagName: "p",
    properties: { className: ["markdown-alert-title"] },
    children: [
      { type: "text", value: label[0] + label.slice(1).toLowerCase() },
    ],
  });
}

// Runs after the sanitizer, which prefixes ids but leaves fragment links as they are.
function rehypeGitHubFidelity(idPrefix: string) {
  const visit = (node: MarkdownNode) => {
    const href = node.properties?.href;
    if (node.tagName === "a" && typeof href === "string" && href[0] === "#") {
      node.properties = {
        ...node.properties,
        href: `#${idPrefix}${href.slice(1)}`,
      };
    }
    if (node.tagName === "blockquote") formatAlert(node);
    node.children?.forEach(visit);
  };
  return () => visit;
}

const REMARK_PLUGINS = [remarkGfm, remarkTagFilter];
const REMARK_REHYPE_OPTIONS = { clobberPrefix: "" };

const COMPONENTS: Components = {
  a: ({ node: _node, href, children, ...props }) => {
    const isExternal = href ? /^(?:https?:)?\/\//i.test(href) : false;
    return (
      <a
        {...props}
        href={href}
        // A native hash navigation changes the route key and remounts the page.
        onClick={
          href?.startsWith("#")
            ? (event) => {
                event.preventDefault();
                document
                  .getElementById(decodeURIComponent(href.slice(1)))
                  ?.scrollIntoView();
              }
            : undefined
        }
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer nofollow" : undefined}
      >
        {children}
      </a>
    );
  },
  img: ({ node: _node, alt, ...props }) => (
    <img
      {...props}
      alt={alt ?? ""}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
    />
  ),
  table: ({ node: _node, children, ...props }) => (
    <div className="markdown-table" tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  ),
};

interface MarkdownContentProps {
  children: string;
  className?: string;
}

export function MarkdownContent({ children, className }: MarkdownContentProps) {
  const instanceId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const rehypePlugins = useMemo(() => {
    // Each instance needs its own ids because before and after panes share a page.
    const idPrefix = `user-content-${instanceId}-`;
    return [
      rehypeRaw,
      // GitHub bodies are untrusted, so raw HTML must always pass through the sanitizer.
      [rehypeSanitize, { ...defaultSchema, clobberPrefix: idPrefix }],
      rehypeGitHubFidelity(idPrefix),
    ] as Options["rehypePlugins"];
  }, [instanceId]);

  return (
    <div
      className={cn("prose prose-sm max-w-none markdown-content", className)}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        remarkRehypeOptions={REMARK_REHYPE_OPTIONS}
        rehypePlugins={rehypePlugins}
        components={COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
