import { useEffect, useId, useState } from "react";

interface MermaidBlockProps {
  chart: string;
}

let mermaidInitialized = false;
let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;

async function getMermaid() {
  mermaidModulePromise ??= import("mermaid");
  const module = await mermaidModulePromise;
  const mermaid = module.default;

  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
    });
    mermaidInitialized = true;
  }

  return mermaid;
}

export function MermaidBlock(props: MermaidBlockProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const renderId = useId().replace(/:/g, "-");

  useEffect(() => {
    let cancelled = false;
    const normalizedChart = props.chart.trim();

    if (!normalizedChart) {
      setSvg(null);
      setError("Mermaid blocks cannot be empty.");
      return;
    }

    setSvg(null);
    setError(null);

    void (async () => {
      try {
        const mermaid = await getMermaid();
        const result = await mermaid.render(`mermaid-${renderId}`, normalizedChart);
        if (!cancelled) {
          setSvg(result.svg);
        }
      } catch (renderError) {
        if (!cancelled) {
          setError(renderError instanceof Error ? renderError.message : "Unknown Mermaid render error.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [props.chart, renderId]);

  if (error) {
    return (
      <div className="mermaid-block error" role="status">
        <strong>Mermaid render failed.</strong>
        <span>{error}</span>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="mermaid-block loading" role="status">
        Rendering Mermaid diagram...
      </div>
    );
  }

  return <div aria-label="Mermaid diagram" className="mermaid-block" dangerouslySetInnerHTML={{ __html: svg }} />;
}
