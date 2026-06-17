import { promises as fs } from "node:fs";
import path from "node:path";

import JSZip from "jszip";
import { parse as parseYaml } from "yaml";
import {
  exportFormats,
  importConflictModes,
  importFormats,
  importFolderMappingModes,
  ContentExportBundle,
  ContentDocument,
  ContentDocumentSummary,
  ContentEngineSummary,
  ContentSearchResponse,
  ContentSearchResult,
  type ContentTag,
  ContentSubtopicNode,
  ContentTopicNode,
  ContentTree,
  DirectImportDocumentsRequest,
  ExportDocumentsRequest,
  ExportDocumentsResponse,
  ExportFormat,
  ExportScope,
  ImportFormat,
  ImportConflictMode,
  ImportFolderMappingMode,
  ImportDocumentsRequest,
  ImportDocumentsResponse,
  ZipArchiveExportResponse,
} from "@dacci/shared-types";

export * from "./docsLibraryEngine.js";

const CATCH_ALL_SUBTOPIC_NAME = "CatchAll";
const GITKEEP_FILE_NAME = ".gitkeep";

type ContentLocation = {
  topicName: string;
  subtopicName?: string;
};

type PreparedImportDocument = {
  body: string;
  logicalPath: string;
  storageRelativePath: string;
};

type ParsedDocumentContent = {
  rawBody: string;
  visibleBody: string;
  tags: ContentTag[];
  parseError: string | null;
};

type ParsedSearchQuery = {
  rawQuery: string;
  normalizedQuery: string;
  tagOnly: boolean;
  normalizedTagQuery: string;
};

type ExportArchiveManifest = {
  version: 1;
  generatedAt: string;
  exportName: string;
  scope: ExportScope;
  documents: Array<{
    path: string;
  }>;
};

export interface ContentEngineOptions {
  dataRoot: string;
}

export interface CreateDocumentInput {
  topicName: string;
  subtopicName?: string;
  name: string;
  body: string;
}

export interface MoveDocumentInput {
  topicName: string;
  subtopicName?: string;
}

export type ContentEngineErrorCode = "conflict" | "invalid_input" | "not_found";

export class ContentEngineError extends Error {
  public constructor(
    public readonly code: ContentEngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ContentEngineError";
  }
}

export function isContentEngineError(error: unknown): error is ContentEngineError {
  return error instanceof ContentEngineError;
}

export class ContentEngine {
  private readonly dataRoot: string;

  public constructor(options: ContentEngineOptions) {
    this.dataRoot = path.resolve(options.dataRoot);
  }

  public getDataRoot(): string {
    return this.dataRoot;
  }

  public async getSummary(): Promise<ContentEngineSummary> {
    const tree = await this.getTree();
    const documentCount = tree.topics.reduce((count, topic) => {
      const topicDocumentCount = topic.documents.length;
      const subtopicDocumentCount = topic.subtopics.reduce(
        (subtopicCount, subtopic) => subtopicCount + subtopic.documents.length,
        0,
      );

      return count + topicDocumentCount + subtopicDocumentCount;
    }, 0);

    return {
      dataRoot: this.dataRoot,
      topicCount: tree.topics.length,
      documentCount,
    };
  }

  public async getTree(): Promise<ContentTree> {
    await this.ensureDataRoot();

    const topics = await this.readTopics();

    return {
      generatedAt: new Date().toISOString(),
      topics,
    };
  }

  public async getDocument(relativeDocumentPath: string): Promise<ContentDocument> {
    const resolvedDocument = await this.resolveExistingDocument(relativeDocumentPath);

    const [body, stats] = await Promise.all([
      fs.readFile(resolvedDocument.absoluteDocumentPath, "utf8"),
      fs.stat(resolvedDocument.absoluteDocumentPath),
    ]);

    return this.buildDocument(
      resolvedDocument.storageRelativePath,
      resolvedDocument.location,
      body,
      stats.size,
      stats.mtime,
    );
  }

  public async searchDocuments(query: string): Promise<ContentSearchResponse> {
    const parsedQuery = this.parseSearchQuery(query);

    const tree = await this.getTree();
    const summaries = this.collectDocumentSummaries(tree);
    const documents = await Promise.all(summaries.map((summary) => this.getDocument(summary.path)));
    const results = documents
      .map((document) => this.buildSearchResult(document, parsedQuery))
      .filter((result): result is ContentSearchResult => result !== null)
      .sort((left, right) => left.document.path.localeCompare(right.document.path));

    return {
      query: parsedQuery.rawQuery,
      generatedAt: new Date().toISOString(),
      results,
    };
  }

  public async importDocuments(input: ImportDocumentsRequest): Promise<ImportDocumentsResponse> {
    const format = this.normalizeImportFormat(input.format);
    const conflictMode = this.normalizeImportConflictMode(input.conflictMode);

    if (format === "documents") {
      const directInput = input as DirectImportDocumentsRequest;
      if (directInput.documents.length === 0) {
        throw new ContentEngineError("invalid_input", "At least one document is required for import.");
      }

      const folderMappingMode = this.normalizeImportFolderMappingMode(directInput.folderMappingMode);
      const preparedDocuments = await this.prepareDirectImportDocuments(directInput, folderMappingMode);
      return this.applyPreparedImportDocuments(preparedDocuments, {
        conflictMode,
        format,
        folderMappingMode,
      });
    }

    const preparedDocuments =
      format === "bundle-json" && "bundle" in input
        ? this.prepareBundleImportDocuments(input.bundle)
        : format === "bundle-zip" && "archiveBase64" in input
          ? this.prepareBundleImportDocuments(await this.readArchiveBundle(input.archiveBase64))
          : (() => {
              throw new ContentEngineError("invalid_input", "The import payload does not match the selected format.");
            })();

    return this.applyPreparedImportDocuments(preparedDocuments, {
      conflictMode,
      format,
    });
  }

  public async exportDocuments(scope: ExportScope): Promise<ContentExportBundle> {
    const normalizedScope = this.normalizeExportScope(scope);
    const documents = await this.readDocumentsForExportScope(normalizedScope);

    return {
      generatedAt: new Date().toISOString(),
      exportName: this.buildExportName(normalizedScope),
      scope: normalizedScope,
      documents,
    };
  }

