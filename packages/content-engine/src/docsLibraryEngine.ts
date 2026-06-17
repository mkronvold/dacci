import { promises as fs } from "node:fs";
import path from "node:path";

import {
  type ContentTag,
  type CreateDocsDraftInput,
  docsStatuses,
  type DocsDocumentVariant,
  type DocsDocumentVariantSummary,
  type DocsDomainNode,
  type DocsLayerNode,
  type DocsLogicalDocumentSummary,
  type DocsStatus,
  type DocsStatusNode,
  type DocsTree,
} from "@dacci/shared-types";
import { parse as parseYaml } from "yaml";

const markdownExtension = ".md";
const promotionOrder: DocsStatus[] = ["draft", "published", "archive"];
const draftStatus: DocsStatus = "draft";
const publishedStatus: DocsStatus = "published";
const archiveStatus: DocsStatus = "archive";

type ParsedDocumentMetadata = {
  title?: string;
  tags: ContentTag[];
  parseError: string | null;
};

type DiscoveredVariant = DocsDocumentVariant & {
  variantSummary: DocsDocumentVariantSummary;
};

export type DocsLibraryErrorCode = "conflict" | "invalid_input" | "not_found";

export class DocsLibraryError extends Error {
  public constructor(
    public readonly code: DocsLibraryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocsLibraryError";
  }
}

export function isDocsLibraryError(error: unknown): error is DocsLibraryError {
  return error instanceof DocsLibraryError;
}

export interface DocsLibraryEngineOptions {
  repoRoot: string;
}

export class DocsLibraryEngine {
  private readonly repoRoot: string;

  public constructor(options: DocsLibraryEngineOptions) {
    this.repoRoot = path.resolve(options.repoRoot);
  }

  public getRepoRoot(): string {
    return this.repoRoot;
  }

  public async getTree(): Promise<DocsTree> {
    await this.ensureRepoRoot();
    const discoveredVariants = await this.discoverVariants();
    const documents = this.buildLogicalSummaries(discoveredVariants);

    return {
      generatedAt: new Date().toISOString(),
      documents,
      statuses: promotionOrder.map((status) => this.buildStatusNode(status, documents)),
    };
  }

  public async getDocumentVariant(status: DocsStatus, logicalPath: string): Promise<DocsDocumentVariant> {
    const normalizedStatus = this.normalizeStatus(status);
    const normalizedLogicalPath = this.normalizeLogicalPath(logicalPath);
    const repoPath = path.posix.join(normalizedStatus, normalizedLogicalPath);
    const absolutePath = this.resolveInsideRepo(repoPath);
    const stats = await this.readRequiredFileStats(absolutePath, repoPath);
    const body = await fs.readFile(absolutePath, "utf8");
    return this.buildVariant(normalizedStatus, normalizedLogicalPath, repoPath, body, stats.size, stats.mtime);
  }

  public async createDraft(input: CreateDocsDraftInput): Promise<DocsDocumentVariant> {
    const logicalPath = this.buildLogicalPath(input.layer, input.domainPath, input.name);
    const repoPath = this.buildRepoPath(draftStatus, logicalPath);
    const absolutePath = this.resolveInsideRepo(repoPath);

    await this.ensureParentDirectory(absolutePath);
    await this.assertFileDoesNotExist(absolutePath, repoPath);
    await fs.writeFile(absolutePath, input.body, "utf8");

    return this.getDocumentVariant(draftStatus, logicalPath);
  }

  public async updateDraft(logicalPath: string, body: string, expectedModifiedAt?: string): Promise<DocsDocumentVariant> {
    return this.writeVariant(draftStatus, logicalPath, body, {
      ...(expectedModifiedAt ? { expectedModifiedAt } : {}),
      requireExisting: true,
    });
  }

