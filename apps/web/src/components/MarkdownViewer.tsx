import {
  Children,
  isValidElement,
  useMemo,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import ReactMarkdown from "react-markdown";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";

import type { ThemeName } from "../utils/theme";
import { MermaidBlock } from "./MermaidBlock";
import {
  extractFrontMatterBlock,
  stripFrontMatter,
} from "../utils/markdownDocument";

interface MarkdownViewerProps {
  markdown: string;
  showFrontMatter: boolean;
  themeName?: ThemeName;
}

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

const outlineStateStorageKeyPrefix = "dacci.viewer.outline";

export function MarkdownViewer(props: MarkdownViewerProps) {
  const frontMatterBlock = useMemo(() => extractFrontMatterBlock(props.markdown), [props.markdown]);
  const visibleMarkdown = useMemo(() => stripFrontMatter(props.markdown), [props.markdown]);
  const hasVisibleContent = visibleMarkdown.trim().length > 0;
  const showFrontMatter = props.showFrontMatter && frontMatterBlock !== null;

  if (!hasVisibleContent && !showFrontMatter) {
    return (
      <div className="reader-empty">
        <p className="muted">This document is empty. Switch to edit mode when you want to start writing.</p>
      </div>
    );
  }

  return (
    <article className="markdown-viewer">
      {showFrontMatter ? (
        <div className="frontmatter-block" aria-label="Document front matter">
          <p className="frontmatter-label">Front matter</p>
          <pre>{frontMatterBlock}</pre>
        </div>
      ) : null}
      {hasVisibleContent ? (
        <ReactMarkdown
          components={{
            a({ href, children, ...rest }) {
              const isExternal = typeof href === "string" && /^https?:\/\//.test(href);
              return (
                <a
                  href={href}
                  rel={isExternal ? "noreferrer" : undefined}
                  target={isExternal ? "_blank" : undefined}
                  {...rest}
                >
                  {children}
                </a>
              );
            },
            h1: createHeading("h1"),
            h2: createHeading("h2"),
            h3: createHeading("h3"),
            h4: createHeading("h4"),
            h5: createHeading("h5"),
            h6: createHeading("h6"),
            pre({ children }) {
              const child = Children.toArray(children)[0];
              if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
                const className = child.props.className ?? "";
                if (className.includes("language-mermaid")) {
                  return <MermaidBlock chart={extractText(child.props.children).replace(/\n$/, "")} />;
                }
              }

              return <pre>{children}</pre>;
            },
            table({ children }) {
              return (
                <div className="markdown-table-wrapper">
                  <table>{children}</table>
                </div>
              );
            },
          }}
          rehypePlugins={[rehypeSlug]}
          remarkPlugins={[remarkGfm]}
        >
          {visibleMarkdown}
        </ReactMarkdown>
      ) : null}
    </article>
  );
}

function buildOutlineStateStorageKey(storageScope: string): string {
  return `${outlineStateStorageKeyPrefix}:${storageScope}`;
}

export function readOutlineOpenState(storageScope: string): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  const rawValue = window.localStorage.getItem(buildOutlineStateStorageKey(storageScope));
  if (rawValue === null) {
    return true;
  }

  try {
    const parsedValue = JSON.parse(rawValue) as unknown;
    if (typeof parsedValue !== "boolean") {
      console.warn("Ignoring invalid saved outline state from localStorage.");
      return true;
    }

    return parsedValue;
  } catch (error) {
    console.warn("Failed to read saved outline state from localStorage.", error);
    return true;
  }
}

export function writeOutlineOpenState(storageScope: string, outlineOpen: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(buildOutlineStateStorageKey(storageScope), JSON.stringify(outlineOpen));
  } catch (error) {
    console.warn("Failed to save outline state to localStorage.", error);
  }
}

function createHeading(tag: HeadingTag) {
  return function Heading(props: HTMLAttributes<HTMLHeadingElement>) {
    const id = props.id ?? slugify(extractText(props.children));
    const Tag = tag;

    return (
      <Tag {...props} id={id}>
        <a aria-label={`Jump to ${extractText(props.children)}`} className="heading-anchor" href={`#${id}`}>
          #
        </a>
        {props.children}
      </Tag>
    );
  };
}

function extractText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }

  if (Array.isArray(children)) {
    return children.map((child) => extractText(child)).join("");
  }

  if (isValidElement<{ children?: ReactNode }>(children)) {
    return extractText(children.props.children);
  }

  return "";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}
