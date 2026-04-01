import type { Ref } from "react";

import type { HeadingItem } from "../utils/markdownDocument";

interface DocumentOutlinePaneProps {
  headings: HeadingItem[];
  className?: string;
  panelRef?: Ref<HTMLElement>;
  onClose?: () => void;
  closeLabel?: string;
}

export function DocumentOutlinePane(props: DocumentOutlinePaneProps) {
  const className = props.className ? `reader-outline ${props.className}` : "reader-outline";

  return (
    <aside className={className} ref={props.panelRef}>
      <div className="panel-header reader-outline-header">
        <p className="reader-outline-title">Outline</p>
        {props.onClose ? (
          <button
            aria-label={props.closeLabel ?? "Close outline"}
            className="ghost-button side-pane-close"
            onClick={props.onClose}
            type="button"
          >
            ×
          </button>
        ) : null}
      </div>
      <nav aria-label="Document outline">
        <ul className="outline-list">
          {props.headings.map((heading) => (
            <li className={`outline-item outline-depth-${Math.min(heading.depth, 6)}`} key={heading.slug}>
              <a className="outline-link" href={`#${heading.slug}`}>
                <span aria-hidden="true" className="outline-link-node" />
                <span className="outline-link-text">{heading.text}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