  public async savePublishedEdit(logicalPath: string, body: string, expectedModifiedAt?: string): Promise<DocsDocumentVariant> {
    const normalizedLogicalPath = this.normalizeLogicalPath(logicalPath);
    const publishedRepoPath = this.buildRepoPath(publishedStatus, normalizedLogicalPath);
    const publishedStats = await this.readRequiredFileStats(
      this.resolveInsideRepo(publishedRepoPath),
      publishedRepoPath,
    );
    this.assertExpectedModifiedAt(publishedStats.mtime, expectedModifiedAt, publishedRepoPath);

    return this.writeVariant(draftStatus, normalizedLogicalPath, body, {
      requireExisting: false,
    });
  }

  public async publishDraft(logicalPath: string, expectedModifiedAt?: string): Promise<DocsDocumentVariant> {
    const normalizedLogicalPath = this.normalizeLogicalPath(logicalPath);
    const draftRepoPath = this.buildRepoPath(draftStatus, normalizedLogicalPath);
    const publishedRepoPath = this.buildRepoPath(publishedStatus, normalizedLogicalPath);
    const draftAbsolutePath = this.resolveInsideRepo(draftRepoPath);
    const publishedAbsolutePath = this.resolveInsideRepo(publishedRepoPath);
    const draftStats = await this.readRequiredFileStats(draftAbsolutePath, draftRepoPath);
    this.assertExpectedModifiedAt(draftStats.mtime, expectedModifiedAt, draftRepoPath);
    const body = await fs.readFile(draftAbsolutePath, "utf8");

    await this.ensureParentDirectory(publishedAbsolutePath);
    await fs.writeFile(publishedAbsolutePath, body, "utf8");
    await fs.unlink(draftAbsolutePath);
    await this.removeEmptyParentDirectories(path.dirname(draftAbsolutePath), this.resolveInsideRepo(draftStatus));

    return this.getDocumentVariant(publishedStatus, normalizedLogicalPath);
  }

  public async archiveDocument(
    logicalPath: string,
    sourceStatus: DocsStatus = publishedStatus,
    expectedModifiedAt?: string,
  ): Promise<DocsDocumentVariant> {
    const normalizedLogicalPath = this.normalizeLogicalPath(logicalPath);
    const normalizedSourceStatus = this.normalizeStatus(sourceStatus);
    if (normalizedSourceStatus === archiveStatus) {
      throw new DocsLibraryError("invalid_input", "Archive documents cannot be archived again.");
    }

    const sourceRepoPath = this.buildRepoPath(normalizedSourceStatus, normalizedLogicalPath);
    const sourceAbsolutePath = this.resolveInsideRepo(sourceRepoPath);
    const sourceStats = await this.readRequiredFileStats(sourceAbsolutePath, sourceRepoPath);
    this.assertExpectedModifiedAt(sourceStats.mtime, expectedModifiedAt, sourceRepoPath);
    const archiveRepoPath = this.buildRepoPath(archiveStatus, normalizedLogicalPath);
    const archiveAbsolutePath = this.resolveInsideRepo(archiveRepoPath);

    await this.ensureParentDirectory(archiveAbsolutePath);
    await fs.rm(archiveAbsolutePath, { force: true });
    await fs.rename(sourceAbsolutePath, archiveAbsolutePath);
    await this.removeEmptyParentDirectories(path.dirname(sourceAbsolutePath), this.resolveInsideRepo(normalizedSourceStatus));

    return this.getDocumentVariant(archiveStatus, normalizedLogicalPath);
  }

  public async deleteArchivedDocument(logicalPath: string, expectedModifiedAt?: string): Promise<void> {
    const normalizedLogicalPath = this.normalizeLogicalPath(logicalPath);
    const archiveRepoPath = this.buildRepoPath(archiveStatus, normalizedLogicalPath);
    const archiveAbsolutePath = this.resolveInsideRepo(archiveRepoPath);

    const archiveStats = await this.readRequiredFileStats(archiveAbsolutePath, archiveRepoPath);
    this.assertExpectedModifiedAt(archiveStats.mtime, expectedModifiedAt, archiveRepoPath);
    await fs.unlink(archiveAbsolutePath);
    await this.removeEmptyParentDirectories(path.dirname(archiveAbsolutePath), this.resolveInsideRepo(archiveStatus));
  }

