import type { RefObject } from "react";

interface DocumentEditorProps {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

export function DocumentEditor(props: DocumentEditorProps) {
  return (
    <label className="editor-field">
      <span>Markdown body</span>
      <textarea
        className="document-editor"
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
        rows={18}
        ref={props.textareaRef}
        value={props.value}
      />
    </label>
  );
}
