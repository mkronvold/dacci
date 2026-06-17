import { useEffect, useId, useState } from "react";
import { readActiveThemeName, type ThemeName } from "../utils/theme";

interface MermaidBlockProps {
  chart: string;
}

let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;

function getMermaidThemeVariables(themeName: ThemeName) {
  switch (themeName) {
    case "slate":
      return {
        background: "#1e2129",
        clusterBkg: "#1e2129",
        clusterBorder: "#526cfe",
        edgeLabelBackground: "#1e2129",
        lineColor: "#8b9afc",
        mainBkg: "#2b303b",
        noteBkgColor: "#2b303b",
        noteTextColor: "#e9edf7",
        primaryBorderColor: "#7c8dfb",
        primaryColor: "#2b303b",
        primaryTextColor: "#e9edf7",
        secondaryColor: "#252933",
        tertiaryColor: "#252933",
        textColor: "#e9edf7",
      };
    default:
      return {
        background: "#ffffff",
        clusterBkg: "#ffffff",
        clusterBorder: "#4051b5",
        edgeLabelBackground: "#ffffff",
        lineColor: "#5d6cc0",
        mainBkg: "#f5f7fb",
        noteBkgColor: "#f5f7fb",
        noteTextColor: "#1f232d",
        primaryBorderColor: "#526cfe",
        primaryColor: "#f5f7fb",
        primaryTextColor: "#1f232d",
        secondaryColor: "#eceff5",
        tertiaryColor: "#eceff5",
        textColor: "#1f232d",
      };
  }
}

async function getMermaid(themeName: ThemeName) {
  mermaidModulePromise ??= import("mermaid");
  const module = await mermaidModulePromise;
  const mermaid = module.default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: {
      darkMode: themeName === "slate",
      fontFamily: "Roboto, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      ...getMermaidThemeVariables(themeName),
    },
  });

  return mermaid;
}

export function MermaidBlock(props: MermaidBlockProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const renderId = useId().replace(/:/g, "-");
  const themeName = readActiveThemeName();

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
        const mermaid = await getMermaid(themeName);
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
  }, [props.chart, renderId, themeName]);

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