  private async ensureRepoRoot(): Promise<void> {
    await fs.mkdir(this.repoRoot, { recursive: true });
  }

  private async writeVariant(
    status: DocsStatus,
    logicalPath: string,
    body: string,
    options: { expectedModifiedAt?: string; requireExisting: boolean },
  ): Promise<DocsDocumentVariant> {
    const normalizedStatus = this.normalizeStatus(status);
    const normalizedLogicalPath = this.normalizeLogicalPath(logicalPath);
    const repoPath = this.buildRepoPath(normalizedStatus, normalizedLogicalPath);
    const absolutePath = this.resolveInsideRepo(repoPath);

    if (options.requireExisting) {
      const existingStats = await this.readRequiredFileStats(absolutePath, repoPath);
      this.assertExpectedModifiedAt(existingStats.mtime, options.expectedModifiedAt, repoPath);
    }

    await this.ensureParentDirectory(absolutePath);
    await fs.writeFile(absolutePath, body, "utf8");

    return this.getDocumentVariant(normalizedStatus, normalizedLogicalPath);
  }

  private assertExpectedModifiedAt(actualModifiedAt: Date, expectedModifiedAt: string | undefined, repoPath: string): void {
    if (expectedModifiedAt === undefined) {
      return;
    }

    const normalizedExpectedModifiedAt = expectedModifiedAt.trim();
    if (!normalizedExpectedModifiedAt) {
      throw new DocsLibraryError("invalid_input", "Expected modified timestamp cannot be empty.");
    }

    const parsedExpectedDate = new Date(normalizedExpectedModifiedAt);
    if (Number.isNaN(parsedExpectedDate.getTime())) {
      throw new DocsLibraryError(
        "invalid_input",
        `Expected modified timestamp '${expectedModifiedAt}' is not a valid ISO timestamp.`,
      );
    }

    const actualTimestamp = actualModifiedAt.toISOString();
    if (actualTimestamp !== parsedExpectedDate.toISOString()) {
      throw new DocsLibraryError(
        "conflict",
        `Document variant '${repoPath}' changed after it was loaded. Refresh it before saving again.`,
      );
    }
  }

  private async discoverVariants(): Promise<DiscoveredVariant[]> {
    const variants: DiscoveredVariant[] = [];

    for (const status of promotionOrder) {
      const statusRoot = this.resolveInsideRepo(status);
      if (!(await this.isDirectoryPath(statusRoot))) {
        continue;
      }

      const relativePaths = await this.walkMarkdownFiles(statusRoot, statusRoot);
      for (const relativePath of relativePaths) {
        const repoPath = path.posix.join(status, relativePath);
        const absolutePath = this.resolveInsideRepo(repoPath);
        const stats = await fs.stat(absolutePath);
        const body = await fs.readFile(absolutePath, "utf8");
        const variant = this.buildVariant(status, relativePath, repoPath, body, stats.size, stats.mtime);
        variants.push({
          ...variant,
          variantSummary: {
            status: variant.status,
            repoPath: variant.repoPath,
            modifiedAt: variant.modifiedAt,
            size: variant.size,
          },
        });
      }
    }

    return variants.sort((left, right) => {
      if (left.logicalPath !== right.logicalPath) {
        return left.logicalPath.localeCompare(right.logicalPath);
      }
      return promotionOrder.indexOf(left.status) - promotionOrder.indexOf(right.status);
    });
  }

