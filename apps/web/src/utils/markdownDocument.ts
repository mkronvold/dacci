import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type HeadingItem = {
  depth: number;
  text: string;
  slug: string;
};

type FrontMatterDetails = {
  bom: string;
  body: string;
  hasFrontMatter: boolean;
  hasFrontMatterBlock: boolean;
  rawBlock: string | null;
  rawBody: string | null;
  value: unknown;
  parseError: string | null;
};

export type DocumentTagsInfo = {
  tags: string[];
  hasFrontMatter: boolean;
  hasFrontMatterBlock: boolean;
  parseError: string | null;
};

const frontMatterPattern = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function extractMarkdownHeadings(markdown: string): HeadingItem[] {
  const headings: HeadingItem[] = [];
  const counts = new Map<string, number>();
  let insideFence = false;

  for (const line of markdown.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith("```")) {
      insideFence = !insideFence;
      continue;
    }

    if (insideFence) {
      continue;
    }

    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      continue;
    }

    const hashes = match[1];
    const headingBody = match[2];
    if (!hashes || !headingBody) {
      continue;
    }

    const text = headingBody.replace(/\[(.+?)\]\(.+?\)/g, "$1").trim();
    const baseSlug = slugify(text);
    const currentCount = counts.get(baseSlug) ?? 0;
    counts.set(baseSlug, currentCount + 1);

    headings.push({
      depth: hashes.length,
      text,
      slug: currentCount === 0 ? baseSlug : `${baseSlug}-${currentCount}`,
    });
  }

  return headings;
}

export function stripFrontMatter(markdown: string): string {
  const frontMatter = readFrontMatter(markdown);
  if (!frontMatter.hasFrontMatterBlock) {
    return markdown;
  }

  return `${frontMatter.bom}${frontMatter.body}`;
}

export function extractFrontMatterBlock(markdown: string): string | null {
  const frontMatter = readFrontMatter(markdown);
  if (!frontMatter.hasFrontMatterBlock || !frontMatter.rawBlock) {
    return null;
  }

  return `${frontMatter.bom}${frontMatter.rawBlock}`;
}

export function extractDocumentTags(markdown: string): DocumentTagsInfo {
  const frontMatter = readFrontMatter(markdown);
  if (!frontMatter.hasFrontMatterBlock) {
    return {
      tags: [],
      hasFrontMatter: frontMatter.hasFrontMatter,
      hasFrontMatterBlock: false,
      parseError: frontMatter.parseError,
    };
  }

  if (frontMatter.parseError) {
    return {
      tags: [],
      hasFrontMatter: true,
      hasFrontMatterBlock: true,
      parseError: frontMatter.parseError,
    };
  }

  if (frontMatter.value === null) {
    return {
      tags: [],
      hasFrontMatter: true,
      hasFrontMatterBlock: true,
      parseError: null,
    };
  }

  if (typeof frontMatter.value !== "object" || Array.isArray(frontMatter.value)) {
    return {
      tags: [],
      hasFrontMatter: true,
      hasFrontMatterBlock: true,
      parseError: "Front matter must be a YAML object to manage tags.",
    };
  }

  const candidate = (frontMatter.value as Record<string, unknown>).tags;
  if (candidate === undefined) {
    return {
      tags: [],
      hasFrontMatter: true,
      hasFrontMatterBlock: true,
      parseError: null,
    };
  }

  const rawTags =
    typeof candidate === "string"
      ? [candidate]
      : Array.isArray(candidate) && candidate.every((entry) => typeof entry === "string")
        ? candidate
        : null;

  if (!rawTags) {
    return {
      tags: [],
      hasFrontMatter: true,
      hasFrontMatterBlock: true,
      parseError: "Front matter tags must be a string or string array.",
    };
  }

  try {
    return {
      tags: normalizeTagList(rawTags),
      hasFrontMatter: true,
      hasFrontMatterBlock: true,
      parseError: null,
    };
  } catch (error) {
    return {
      tags: [],
      hasFrontMatter: true,
      hasFrontMatterBlock: true,
      parseError: error instanceof Error ? error.message : "Front matter contains an invalid tag.",
    };
  }
}

export function normalizeDocumentTag(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function updateDocumentTags(markdown: string, nextTagsInput: string[]): string {
  const frontMatter = readFrontMatter(markdown);
  if (frontMatter.parseError) {
    throw new Error(frontMatter.parseError);
  }

  const nextTags = normalizeTagList(nextTagsInput);
  const nextFrontMatterValue = frontMatter.hasFrontMatterBlock
    ? buildEditableFrontMatter(frontMatter.value)
    : {};

  if (nextTags.length > 0) {
    nextFrontMatterValue.tags = nextTags;
  } else {
    delete nextFrontMatterValue.tags;
  }

  const cleanedFrontMatterValue = Object.fromEntries(
    Object.entries(nextFrontMatterValue).filter(([, value]) => value !== undefined),
  );

  if (Object.keys(cleanedFrontMatterValue).length === 0) {
    return `${frontMatter.bom}${frontMatter.body}`;
  }

  const serializedFrontMatter = stringifyYaml(cleanedFrontMatterValue).trimEnd();
  const bodySuffix = frontMatter.body ? `\n${frontMatter.body}` : "\n";
  return `${frontMatter.bom}---\n${serializedFrontMatter}\n---${bodySuffix}`;
}

function buildEditableFrontMatter(value: unknown): Record<string, unknown> {
  if (value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cannot edit tags because the document front matter is not a YAML object.");
  }

  return { ...(value as Record<string, unknown>) };
}

function normalizeTagList(tags: string[]): string[] {
  const normalizedTags: string[] = [];
  const seenTags = new Set<string>();

  for (const tag of tags) {
    const normalizedTag = normalizeDocumentTag(tag);
    if (!normalizedTag) {
      throw new Error("Tags must contain at least one letter or number.");
    }

    if (!seenTags.has(normalizedTag)) {
      seenTags.add(normalizedTag);
      normalizedTags.push(normalizedTag);
    }
  }

  return normalizedTags;
}

function readFrontMatter(markdown: string): FrontMatterDetails {
  const bom = markdown.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = bom ? markdown.slice(1) : markdown;
  const frontMatterMatch = frontMatterPattern.exec(source);

  if (!frontMatterMatch) {
    const hasFrontMatter = /^---[ \t]*\r?\n/.test(source);
    return {
      bom,
      body: source,
      hasFrontMatter,
      hasFrontMatterBlock: false,
      rawBlock: null,
      rawBody: null,
      value: null,
      parseError: hasFrontMatter ? "Front matter is missing a closing delimiter." : null,
    };
  }

  const [, rawBody = ""] = frontMatterMatch;
  let value: unknown = null;
  let parseError: string | null = null;

  try {
    value = rawBody.trim() ? parseYaml(rawBody) : null;
  } catch (error) {
    parseError = `Front matter is invalid: ${error instanceof Error ? error.message : "Unknown error"}`;
  }

  return {
    bom,
    body: source.slice(frontMatterMatch[0].length),
    hasFrontMatter: true,
    hasFrontMatterBlock: true,
    rawBlock: frontMatterMatch[0],
    rawBody,
    value,
    parseError,
  };
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