  public async exportTransfer(request: ExportDocumentsRequest): Promise<ExportDocumentsResponse> {
    const format = this.normalizeExportFormat(request.format);
    const bundle = await this.exportDocuments(request);

    if (format === "bundle-json") {
      return {
        ...bundle,
        format,
        fileName: `${bundle.exportName}.json`,
      };
    }

    const archive = await this.buildArchiveFromBundle(bundle);
    const response: ZipArchiveExportResponse = {
      format,
      exportName: bundle.exportName,
      fileName: `${bundle.exportName}.zip`,
      mediaType: "application/zip",
      contentBase64: archive.toString("base64"),
      documentCount: bundle.documents.length,
      scope: bundle.scope,
    };

    return response;
  }

  public async createTopic(name: string): Promise<ContentTopicNode> {
    const topicName = this.normalizeSegmentName(name, "topic");
    const topicPath = this.resolveInsideDataRoot(topicName);

    await this.ensureDataRoot();
    await this.createDirectory(topicPath, topicName);

    return {
      kind: "topic",
      name: topicName,
      path: topicName,
      documents: [],
      subtopics: [],
    };
  }

  public async createSubtopic(topicName: string, subtopicName: string): Promise<ContentSubtopicNode> {
    const normalizedTopicName = this.normalizeSegmentName(topicName, "topic");
    const normalizedSubtopicName = this.normalizeSubtopicName(subtopicName);
    const topicPath = this.resolveInsideDataRoot(normalizedTopicName);

    await this.assertExistingDirectory(topicPath, normalizedTopicName);

    const subtopicPath = this.resolveInsideDataRoot(normalizedTopicName, normalizedSubtopicName);
    await this.createDirectory(subtopicPath, path.posix.join(normalizedTopicName, normalizedSubtopicName));

    return {
      kind: "subtopic",
      name: normalizedSubtopicName,
      path: path.posix.join(normalizedTopicName, normalizedSubtopicName),
      documents: [],
    };
  }

  public async createDocument(input: CreateDocumentInput): Promise<ContentDocument> {
    const normalizedTopicName = this.normalizeSegmentName(input.topicName, "topic");
    const normalizedSubtopicName = input.subtopicName
      ? this.normalizeSubtopicName(input.subtopicName)
      : undefined;
    const normalizedFileName = this.normalizeDocumentName(input.name);
    const targetRelativePath = this.buildDocumentStoragePath(
      normalizedTopicName,
      normalizedFileName,
      normalizedSubtopicName,
    );
    const logicalTargetPath = this.buildLogicalDocumentPath(
      normalizedTopicName,
      normalizedFileName,
      normalizedSubtopicName,
    );
    const absoluteDocumentPath = this.resolveInsideDataRoot(targetRelativePath);

    await this.ensureTargetDocumentDirectory(normalizedTopicName, normalizedSubtopicName);
    await this.writeNewFile(absoluteDocumentPath, input.body, targetRelativePath);

    return this.getDocument(logicalTargetPath);
  }

  public async updateDocument(relativeDocumentPath: string, body: string): Promise<ContentDocument> {
    const resolvedDocument = await this.resolveExistingDocument(relativeDocumentPath);

    await fs.writeFile(resolvedDocument.absoluteDocumentPath, body, "utf8");

    return this.getDocument(resolvedDocument.logicalRelativePath);
  }

  public async renameDocument(
    relativeDocumentPath: string,
    nextName: string,
  ): Promise<ContentDocument> {
    const resolvedDocument = await this.resolveExistingDocument(relativeDocumentPath);
    const normalizedFileName = this.normalizeDocumentName(nextName);
    const currentDirectory = path.posix.dirname(resolvedDocument.storageRelativePath);
    const nextStorageRelativePath = path.posix.join(currentDirectory, normalizedFileName);
    const nextLogicalPath = this.buildLogicalDocumentPath(
      resolvedDocument.location.topicName,
      normalizedFileName,
      resolvedDocument.location.subtopicName,
    );
    const nextAbsolutePath = this.resolveInsideDataRoot(nextStorageRelativePath);

    await this.assertFileDoesNotExist(nextAbsolutePath, nextStorageRelativePath);
    await fs.rename(resolvedDocument.absoluteDocumentPath, nextAbsolutePath);

    return this.getDocument(nextLogicalPath);
  }

  public async moveDocument(
    relativeDocumentPath: string,
    destination: MoveDocumentInput,
  ): Promise<ContentDocument> {
    const resolvedDocument = await this.resolveExistingDocument(relativeDocumentPath);
    const targetTopicName = this.normalizeSegmentName(destination.topicName, "topic");
    const targetSubtopicName = destination.subtopicName
      ? this.normalizeSubtopicName(destination.subtopicName)
      : undefined;
    const fileName = path.posix.basename(resolvedDocument.storageRelativePath);
    const targetRelativePath = this.buildDocumentStoragePath(
      targetTopicName,
      fileName,
      targetSubtopicName,
    );
    const targetLogicalPath = this.buildLogicalDocumentPath(
      targetTopicName,
      fileName,
      targetSubtopicName,
    );
    const targetAbsolutePath = this.resolveInsideDataRoot(targetRelativePath);

    await this.ensureTargetDocumentDirectory(targetTopicName, targetSubtopicName);
    await this.assertFileDoesNotExist(targetAbsolutePath, targetRelativePath);
    await fs.rename(resolvedDocument.absoluteDocumentPath, targetAbsolutePath);
    await this.ensureGitkeepForLocation(resolvedDocument.location);

    return this.getDocument(targetLogicalPath);
  }

  public async deleteDocument(relativeDocumentPath: string): Promise<void> {
    const resolvedDocument = await this.resolveExistingDocument(relativeDocumentPath);
    await fs.unlink(resolvedDocument.absoluteDocumentPath);
    await this.ensureGitkeepForLocation(resolvedDocument.location);
  }

  public async renameTopic(currentName: string, nextName: string): Promise<ContentTopicNode> {
    const normalizedCurrentName = this.normalizeSegmentName(currentName, "topic");
    const normalizedNextName = this.normalizeSegmentName(nextName, "topic");
    const currentPath = this.resolveInsideDataRoot(normalizedCurrentName);
    const nextPath = this.resolveInsideDataRoot(normalizedNextName);

    await this.assertExistingDirectory(currentPath, normalizedCurrentName);
    await this.assertDirectoryDoesNotExist(nextPath, normalizedNextName);
    await fs.rename(currentPath, nextPath);

    const tree = await this.getTree();
    const topic = tree.topics.find((candidate) => candidate.name === normalizedNextName);
    if (!topic) {
      throw new ContentEngineError("not_found", `Topic '${normalizedNextName}' was not found after rename.`);
    }

    return topic;
  }

