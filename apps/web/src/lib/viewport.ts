export const APP_VIEWPORT_CSS_HEIGHT = "var(--app-viewport-height, 100dvh)";

export function readViewportHeight(): number {
  if (typeof window === "undefined") {
    return 0;
  }

  const visualViewport = window.visualViewport;
  if (visualViewport) {
    return Math.max(0, Math.round(visualViewport.height));
  }

  return Math.max(0, Math.round(window.innerHeight));
}

export function subscribeToViewportChanges(callback: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const visualViewport = window.visualViewport;
  window.addEventListener("resize", callback);
  visualViewport?.addEventListener("resize", callback);
  visualViewport?.addEventListener("scroll", callback);

  return () => {
    window.removeEventListener("resize", callback);
    visualViewport?.removeEventListener("resize", callback);
    visualViewport?.removeEventListener("scroll", callback);
  };
}

export function syncViewportHeightCssVar(): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.style.setProperty("--app-viewport-height", `${readViewportHeight()}px`);
}
