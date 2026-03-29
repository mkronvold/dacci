import { useMemo } from "react";

import type { ContentSearchResponse, ContentTopicNode } from "@dacci/shared-types";

interface NavigationPaneProps {
  topics: ContentTopicNode[];
  selectedDocumentPath: string | null;
  showDocuments: boolean;
  collapsedTreePaths: Set<string>;
  searchQuery: string;
  searchResponse: ContentSearchResponse | null;
  searchExpandedPaths: Set<string>;
  hasActiveFilter: boolean;
  matchedDocumentPaths: Set<string>;
  onSearchQueryChange: (value: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onToggleTreeNode: (nodePath: string) => void;
  onToggleDocuments: () => void;
  onSelectDocument: (documentPath: string) => void;
}

interface TreeSectionProps {
  topic: ContentTopicNode;
  selectedDocumentPath: string | null;
  showDocuments: boolean;
  collapsedTreePaths: Set<string>;
  forcedExpandedPaths: Set<string>;
  hasActiveFilter: boolean;
  matchedDocumentPaths: Set<string>;
  onToggleTreeNode: (nodePath: string) => void;
  onSelectDocument: (documentPath: string) => void;
}

function TreeSection(props: TreeSectionProps) {
  const topicDocuments = props.hasActiveFilter
    ? props.topic.documents.filter((document) => props.matchedDocumentPaths.has(document.path))
    : props.topic.documents;
  const visibleSubtopics = props.hasActiveFilter
    ? props.topic.subtopics
        .map((subtopic) => ({
          ...subtopic,
          documents: subtopic.documents.filter((document) => props.matchedDocumentPaths.has(document.path)),
        }))
        .filter((subtopic) => subtopic.documents.length > 0)
    : props.topic.subtopics;

  if (props.hasActiveFilter && topicDocuments.length === 0 && visibleSubtopics.length === 0) {
    return null;
  }

  const topicExpanded = props.forcedExpandedPaths.has(props.topic.path) || !props.collapsedTreePaths.has(props.topic.path);

  return (
    <section className="tree-section">
      <button
        aria-expanded={topicExpanded}
        className="tree-toggle-row"
        onClick={() => props.onToggleTreeNode(props.topic.path)}
        type="button"
      >
        <span aria-hidden="true" className="tree-toggle-affordance">
          {topicExpanded ? "−" : "+"}
        </span>
        <div className="tree-heading-copy">
          <h3>{props.topic.name}</h3>
          <p className="tree-meta">
            {props.topic.documents.length} topic docs, {props.topic.subtopics.length} subtopics
          </p>
        </div>
      </button>

      {props.showDocuments && topicExpanded && topicDocuments.length > 0 ? (
        <div className="document-group">
          {topicDocuments.map((document) => (
            <button
              key={document.path}
              className={document.path === props.selectedDocumentPath ? "document-link active" : "document-link"}
              onClick={() => props.onSelectDocument(document.path)}
              type="button"
            >
              <span>{document.name}</span>
            </button>
          ))}
        </div>
      ) : null}

      {topicExpanded
        ? visibleSubtopics.map((subtopic) => {
            const subtopicExpanded =
              props.forcedExpandedPaths.has(subtopic.path) || !props.collapsedTreePaths.has(subtopic.path);

            return (
              <div className="subtopic-block" key={subtopic.path}>
                <button
                  aria-expanded={subtopicExpanded}
                  className="tree-toggle-row subtopic-toggle-row"
                  onClick={() => props.onToggleTreeNode(subtopic.path)}
                  type="button"
                >
                  <span aria-hidden="true" className="tree-toggle-affordance">
                    {subtopicExpanded ? "−" : "+"}
                  </span>
                  <div className="tree-heading-copy">
                    <h4>{subtopic.name}</h4>
                    <p className="tree-meta">{subtopic.documents.length} documents</p>
                  </div>
                </button>

                {props.showDocuments && subtopicExpanded ? (
                  <div className="document-group">
                    {subtopic.documents.map((document) => (
                      <button
                        key={document.path}
                        className={document.path === props.selectedDocumentPath ? "document-link active" : "document-link"}
                        onClick={() => props.onSelectDocument(document.path)}
                        type="button"
                      >
                        <span>{document.name}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })
        : null}
    </section>
  );
}

export function NavigationPane(props: NavigationPaneProps) {
  const resultSummary = useMemo(() => {
    if (!props.hasActiveFilter) {
      return null;
    }

    if (!props.searchResponse) {
      return "Searching...";
    }

    return `Showing ${props.searchResponse.results.length} matching documents.`;
  }, [props.hasActiveFilter, props.searchResponse]);

  return (
      <aside className="panel navigation-pane">
        <div className="panel-header">
          <p className="eyebrow viewer-eyebrow">Navigation</p>
        </div>

      <div className="form-grid tree-toolbar">
        <label>
          <span>Search</span>
          <input
            onChange={(event) => props.onSearchQueryChange(event.target.value)}
            placeholder="Search path, body, or tag:release"
            value={props.searchQuery}
          />
        </label>

        <div className="inline-actions">
          <button className="ghost-button" onClick={props.onExpandAll} type="button">
            Expand all
          </button>
          <button className="ghost-button" onClick={props.onCollapseAll} type="button">
            Collapse all
          </button>
          <button
            aria-pressed={!props.showDocuments}
            className="ghost-button"
            onClick={props.onToggleDocuments}
            type="button"
          >
            {props.showDocuments ? "Hide documents" : "Show documents"}
          </button>
        </div>

        {resultSummary ? <p className="muted">{resultSummary}</p> : null}
      </div>

      {props.hasActiveFilter && props.searchResponse && props.searchResponse.results.length > 0 ? (
        <div className="search-results">
          {props.searchResponse.results.map((result) => (
            <button
              key={result.document.path}
              className={
                result.document.path === props.selectedDocumentPath
                  ? "search-result-card active"
                  : "search-result-card"
              }
              onClick={() => props.onSelectDocument(result.document.path)}
              type="button"
            >
              <strong>{result.document.path}</strong>
              {result.document.tags.length > 0 ? (
                <div className="search-result-tags">
                  {result.document.tags.map((tag) => (
                    <span className="document-tag-pill compact" key={`${result.document.path}-${tag}`}>
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
              <span className="muted">
                {result.matchedField}: {result.excerpt}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {props.topics.length > 0 ? (
        <div className="tree-list">
          {props.topics.map((topic) => (
            <TreeSection
              hasActiveFilter={props.hasActiveFilter}
              key={topic.path}
              matchedDocumentPaths={props.matchedDocumentPaths}
              collapsedTreePaths={props.collapsedTreePaths}
              forcedExpandedPaths={props.searchExpandedPaths}
              selectedDocumentPath={props.selectedDocumentPath}
              showDocuments={props.showDocuments}
              topic={topic}
              onSelectDocument={props.onSelectDocument}
              onToggleTreeNode={props.onToggleTreeNode}
            />
          ))}
        </div>
      ) : (
        <p className="muted">
          No Markdown documents were found under <code>data/</code> yet.
        </p>
      )}
    </aside>
  );
}
