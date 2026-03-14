import type { RenderResult } from "mermaid";

type MermaidTheme = "light" | "dark";
type MermaidModule = typeof import("mermaid");

let mermaidPromise: Promise<MermaidModule["default"]> | null = null;
let configuredTheme: MermaidTheme | null = null;

async function getMermaid() {
  mermaidPromise ??= import("mermaid").then((module) => module.default);
  return mermaidPromise;
}

function configureMermaid(
  mermaid: Awaited<ReturnType<typeof getMermaid>>,
  theme: MermaidTheme,
): void {
  if (configuredTheme === theme) {
    return;
  }

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme === "dark" ? "dark" : "default",
  });
  configuredTheme = theme;
}

export async function renderMermaidDiagram(options: {
  code: string;
  id: string;
  theme: MermaidTheme;
}): Promise<RenderResult> {
  const mermaid = await getMermaid();
  configureMermaid(mermaid, options.theme);
  return mermaid.render(options.id, options.code);
}