  public async renameSubtopic(
    topicName: string,
    currentName: string,
    nextName: string,
  ): Promise<ContentSubtopicNode> {
    const normalizedTopicName = this.normalizeSegmentName(topicName, "topic");
    const normalizedCurrentName = this.normalizeSubtopicName(currentName);
    const normalizedNextName = this.normalizeSubtopicName(nextName);
    const currentPath = this.resolveInsideDataRoot(normalizedTopicName, normalizedCurrentName);
    const nextPath = this.resolveInsideDataRoot(normalizedTopicName, normalizedNextName);

    await this.assertExistingDirectory(currentPath, path.posix.join(normalizedTopicName, normalizedCurrentName));
    await this.assertDirectoryDoesNotExist(nextPath, path.posix.join(normalizedTopicName, normalizedNextName));
    await fs.rename(currentPath, nextPath);

    const tree = await this.getTree();
    const topic = tree.topics.find((candidate) => candidate.name === normalizedTopicName);
    const subtopic = topic?.subtopics.find((candidate) => candidate.name === normalizedNextName);
    if (!subtopic) {
      throw new ContentEngineError(
        "not_found",
        `Subtopic '${normalizedNextName}' was not found after rename.`,
      );
    }

    return subtopic;
  }

  public async deleteTopic(topicName: string): Promise<void> {
    const normalizedTopicName = this.normalizeSegmentName(topicName, "topic");
    const topicPath = this.resolveInsideDataRoot(normalizedTopicName);

    await this.assertExistingDirectory(topicPath, normalizedTopicName);
    await fs.rm(topicPath, { recursive: true, force: false });
  }

  public async deleteSubtopic(topicName: string, subtopicName: string): Promise<void> {
    const normalizedTopicName = this.normalizeSegmentName(topicName, "topic");
    const normalizedSubtopicName = this.normalizeSubtopicName(subtopicName);
    const subtopicPath = this.resolveInsideDataRoot(normalizedTopicName, normalizedSubtopicName);

    await this.assertExistingDirectory(
      subtopicPath,
      path.posix.join(normalizedTopicName, normalizedSubtopicName),
    );
    await fs.rm(subtopicPath, { recursive: true, force: false });
  }

  private async ensureDataRoot(): Promise<void> {
    await fs.mkdir(this.dataRoot, { recursive: true });
  }