  private buildLogicalSummaries(variants: DiscoveredVariant[]): DocsLogicalDocumentSummary[] {
    const groupedVariants = new Map<string, DiscoveredVariant[]>();

    for (const variant of variants) {
      const existingGroup = groupedVariants.get(variant.logicalPath);
      if (existingGroup) {
        existingGroup.push(variant);
      } else {
        groupedVariants.set(variant.logicalPath, [variant]);
      }
    }

    return [...groupedVariants.values()]
      .map((group) => {
        group.sort((left, right) => promotionOrder.indexOf(left.status) - promotionOrder.indexOf(right.status));
        const preferredVariant =
          group.find((candidate) => candidate.status === draftStatus) ??
          group.find((candidate) => candidate.status === publishedStatus) ??
          group[0];
        if (!preferredVariant) {
          throw new DocsLibraryError("not_found", "Failed to resolve a logical document summary.");
        }

        const summary: DocsLogicalDocumentSummary = {
          kind: "logical-document",
          id: preferredVariant.logicalPath,
          name: preferredVariant.name,
          slug: preferredVariant.slug,
          logicalPath: preferredVariant.logicalPath,
          layer: preferredVariant.layer,
          domainPath: preferredVariant.domainPath,
          tags: preferredVariant.tags,
          availableStatuses: group.map((candidate) => candidate.status),
          variants: group.map((candidate) => candidate.variantSummary),
        };

        if (preferredVariant.title) {
          summary.title = preferredVariant.title;
        }

        if (preferredVariant.parseError) {
          summary.parseError = preferredVariant.parseError;
        }

        return summary;
      })
      .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
  }

  private buildStatusNode(status: DocsStatus, documents: DocsLogicalDocumentSummary[]): DocsStatusNode {
    const layerMap = new Map<string, Map<string, DocsLogicalDocumentSummary[]>>();

    for (const document of documents) {
      if (!document.availableStatuses.includes(status)) {
        continue;
      }

      const domainDocuments = this.getOrCreateDomainMap(layerMap, document.layer);
      const existingDocuments = domainDocuments.get(document.domainPath);
      if (existingDocuments) {
        existingDocuments.push(document);
      } else {
        domainDocuments.set(document.domainPath, [document]);
      }
    }

    const layers: DocsLayerNode[] = [...layerMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([layerName, domainMap]) => {
        const domains: DocsDomainNode[] = [...domainMap.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([domainPath, domainDocuments]) => ({
            kind: "domain",
            name: path.posix.basename(domainPath),
            path: path.posix.join(status, layerName, domainPath),
            documents: [...domainDocuments].sort((left, right) => left.logicalPath.localeCompare(right.logicalPath)),
          }));

        return {
          kind: "layer",
          name: layerName,
          path: path.posix.join(status, layerName),
          domains,
        };
      });

    return {
      kind: "status",
      status,
      path: status,
      layers,
    };
  }

  private getOrCreateDomainMap(
    layerMap: Map<string, Map<string, DocsLogicalDocumentSummary[]>>,
    layerName: string,
  ): Map<string, DocsLogicalDocumentSummary[]> {
    const existingDomainMap = layerMap.get(layerName);
    if (existingDomainMap) {
      return existingDomainMap;
    }

    const nextDomainMap = new Map<string, DocsLogicalDocumentSummary[]>();
    layerMap.set(layerName, nextDomainMap);
    return nextDomainMap;
  }

  private buildVariant(
    status: DocsStatus,
    logicalPath: string,
    repoPath: string,
    body: string,
    size: number,
    modifiedAt: Date,
  ): DocsDocumentVariant {
    const normalizedLogicalPath = this.normalizeLogicalPath(logicalPath);
    const segments = normalizedLogicalPath.split("/");
    const name = segments.at(-1);
    const layer = segments[0];
    const domainSegments = segments.slice(1, -1);
    if (!name || !layer || domainSegments.length === 0) {
      throw new DocsLibraryError(
        "invalid_input",
        `Document path '${normalizedLogicalPath}' must follow '<layer>/<domain>/<slug>.md'.`,
      );
    }

    const metadata = this.parseDocumentMetadata(body, repoPath);
    const variant: DocsDocumentVariant = {
      status,
      repoPath,
      modifiedAt: modifiedAt.toISOString(),
      size,
      logicalPath: normalizedLogicalPath,
      name,
      slug: name.slice(0, -markdownExtension.length),
      layer,
      domainPath: domainSegments.join("/"),
      tags: metadata.tags,
      body,
    };

    if (metadata.title) {
      variant.title = metadata.title;
    }

    if (metadata.parseError) {
      variant.parseError = metadata.parseError;
    }

    return variant;
  }

