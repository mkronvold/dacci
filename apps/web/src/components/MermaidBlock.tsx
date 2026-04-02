import { useEffect, useId, useState } from "react";
import { readActiveThemeName, type ThemeName } from "../utils/theme";

interface MermaidBlockProps {
  chart: string;
}

let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;

function getMermaidThemeVariables(themeName: ThemeName) {
  switch (themeName) {
    case "green":
      return {
        background: "#0d1712",
        clusterBkg: "#0d1712",
        clusterBorder: "#8fcaa6",
        edgeLabelBackground: "#0d1712",
        lineColor: "#8fcaa6",
        mainBkg: "#193123",
        noteBkgColor: "#193123",
        noteTextColor: "#e5efe8",
        primaryBorderColor: "#8fcaa6",
        primaryColor: "#193123",
        primaryTextColor: "#e5efe8",
        secondaryColor: "#102117",
        tertiaryColor: "#102117",
        textColor: "#e5efe8",
      };
    case "dark":
      return {
        background: "#0b1017",
        clusterBkg: "#0b1017",
        clusterBorder: "#a8bbcf",
        edgeLabelBackground: "#0b1017",
        lineColor: "#a8bbcf",
        mainBkg: "#1f2731",
        noteBkgColor: "#1f2731",
        noteTextColor: "#e6edf5",
        primaryBorderColor: "#a8bbcf",
        primaryColor: "#1f2731",
        primaryTextColor: "#e6edf5",
        secondaryColor: "#131920",
        tertiaryColor: "#131920",
        textColor: "#e6edf5",
      };
    case "earth":
      return {
        background: "#0b0a08",
        clusterBkg: "#0b0a08",
        clusterBorder: "#d8bb8a",
        edgeLabelBackground: "#0b0a08",
        lineColor: "#d8bb8a",
        mainBkg: "#302922",
        noteBkgColor: "#302922",
        noteTextColor: "#f1e8dc",
        primaryBorderColor: "#d8bb8a",
        primaryColor: "#302922",
        primaryTextColor: "#f1e8dc",
        secondaryColor: "#171411",
        tertiaryColor: "#171411",
        textColor: "#f1e8dc",
      };
    case "black-tan":
      return {
        background: "#080604",
        clusterBkg: "#080604",
        clusterBorder: "#f0c98b",
        edgeLabelBackground: "#16110c",
        lineColor: "#f0c98b",
        mainBkg: "#18120d",
        noteBkgColor: "#18120d",
        noteTextColor: "#f4dfc1",
        primaryBorderColor: "#f0c98b",
        primaryColor: "#18120d",
        primaryTextColor: "#f4dfc1",
        secondaryColor: "#221a13",
        tertiaryColor: "#221a13",
        textColor: "#f4dfc1",
      };
    case "tan-black":
      return {
        background: "#100d09",
        clusterBkg: "#100d09",
        clusterBorder: "#2b1c11",
        edgeLabelBackground: "#ddc09b",
        lineColor: "#2b1c11",
        mainBkg: "#d6ba94",
        noteBkgColor: "#ead5b8",
        noteTextColor: "#130f0b",
        primaryBorderColor: "#2b1c11",
        primaryColor: "#d6ba94",
        primaryTextColor: "#130f0b",
        secondaryColor: "#c7a674",
        tertiaryColor: "#c7a674",
        textColor: "#130f0b",
      };
    case "blue":
    default:
      return {
        background: "#0f172a",
        clusterBkg: "#0f172a",
        clusterBorder: "#93c5fd",
        edgeLabelBackground: "#0f172a",
        lineColor: "#93c5fd",
        mainBkg: "#1e293b",
        noteBkgColor: "#1e293b",
        noteTextColor: "#e2e8f0",
        primaryBorderColor: "#93c5fd",
        primaryColor: "#1e293b",
        primaryTextColor: "#e2e8f0",
        secondaryColor: "#111827",
        tertiaryColor: "#111827",
        textColor: "#e2e8f0",
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
      darkMode: true,
      fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
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