  private async readTopics(): Promise<ContentTopicNode[]> {
    const entries = await fs.readdir(this.dataRoot, { withFileTypes: true });
    const topics = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (entry) => this.readTopic(entry.name)),
    );

    return topics;
  }

  private collectDocumentSummaries(tree: ContentTree): ContentDocumentSummary[] {
    return tree.topics.flatMap((topic) => [
      ...topic.documents,
      ...topic.subtopics.flatMap((subtopic) => subtopic.documents),
    ]);
  }

  private async readTopic(topicName: string): Promise<ContentTopicNode> {
    const topicPath = this.resolveInsideDataRoot(topicName);
    const entries = await fs.readdir(topicPath, { withFileTypes: true });

    const documents: ContentDocumentSummary[] = [];
    const subtopics: ContentSubtopicNode[] = [];

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      if (entry.isFile() && this.isMarkdownFile(entry.name)) {
        documents.push(await this.readDocumentSummary(path.posix.join(topicName, entry.name)));
        continue;
      }

      if (!entry.isDirectory()) {
        continue;
      }

      if (entry.name === CATCH_ALL_SUBTOPIC_NAME) {
        const catchAllDocuments = await this.readDocumentSummariesInDirectory(
          path.posix.join(topicName, entry.name),
          { topicName },
        );
        documents.push(...catchAllDocuments);
        continue;
      }

      subtopics.push(await this.readSubtopic(topicName, entry.name));
    }

    return {
      kind: "topic",
      name: topicName,
      path: topicName,
      documents: this.sortDocuments(documents),
      subtopics: subtopics.sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  private async readSubtopic(topicName: string, subtopicName: string): Promise<ContentSubtopicNode> {
    const documents = await this.readDocumentSummariesInDirectory(
      path.posix.join(topicName, subtopicName),
      {
        topicName,
        subtopicName,
      },
    );

    return {
      kind: "subtopic",
      name: subtopicName,
      path: path.posix.join(topicName, subtopicName),
      documents,
    };
  }

  private async readDocumentSummariesInDirectory(
    relativeDirectoryPath: string,
    location: ContentLocation,
  ): Promise<ContentDocumentSummary[]> {
    const absoluteDirectoryPath = this.resolveInsideDataRoot(relativeDirectoryPath);
    const entries = await fs.readdir(absoluteDirectoryPath, { withFileTypes: true });
    const documents = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && this.isMarkdownFile(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (entry) =>
          this.readDocumentSummary(path.posix.join(relativeDirectoryPath, entry.name), location),
        ),
    );

    return this.sortDocuments(documents);
  }

  private async readDocumentSummary(
    relativeDocumentPath: string,
    location = this.logicalLocationFromStoragePath(relativeDocumentPath),
  ): Promise<ContentDocumentSummary> {
    const absoluteDocumentPath = this.resolveInsideDataRoot(relativeDocumentPath);
    const [body, stats] = await Promise.all([
      fs.readFile(absoluteDocumentPath, "utf8"),
      fs.stat(absoluteDocumentPath),
    ]);

    return this.buildDocumentSummary(relativeDocumentPath, location, body, stats.size, stats.mtime);
  }

  private async readSkippedImportSummary(relativeDocumentPath: string): Promise<ContentDocumentSummary> {
    try {
      return await this.getDocument(relativeDocumentPath);
    } catch (error) {
      if (!isContentEngineError(error) || error.code !== "invalid_input") {
        throw error;
      }

      const resolvedDocument = await this.resolveExistingDocument(relativeDocumentPath);
      const stats = await fs.stat(resolvedDocument.absoluteDocumentPath);

      return this.buildMetadataOnlyDocumentSummary(
        resolvedDocument.storageRelativePath,
        resolvedDocument.location,
        stats.size,
        stats.mtime,
      );
    }
  }

  private buildDocument(
    relativeDocumentPath: string,
    location: ContentLocation,
    body: string,
    size: number,
    modifiedAt: Date,
  ): ContentDocument {
    return {
      ...this.buildDocumentSummary(relativeDocumentPath, location, body, size, modifiedAt),
      body,
    };
  }

  private buildMetadataOnlyDocumentSummary(
    relativeDocumentPath: string,
    location: ContentLocation,
    size: number,
    modifiedAt: Date,
  ): ContentDocumentSummary {
    const logicalRelativePath = this.buildLogicalDocumentPath(
      location.topicName,
      path.posix.basename(relativeDocumentPath),
      location.subtopicName,
    );
    const summary: ContentDocumentSummary = {
      kind: "document",
      id: logicalRelativePath,
      name: path.posix.basename(relativeDocumentPath),
      path: logicalRelativePath,
      topicName: location.topicName,
      tags: [],
      modifiedAt: modifiedAt.toISOString(),
      size,
    };

    if (location.subtopicName) {
      summary.subtopicName = location.subtopicName;
    }

    return summary;
  }

  private buildDocumentSummary(
    relativeDocumentPath: string,
    location: ContentLocation,
    body: string,
    size: number,
    modifiedAt: Date,
  ): ContentDocumentSummary {
    const logicalDocumentPath = this.buildLogicalDocumentPath(
      location.topicName,
      path.posix.basename(relativeDocumentPath),
      location.subtopicName,
    );
    const parsedContent = this.parseDocumentContent(body, logicalDocumentPath);
    const summary: ContentDocumentSummary = {
      ...this.buildMetadataOnlyDocumentSummary(relativeDocumentPath, location, size, modifiedAt),
      tags: parsedContent.tags,
    };

    if (parsedContent.parseError) {
      summary.parseError = parsedContent.parseError;
    }

    return summary;
  }

  private buildSearchResult(
    document: ContentDocument,
    query: ParsedSearchQuery,
  ): ContentSearchResult | null {
    const normalizedQuery = query.normalizedQuery;
    const normalizedName = document.name.toLowerCase();
    const normalizedPath = document.path.toLowerCase();
    const parsedContent = this.parseDocumentContent(document.body, document.path);
    const normalizedBody = parsedContent.visibleBody.toLowerCase();
    const matchingTags =
      query.normalizedTagQuery.length > 0
        ? document.tags.filter((tag) => tag.includes(query.normalizedTagQuery))
        : [];

    if (query.tagOnly) {
      if (matchingTags.length === 0) {
        return null;
      }

      return {
        kind: "document",
        document,
        matchedField: "tag",
        excerpt: matchingTags.join(", "),
      };
    }

    if (normalizedName.includes(normalizedQuery)) {
      return {
        kind: "document",
        document,
        matchedField: "name",
        excerpt: document.name,
      };
    }

    if (normalizedPath.includes(normalizedQuery)) {
      return {
        kind: "document",
        document,
        matchedField: "path",
        excerpt: document.path,
      };
    }

    if (matchingTags.length > 0) {
      return {
        kind: "document",
        document,
        matchedField: "tag",
        excerpt: matchingTags.join(", "),
      };
    }

    const bodyIndex = normalizedBody.indexOf(normalizedQuery);
    if (bodyIndex >= 0) {
      return {
        kind: "document",
        document,
        matchedField: "body",
        excerpt: this.buildBodyExcerpt(parsedContent.visibleBody, bodyIndex, query.rawQuery.length),
      };
    }

    return null;
  }

  private buildBodyExcerpt(body: string, startIndex: number, queryLength: number): string {
    const excerptPadding = 40;
    const excerptStart = Math.max(0, startIndex - excerptPadding);
    const excerptEnd = Math.min(body.length, startIndex + queryLength + excerptPadding);
    const excerpt = body
      .slice(excerptStart, excerptEnd)
      .replaceAll(/\s+/g, " ")
      .trim();

    const prefix = excerptStart > 0 ? "..." : "";
    const suffix = excerptEnd < body.length ? "..." : "";

    return `${prefix}${excerpt}${suffix}`;
  }

  private parseSearchQuery(query: string): ParsedSearchQuery {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      throw new ContentEngineError("invalid_input", "A search query is required.");
    }

    const tagQueryMatch = /^tag:\s*(.+)$/i.exec(trimmedQuery);
    if (tagQueryMatch?.[1]) {
      const normalizedTagQuery = this.normalizeTagSearchValue(tagQueryMatch[1]);
      if (!normalizedTagQuery) {
        throw new ContentEngineError("invalid_input", "A tag search query is required after 'tag:'.");
      }

      return {
        rawQuery: trimmedQuery,
        normalizedQuery: normalizedTagQuery,
        tagOnly: true,
        normalizedTagQuery,
      };
    }

    return {
      rawQuery: trimmedQuery,
      normalizedQuery: trimmedQuery.toLowerCase(),
      tagOnly: false,
      normalizedTagQuery: this.normalizeTagSearchValue(trimmedQuery),
    };
  }

  private parseDocumentContent(body: string, documentPath: string): ParsedDocumentContent {
    const frontMatterMatch = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
    if (!frontMatterMatch) {
      if (/^(?:\uFEFF)?---[ \t]*\r?\n/.test(body)) {
        return {
          rawBody: body,
          visibleBody: body,
          tags: [],
          parseError: `Document '${documentPath}' starts with front matter but is missing a closing delimiter.`,
        };
      }

      return {
        rawBody: body,
        visibleBody: body,
        tags: [],
        parseError: null,
      };
    }

    const [, frontMatterBody = ""] = frontMatterMatch;
    const visibleBody = body.slice(frontMatterMatch[0].length);
    let parsedFrontMatter: unknown = null;
    let parseError: string | null = null;

    try {
      parsedFrontMatter = frontMatterBody.trim() ? parseYaml(frontMatterBody) : null;
    } catch (error) {
      parseError = `Document '${documentPath}' has invalid front matter: ${error instanceof Error ? error.message : "Unknown error"}`;
    }

    const parsedTags = parseError
      ? { tags: [] as ContentTag[], parseError }
      : this.extractDocumentTags(parsedFrontMatter, documentPath);

    return {
      rawBody: body,
      visibleBody,
      tags: parsedTags.tags,
      parseError: parsedTags.parseError,
    };
  }

  private extractDocumentTags(
    frontMatter: unknown,
    documentPath: string,
  ): { tags: ContentTag[]; parseError: string | null } {
    if (!frontMatter || typeof frontMatter !== "object" || Array.isArray(frontMatter)) {
      return {
        tags: [],
        parseError: null,
      };
    }

    const candidate = (frontMatter as Record<string, unknown>).tags;
    if (candidate === undefined) {
      return {
        tags: [],
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
        parseError: `Document '${documentPath}' must declare tags as a string or string array in front matter.`,
      };
    }

    return this.normalizeDocumentTags(rawTags, documentPath);
  }

  private normalizeDocumentTags(
    tags: string[],
    documentPath: string,
  ): { tags: ContentTag[]; parseError: string | null } {
    const normalizedTags: ContentTag[] = [];
    const seenTags = new Set<string>();

    for (const tag of tags) {
      const normalizedTag = this.normalizeTagSearchValue(tag);
      if (!normalizedTag) {
        return {
          tags: [],
          parseError: `Document '${documentPath}' contains an empty or invalid tag.`,
        };
      }

      if (!seenTags.has(normalizedTag)) {
        seenTags.add(normalizedTag);
        normalizedTags.push(normalizedTag);
      }
    }

    return {
      tags: normalizedTags,
      parseError: null,
    };
  }

  private normalizeTagSearchValue(value: string): string {
    return value
      .toLowerCase()
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  private async prepareDirectImportDocuments(
    input: DirectImportDocumentsRequest,
    folderMappingMode: ImportFolderMappingMode,
  ): Promise<PreparedImportDocument[]> {
    const normalizedTopicName = this.normalizeSegmentName(input.topicName, "topic");
    const normalizedSubtopicName = input.subtopicName
      ? this.normalizeSubtopicName(input.subtopicName)
      : undefined;

    await this.assertImportBaseLocation(normalizedTopicName, normalizedSubtopicName);

    return input.documents.map((document) => {
      const normalizedFileName = this.normalizeDocumentName(document.name);
      const folderSegments = this.normalizeImportSourcePath(document.sourcePath, normalizedFileName);
      const targetLocation = this.resolveImportTargetLocation(
        normalizedTopicName,
        normalizedSubtopicName,
        folderMappingMode,
        folderSegments,
      );

      return {
        body: document.body,
        storageRelativePath: this.buildDocumentStoragePath(
          targetLocation.topicName,
          normalizedFileName,
          targetLocation.subtopicName,
        ),
        logicalPath: this.buildLogicalDocumentPath(
          targetLocation.topicName,
          normalizedFileName,
          targetLocation.subtopicName,
        ),
      };
    });
  }

  private prepareBundleImportDocuments(bundle: ContentExportBundle): PreparedImportDocument[] {
    if (bundle.documents.length === 0) {
      throw new ContentEngineError("invalid_input", "The transfer bundle does not contain any documents.");
    }

    return bundle.documents.map((document) =>
      this.buildPreparedImportDocumentFromLogicalPath(document.path, document.body),
    );
  }

  private buildPreparedImportDocumentFromLogicalPath(
    logicalPath: string,
    body: string,
  ): PreparedImportDocument {
    const normalizedReference = this.normalizeDocumentReference(logicalPath);

    return {
      body,
      logicalPath: normalizedReference.logicalRelativePath,
      storageRelativePath: normalizedReference.preferredStorageRelativePath,
    };
  }

  private async applyPreparedImportDocuments(
    preparedDocuments: PreparedImportDocument[],
    options: {
      conflictMode: ImportConflictMode;
      format: ImportFormat;
      folderMappingMode?: ImportFolderMappingMode;
    },
  ): Promise<ImportDocumentsResponse> {
    const seenPaths = new Set<string>();
    for (const document of preparedDocuments) {
      if (seenPaths.has(document.logicalPath)) {
        throw new ContentEngineError(
          "conflict",
          `Document '${document.logicalPath}' appears more than once in the import payload.`,
        );
      }

      seenPaths.add(document.logicalPath);
    }

    const skipped: ContentDocumentSummary[] = [];
    const imported: ContentDocument[] = [];

    if (options.conflictMode === "fail") {
      await Promise.all(
        preparedDocuments.map(async (document) =>
          this.assertFileDoesNotExist(
            this.resolveInsideDataRoot(document.storageRelativePath),
            document.storageRelativePath,
          ),
        ),
      );

      for (const document of preparedDocuments) {
        const absoluteDocumentPath = this.resolveInsideDataRoot(document.storageRelativePath);
        await this.ensureParentDirectory(absoluteDocumentPath);
        await this.writeNewFile(absoluteDocumentPath, document.body, document.storageRelativePath);
        imported.push(await this.getDocument(document.logicalPath));
      }
    } else {
      for (const document of preparedDocuments) {
        const absoluteDocumentPath = this.resolveInsideDataRoot(document.storageRelativePath);
        const destinationState = await this.inspectImportDestination(
          absoluteDocumentPath,
          document.storageRelativePath,
        );

        if (destinationState === "file") {
          if (options.conflictMode === "skip") {
            // Preserve the existing skipped summary when possible, but don't let malformed
            // front matter in unchanged content abort a skipped import.
            skipped.push(await this.readSkippedImportSummary(document.logicalPath));
            continue;
          }

          await this.ensureParentDirectory(absoluteDocumentPath);
          await fs.writeFile(absoluteDocumentPath, document.body, { encoding: "utf8" });
        } else {
          await this.ensureParentDirectory(absoluteDocumentPath);
          await this.writeNewFile(absoluteDocumentPath, document.body, document.storageRelativePath);
        }

        imported.push(await this.getDocument(document.logicalPath));
      }
    }

    return {
      format: options.format,
      conflictMode: options.conflictMode,
      ...(options.folderMappingMode ? { folderMappingMode: options.folderMappingMode } : {}),
      imported,
      importedCount: imported.length,
      skipped,
      skippedCount: skipped.length,
    };
  }

  private async buildArchiveFromBundle(bundle: ContentExportBundle): Promise<Buffer> {
    const zip = new JSZip();
    const manifest: ExportArchiveManifest = {
      version: 1,
      generatedAt: bundle.generatedAt,
      exportName: bundle.exportName,
      scope: bundle.scope,
      documents: bundle.documents.map((document) => ({
        path: document.path,
      })),
    };

    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    for (const document of bundle.documents) {
      zip.file(path.posix.join("documents", document.path), document.body);
    }

    return zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
  }

  private async readArchiveBundle(archiveBase64: string): Promise<ContentExportBundle> {
    if (!archiveBase64.trim()) {
      throw new ContentEngineError("invalid_input", "A zip archive payload is required for bundle import.");
    }

    try {
      const zip = await JSZip.loadAsync(Buffer.from(archiveBase64, "base64"));
      const manifestEntry = zip.file("manifest.json");
      if (!manifestEntry) {
        throw new ContentEngineError("invalid_input", "The zip archive is missing manifest.json.");
      }

      const manifest = JSON.parse(await manifestEntry.async("string")) as Partial<ExportArchiveManifest>;
      if (
        manifest.version !== 1 ||
        typeof manifest.generatedAt !== "string" ||
        typeof manifest.exportName !== "string" ||
        !manifest.scope ||
        !Array.isArray(manifest.documents)
      ) {
        throw new ContentEngineError("invalid_input", "The zip archive manifest is not valid.");
      }

      const documents = await Promise.all(
        manifest.documents.map(async (document) => {
          if (!document || typeof document.path !== "string") {
            throw new ContentEngineError("invalid_input", "The zip archive manifest contains an invalid document entry.");
          }

          const entry = zip.file(path.posix.join("documents", document.path));
          if (!entry) {
            throw new ContentEngineError(
              "invalid_input",
              `The zip archive is missing content for '${document.path}'.`,
            );
          }

          const body = await entry.async("string");
          return this.getDocumentFromBundleEntry(document.path, body);
        }),
      );

      return {
        generatedAt: manifest.generatedAt,
        exportName: manifest.exportName,
        scope: this.normalizeExportScope(manifest.scope),
        documents,
      };
    } catch (error) {
      if (isContentEngineError(error)) {
        throw error;
      }

      throw new ContentEngineError("invalid_input", "Failed to read the supplied zip archive.");
    }
  }

  private getDocumentFromBundleEntry(logicalPath: string, body: string): ContentDocument {
    const normalizedReference = this.normalizeDocumentReference(logicalPath);
    const summary = this.buildDocumentSummary(
      normalizedReference.preferredStorageRelativePath,
      normalizedReference.location,
      body,
      Buffer.byteLength(body, "utf8"),
      new Date(),
    );

    return {
      ...summary,
      body,
    };
  }

  private normalizeExportScope(scope: ExportScope): ExportScope {
    switch (scope.scope) {
      case "document":
        return {
          scope: "document",
          path: this.normalizeDocumentReference(scope.path).logicalRelativePath,
        };
      case "topic":
        return {
          scope: "topic",
          topicName: this.normalizeSegmentName(scope.topicName, "topic"),
        };
      case "subtopic":
        return {
          scope: "subtopic",
          topicName: this.normalizeSegmentName(scope.topicName, "topic"),
          subtopicName: this.normalizeSubtopicName(scope.subtopicName),
        };
      default:
        return scope;
    }
  }

  private async readDocumentsForExportScope(scope: ExportScope): Promise<ContentDocument[]> {
    switch (scope.scope) {
      case "document":
        return [await this.getDocument(scope.path)];
      case "topic": {
        const tree = await this.getTree();
        const topic = tree.topics.find((candidate) => candidate.name === scope.topicName);
        if (!topic) {
          throw new ContentEngineError("not_found", `Topic '${scope.topicName}' was not found.`);
        }

        const documentPaths = [
          ...topic.documents.map((document) => document.path),
          ...topic.subtopics.flatMap((subtopic) => subtopic.documents.map((document) => document.path)),
        ];

        return Promise.all(documentPaths.map((documentPath) => this.getDocument(documentPath)));
      }
      case "subtopic": {
        const tree = await this.getTree();
        const topic = tree.topics.find((candidate) => candidate.name === scope.topicName);
        const subtopic = topic?.subtopics.find((candidate) => candidate.name === scope.subtopicName);
        if (!subtopic) {
          throw new ContentEngineError(
            "not_found",
            `Subtopic '${scope.subtopicName}' under topic '${scope.topicName}' was not found.`,
          );
        }

        return Promise.all(
          subtopic.documents.map((document) => this.getDocument(document.path)),
        );
      }
      default:
        return [];
    }
  }

  private buildExportName(scope: ExportScope): string {
    switch (scope.scope) {
      case "document":
        return this.sanitizeExportName(scope.path.replaceAll("/", "-"));
      case "topic":
        return this.sanitizeExportName(`${scope.topicName}-bundle`);
      case "subtopic":
        return this.sanitizeExportName(`${scope.topicName}-${scope.subtopicName}-bundle`);
      default:
        return "content-bundle";
    }
  }

  private sanitizeExportName(value: string): string {
    return value.replaceAll(/[^\w.-]+/g, "-");
  }

  private logicalLocationFromStoragePath(relativeDocumentPath: string): ContentLocation {
    const segments = relativeDocumentPath.split("/").filter(Boolean);
    if (segments.length < 2 || segments.length > 3) {
      throw new ContentEngineError(
        "invalid_input",
        `Document path '${relativeDocumentPath}' does not match the supported topic/subtopic structure.`,
      );
    }

    const topicName = segments[0];
    const secondSegment = segments[1];
    if (!topicName) {
      throw new ContentEngineError("invalid_input", "Document paths must include a topic name.");
    }

    if (segments.length === 2 || secondSegment === CATCH_ALL_SUBTOPIC_NAME) {
      return { topicName };
    }

    if (!secondSegment) {
      throw new ContentEngineError("invalid_input", "Document paths must include a valid subtopic name.");
    }

    return {
      topicName,
      subtopicName: secondSegment,
    };
  }

  private buildDocumentStoragePath(topicName: string, fileName: string, subtopicName?: string): string {
    const normalizedTopicName = this.normalizeSegmentName(topicName, "topic");
    const normalizedFileName = this.normalizeDocumentName(fileName);
    const normalizedSubtopicName = subtopicName
      ? this.normalizeSubtopicName(subtopicName)
      : CATCH_ALL_SUBTOPIC_NAME;

    return path.posix.join(normalizedTopicName, normalizedSubtopicName, normalizedFileName);
  }

  private buildLogicalDocumentPath(topicName: string, fileName: string, subtopicName?: string): string {
    const normalizedTopicName = this.normalizeSegmentName(topicName, "topic");
    const normalizedFileName = this.normalizeDocumentName(fileName);

    if (!subtopicName) {
      return path.posix.join(normalizedTopicName, normalizedFileName);
    }

    return path.posix.join(
      normalizedTopicName,
      this.normalizeSubtopicName(subtopicName),
      normalizedFileName,
    );
  }

  private normalizeDocumentReference(relativeDocumentPath: string): {
    logicalRelativePath: string;
    preferredStorageRelativePath: string;
    legacyStorageRelativePath?: string;
    location: ContentLocation;
  } {
    if (!relativeDocumentPath) {
      throw new ContentEngineError("invalid_input", "A document path is required.");
    }

    const normalizedPath = relativeDocumentPath.replaceAll("\\", "/").replace(/^\/+/, "");
    const segments = normalizedPath.split("/").filter(Boolean);
    if (segments.length < 2 || segments.length > 3) {
      throw new ContentEngineError(
        "invalid_input",
        "Document paths must be '<topic>/<file>.md' or '<topic>/<subtopic>/<file>.md'.",
      );
    }

    const topicName = this.normalizeSegmentName(segments[0] ?? "", "topic");
    const secondSegment = segments.length === 3 ? segments[1] : undefined;
    const fileName = segments.at(-1);
    if (!fileName || !this.isMarkdownFile(fileName)) {
      throw new ContentEngineError("invalid_input", "Document paths must end in '.md'.");
    }
    const normalizedFileName = this.normalizeDocumentName(fileName);

    if (segments.length === 2 || secondSegment === CATCH_ALL_SUBTOPIC_NAME) {
      return {
        logicalRelativePath: this.buildLogicalDocumentPath(topicName, normalizedFileName),
        preferredStorageRelativePath: this.buildDocumentStoragePath(topicName, normalizedFileName),
        legacyStorageRelativePath: path.posix.join(topicName, normalizedFileName),
        location: { topicName },
      };
    }

    const normalizedSubtopicName = this.normalizeSubtopicName(secondSegment ?? "");

    return {
      logicalRelativePath: this.buildLogicalDocumentPath(
        topicName,
        normalizedFileName,
        normalizedSubtopicName,
      ),
      preferredStorageRelativePath: this.buildDocumentStoragePath(
        topicName,
        normalizedFileName,
        normalizedSubtopicName,
      ),
      location: {
        topicName,
        subtopicName: normalizedSubtopicName,
      },
    };
  }

  private async resolveExistingDocument(relativeDocumentPath: string): Promise<{
    logicalRelativePath: string;
    storageRelativePath: string;
    absoluteDocumentPath: string;
    location: ContentLocation;
  }> {
    const normalizedReference = this.normalizeDocumentReference(relativeDocumentPath);
    const candidateStoragePaths = [
      normalizedReference.preferredStorageRelativePath,
      normalizedReference.legacyStorageRelativePath,
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of candidateStoragePaths) {
      const absoluteDocumentPath = this.resolveInsideDataRoot(candidate);

      try {
        const stats = await fs.stat(absoluteDocumentPath);
        if (!stats.isFile()) {
          continue;
        }

        return {
          logicalRelativePath: normalizedReference.logicalRelativePath,
          storageRelativePath: candidate,
          absoluteDocumentPath,
          location: normalizedReference.location,
        };
      } catch (error) {
        if (this.isNodeError(error, "ENOENT")) {
          continue;
        }

        throw error;
      }
    }

    throw new ContentEngineError(
      "not_found",
      `Document '${normalizedReference.logicalRelativePath}' was not found.`,
    );
  }

  private normalizeSegmentName(name: string, kind: "topic" | "subtopic"): string {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new ContentEngineError("invalid_input", `A ${kind} name is required.`);
    }

    if (trimmedName === "." || trimmedName === ".." || /[\\/]/.test(trimmedName)) {
      throw new ContentEngineError(
        "invalid_input",
        `${kind} names cannot contain path separators or relative path markers.`,
      );
    }

    return trimmedName;
  }

  private normalizeSubtopicName(name: string): string {
    const normalizedName = this.normalizeSegmentName(name, "subtopic");
    if (normalizedName === CATCH_ALL_SUBTOPIC_NAME) {
      throw new ContentEngineError(
        "invalid_input",
        `'${CATCH_ALL_SUBTOPIC_NAME}' is reserved for internal content normalization.`,
      );
    }

    return normalizedName;
  }

  private normalizeDocumentName(name: string): string {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new ContentEngineError("invalid_input", "A document name is required.");
    }

    if (trimmedName === "." || trimmedName === ".." || /[\\/]/.test(trimmedName)) {
      throw new ContentEngineError(
        "invalid_input",
        "Document names cannot contain path separators or relative path markers.",
      );
    }

    return trimmedName.toLowerCase().endsWith(".md") ? trimmedName : `${trimmedName}.md`;
  }

  private resolveInsideDataRoot(...segments: string[]): string {
    const resolvedPath = path.resolve(this.dataRoot, ...segments);
    if (resolvedPath !== this.dataRoot && !resolvedPath.startsWith(`${this.dataRoot}${path.sep}`)) {
      throw new ContentEngineError("invalid_input", "The requested path escapes the data directory.");
    }

    return resolvedPath;
  }

  private async ensureTargetDocumentDirectory(topicName: string, subtopicName?: string): Promise<void> {
    const normalizedTopicName = this.normalizeSegmentName(topicName, "topic");
    const topicPath = this.resolveInsideDataRoot(normalizedTopicName);

    await this.assertExistingDirectory(topicPath, normalizedTopicName);

    const directorySegments = [normalizedTopicName];
    if (subtopicName) {
      const normalizedSubtopicName = this.normalizeSubtopicName(subtopicName);
      const subtopicPath = this.resolveInsideDataRoot(normalizedTopicName, normalizedSubtopicName);
      await this.assertExistingDirectory(
        subtopicPath,
        path.posix.join(normalizedTopicName, normalizedSubtopicName),
      );
      directorySegments.push(normalizedSubtopicName);
    } else {
      directorySegments.push(CATCH_ALL_SUBTOPIC_NAME);
      await fs.mkdir(this.resolveInsideDataRoot(...directorySegments), { recursive: true });
    }
  }

  private async assertImportBaseLocation(topicName: string, subtopicName?: string): Promise<void> {
    const normalizedTopicName = this.normalizeSegmentName(topicName, "topic");
    const topicPath = this.resolveInsideDataRoot(normalizedTopicName);
    await this.assertExistingDirectory(topicPath, normalizedTopicName);

    if (!subtopicName) {
      return;
    }

    const normalizedSubtopicName = this.normalizeSubtopicName(subtopicName);
    const subtopicPath = this.resolveInsideDataRoot(normalizedTopicName, normalizedSubtopicName);
    await this.assertExistingDirectory(
      subtopicPath,
      path.posix.join(normalizedTopicName, normalizedSubtopicName),
    );
  }

  private async createDirectory(absoluteDirectoryPath: string, displayPath: string): Promise<void> {
    try {
      await fs.mkdir(absoluteDirectoryPath);
      await this.ensureGitkeepFile(absoluteDirectoryPath);
    } catch (error) {
      if (this.isNodeError(error, "EEXIST")) {
        throw new ContentEngineError("conflict", `Path '${displayPath}' already exists.`);
      }

      throw error;
    }
  }

  private async ensureGitkeepFile(absoluteDirectoryPath: string): Promise<void> {
    try {
      await fs.writeFile(path.join(absoluteDirectoryPath, GITKEEP_FILE_NAME), "", {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (this.isNodeError(error, "EEXIST")) {
        return;
      }

      throw error;
    }
  }

  private async ensureGitkeepForLocation(location: ContentLocation): Promise<void> {
    const absoluteDirectoryPath = location.subtopicName
      ? this.resolveInsideDataRoot(location.topicName, location.subtopicName)
      : this.resolveInsideDataRoot(location.topicName);
    await this.ensureGitkeepFile(absoluteDirectoryPath);
  }

  private async writeNewFile(
    absoluteFilePath: string,
    body: string,
    displayPath: string,
  ): Promise<void> {
    try {
      await fs.writeFile(absoluteFilePath, body, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (this.isNodeError(error, "EEXIST")) {
        throw new ContentEngineError("conflict", `Document '${displayPath}' already exists.`);
      }

      throw error;
    }
  }

  private async ensureParentDirectory(absoluteFilePath: string): Promise<void> {
    await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
  }

  private async assertExistingDirectory(absoluteDirectoryPath: string, displayPath: string): Promise<void> {
    try {
      const stats = await fs.stat(absoluteDirectoryPath);
      if (!stats.isDirectory()) {
        throw new ContentEngineError("not_found", `Directory '${displayPath}' was not found.`);
      }
    } catch (error) {
      if (this.isNodeError(error, "ENOENT")) {
        throw new ContentEngineError("not_found", `Directory '${displayPath}' was not found.`);
      }

      throw error;
    }
  }

  private async assertExistingFile(absoluteFilePath: string, displayPath: string): Promise<void> {
    try {
      const stats = await fs.stat(absoluteFilePath);
      if (!stats.isFile()) {
        throw new ContentEngineError("not_found", `Document '${displayPath}' was not found.`);
      }
    } catch (error) {
      if (this.isNodeError(error, "ENOENT")) {
        throw new ContentEngineError("not_found", `Document '${displayPath}' was not found.`);
      }

      throw error;
    }
  }

  private async assertFileDoesNotExist(absoluteFilePath: string, displayPath: string): Promise<void> {
    try {
      await fs.access(absoluteFilePath);
      throw new ContentEngineError("conflict", `Document '${displayPath}' already exists.`);
    } catch (error) {
      if (this.isNodeError(error, "ENOENT")) {
        return;
      }

      throw error;
    }
  }

  private async assertDirectoryDoesNotExist(
    absoluteDirectoryPath: string,
    displayPath: string,
  ): Promise<void> {
    try {
      await fs.access(absoluteDirectoryPath);
      throw new ContentEngineError("conflict", `Directory '${displayPath}' already exists.`);
    } catch (error) {
      if (this.isNodeError(error, "ENOENT")) {
        return;
      }

      throw error;
    }
  }

  private normalizeImportConflictMode(mode: string | undefined): ImportConflictMode {
    if (!mode) {
      return "fail";
    }

    if ((importConflictModes as readonly string[]).includes(mode)) {
      return mode as ImportConflictMode;
    }

    throw new ContentEngineError(
      "invalid_input",
      `Import conflict mode must be one of: ${importConflictModes.join(", ")}.`,
    );
  }

  private normalizeImportFormat(format: ImportDocumentsRequest["format"]): ImportFormat {
    if (!format) {
      return "documents";
    }

    if ((importFormats as readonly string[]).includes(format)) {
      return format;
    }

    throw new ContentEngineError(
      "invalid_input",
      `Import format must be one of: ${importFormats.join(", ")}.`,
    );
  }

  private normalizeExportFormat(format: ExportDocumentsRequest["format"]): ExportFormat {
    if (!format) {
      return "bundle-json";
    }

    if ((exportFormats as readonly string[]).includes(format)) {
      return format;
    }

    throw new ContentEngineError(
      "invalid_input",
      `Export format must be one of: ${exportFormats.join(", ")}.`,
    );
  }

  private normalizeImportFolderMappingMode(mode: string | undefined): ImportFolderMappingMode {
    if (!mode) {
      return "flat";
    }

    if ((importFolderMappingModes as readonly string[]).includes(mode)) {
      return mode as ImportFolderMappingMode;
    }

    throw new ContentEngineError(
      "invalid_input",
      `Import folder mapping mode must be one of: ${importFolderMappingModes.join(", ")}.`,
    );
  }

  private normalizeImportSourcePath(sourcePath: string | undefined, normalizedFileName: string): string[] {
    if (!sourcePath) {
      return [];
    }

    const normalizedSourcePath = sourcePath.replaceAll("\\", "/").replace(/^\/+/, "");
    if (!normalizedSourcePath) {
      throw new ContentEngineError("invalid_input", "Import source paths cannot be empty.");
    }

    const segments = normalizedSourcePath.split("/").filter(Boolean);
    if (segments.length === 0) {
      throw new ContentEngineError("invalid_input", "Import source paths cannot be empty.");
    }

    const sourceFileName = segments.at(-1);
    if (!sourceFileName) {
      throw new ContentEngineError("invalid_input", "Import source paths must include a Markdown file name.");
    }

    const normalizedSourceFileName = this.normalizeDocumentName(sourceFileName);
    if (normalizedSourceFileName !== normalizedFileName) {
      throw new ContentEngineError(
        "invalid_input",
        `Import source path '${sourcePath}' must end with '${normalizedFileName}'.`,
      );
    }

    return segments
      .slice(0, -1)
      .map((segment) => this.normalizeSegmentName(segment, "subtopic"));
  }

  private resolveImportTargetLocation(
    topicName: string,
    baseSubtopicName: string | undefined,
    folderMappingMode: ImportFolderMappingMode,
    folderSegments: string[],
  ): ContentLocation {
    if (folderMappingMode !== "folders-to-subtopic" || folderSegments.length === 0) {
      return baseSubtopicName
        ? {
            topicName,
            subtopicName: baseSubtopicName,
          }
        : { topicName };
    }

    const flattenedSubtopicName = [baseSubtopicName, ...folderSegments]
      .filter((segment): segment is string => Boolean(segment))
      .join(" - ");

    return {
      topicName,
      subtopicName: this.normalizeSubtopicName(flattenedSubtopicName),
    };
  }

  private async inspectImportDestination(
    absoluteFilePath: string,
    displayPath: string,
  ): Promise<"missing" | "file"> {
    try {
      const stats = await fs.stat(absoluteFilePath);
      if (!stats.isFile()) {
        throw new ContentEngineError(
          "conflict",
          `Path '${displayPath}' already exists and is not a document file.`,
        );
      }

      return "file";
    } catch (error) {
      if (this.isNodeError(error, "ENOENT")) {
        return "missing";
      }

      throw error;
    }
  }

  private isMarkdownFile(name: string): boolean {
    return name.toLowerCase().endsWith(".md");
  }

  private isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
  }

  private sortDocuments(documents: ContentDocumentSummary[]): ContentDocumentSummary[] {
    return documents.sort((left, right) => left.name.localeCompare(right.name));
  }
}