  private parseDocumentMetadata(body: string, documentPath: string): ParsedDocumentMetadata {
    const frontMatterMatch = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
    if (!frontMatterMatch) {
      if (/^(?:\uFEFF)?---[ \t]*\r?\n/.test(body)) {
        return {
          tags: [],
          parseError: `Document '${documentPath}' starts with front matter but is missing a closing delimiter.`,
        };
      }

      return {
        tags: [],
        parseError: null,
      };
    }

    try {
      const parsedFrontMatter = frontMatterMatch[1]?.trim() ? parseYaml(frontMatterMatch[1]) : null;
      if (!parsedFrontMatter || typeof parsedFrontMatter !== "object" || Array.isArray(parsedFrontMatter)) {
        return {
          tags: [],
          parseError: null,
        };
      }

      const record = parsedFrontMatter as Record<string, unknown>;
      const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : undefined;
      const rawTags = this.extractRawTags(record.tags, documentPath);
      return title
        ? {
            title,
            tags: this.normalizeTags(rawTags, documentPath),
            parseError: null,
          }
        : {
            tags: this.normalizeTags(rawTags, documentPath),
            parseError: null,
          };
    } catch (error) {
      return {
        tags: [],
        parseError: `Document '${documentPath}' has invalid front matter: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  private extractRawTags(candidate: unknown, documentPath: string): string[] {
    if (candidate === undefined) {
      return [];
    }

    if (typeof candidate === "string") {
      return [candidate];
    }

    if (Array.isArray(candidate) && candidate.every((entry) => typeof entry === "string")) {
      return candidate;
    }

    throw new DocsLibraryError(
      "invalid_input",
      `Document '${documentPath}' must declare tags as a string or string array in front matter.`,
    );
  }

  private normalizeTags(tags: string[], documentPath: string): ContentTag[] {
    const normalizedTags: ContentTag[] = [];
    const seenTags = new Set<string>();

    for (const tag of tags) {
      const normalizedTag = tag
        .toLowerCase()
        .trim()
        .replace(/[\s_]+/g, "-")
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      if (!normalizedTag) {
        throw new DocsLibraryError("invalid_input", `Document '${documentPath}' contains an empty or invalid tag.`);
      }

      if (!seenTags.has(normalizedTag)) {
        seenTags.add(normalizedTag);
        normalizedTags.push(normalizedTag);
      }
    }

    return normalizedTags;
  }

  private buildLogicalPath(layer: string, domainPath: string, name: string): string {
    const normalizedLayer = this.normalizeSegment(layer, "layer");
    const normalizedDomainPath = this.normalizeDomainPath(domainPath);
    const normalizedDocumentName = this.normalizeDocumentName(name);
    return path.posix.join(normalizedLayer, normalizedDomainPath, normalizedDocumentName);
  }

  private normalizeLogicalPath(logicalPath: string): string {
    if (typeof logicalPath !== "string") {
      throw new DocsLibraryError("invalid_input", "Document path must be a string.");
    }

    const normalizedValue = logicalPath
      .trim()
      .replaceAll("\\", "/")
      .replace(/^\/+|\/+$/g, "");
    if (!normalizedValue) {
      throw new DocsLibraryError("invalid_input", "Document path is required.");
    }

    const segments = normalizedValue.split("/");
    if (segments.some((segment) => segment === "." || segment === ".." || segment.trim() === "")) {
      throw new DocsLibraryError("invalid_input", `Document path '${logicalPath}' is not valid.`);
    }

    const fileName = segments.at(-1);
    const layer = segments[0];
    const domainSegments = segments.slice(1, -1);
    if (!fileName || !fileName.endsWith(markdownExtension) || !layer || domainSegments.length === 0) {
      throw new DocsLibraryError(
        "invalid_input",
        `Document path '${logicalPath}' must follow '<layer>/<domain>/<slug>.md'.`,
      );
    }

    return normalizedValue;
  }

  private normalizeDomainPath(domainPath: string): string {
    if (typeof domainPath !== "string") {
      throw new DocsLibraryError("invalid_input", "Domain path must be a string.");
    }

    const normalizedValue = domainPath
      .trim()
      .replaceAll("\\", "/")
      .replace(/^\/+|\/+$/g, "");
    if (!normalizedValue) {
      throw new DocsLibraryError("invalid_input", "Domain path is required.");
    }

    return normalizedValue
      .split("/")
      .map((segment) => this.normalizeSegment(segment, "domain"))
      .join("/");
  }

  private normalizeDocumentName(name: string): string {
    const normalizedName = this.normalizeSegment(name.replace(/\.md$/i, ""), "document");
    return `${normalizedName}${markdownExtension}`;
  }

  private normalizeSegment(value: string, label: string): string {
    if (typeof value !== "string") {
      throw new DocsLibraryError("invalid_input", `${label} must be a string.`);
    }

    const normalizedValue = value
      .toLowerCase()
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (!normalizedValue) {
      throw new DocsLibraryError("invalid_input", `${label} is required.`);
    }

    return normalizedValue;
  }

  private normalizeStatus(status: DocsStatus): DocsStatus {
    if (!docsStatuses.includes(status)) {
      throw new DocsLibraryError(
        "invalid_input",
        `Document status must be one of: ${docsStatuses.join(", ")}.`,
      );
    }

    return status;
  }

  private buildRepoPath(status: DocsStatus, logicalPath: string): string {
    return path.posix.join(this.normalizeStatus(status), this.normalizeLogicalPath(logicalPath));
  }

  private resolveInsideRepo(...segments: string[]): string {
    const resolvedPath = path.resolve(this.repoRoot, ...segments);
    const relativePath = path.relative(this.repoRoot, resolvedPath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new DocsLibraryError("invalid_input", "Resolved path escapes the configured repository root.");
    }

    return resolvedPath;
  }

  private async ensureParentDirectory(targetPath: string): Promise<void> {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
  }

  private async assertFileDoesNotExist(absolutePath: string, repoPath: string): Promise<void> {
    try {
      const stats = await fs.stat(absolutePath);
      if (stats.isFile()) {
        throw new DocsLibraryError("conflict", `Document '${repoPath}' already exists.`);
      }
      throw new DocsLibraryError("conflict", `Path '${repoPath}' already exists and is not a file.`);
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }

      throw error;
    }
  }

  private async readRequiredFileStats(absolutePath: string, repoPath: string) {
    try {
      const stats = await fs.stat(absolutePath);
      if (!stats.isFile()) {
        throw new DocsLibraryError("conflict", `Path '${repoPath}' exists but is not a file.`);
      }
      return stats;
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new DocsLibraryError("not_found", `Document '${repoPath}' was not found.`);
      }

      throw error;
    }
  }

  private async isDirectoryPath(candidatePath: string): Promise<boolean> {
    try {
      return (await fs.stat(candidatePath)).isDirectory();
    } catch {
      return false;
    }
  }

  private async walkMarkdownFiles(rootPath: string, currentPath: string): Promise<string[]> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.walkMarkdownFiles(rootPath, absolutePath)));
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(markdownExtension)) {
        files.push(path.relative(rootPath, absolutePath).replaceAll(path.sep, "/"));
      }
    }

    return files;
  }

  private async removeEmptyParentDirectories(candidatePath: string, stopPath: string): Promise<void> {
    let currentPath = candidatePath;
    const normalizedStopPath = path.resolve(stopPath);

    while (currentPath.startsWith(normalizedStopPath) && currentPath !== normalizedStopPath) {
      const entries = await fs.readdir(currentPath);
      if (entries.length > 0) {
        return;
      }

      await fs.rmdir(currentPath);
      currentPath = path.dirname(currentPath);
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }

  return (error as { code?: string }).code === "ENOENT";
}
