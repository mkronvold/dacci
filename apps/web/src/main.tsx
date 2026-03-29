import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import "./styles.css";

type RuntimeConfig = {
  apiBaseUrl?: string;
};

async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const response = await fetch("/runtime-config.json", {
      cache: "no-store",
    });

    if (!response.ok) {
      return {};
    }

    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object") {
      return {};
    }

    const apiBaseUrl =
      "apiBaseUrl" in body && typeof body.apiBaseUrl === "string"
        ? body.apiBaseUrl.trim()
        : undefined;

    return apiBaseUrl ? { apiBaseUrl } : {};
  } catch {
    return {};
  }
}

const runtimeConfig = await loadRuntimeConfig();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App {...(runtimeConfig.apiBaseUrl ? { apiBaseUrl: runtimeConfig.apiBaseUrl } : {})} />
  </React.StrictMode>,
);
