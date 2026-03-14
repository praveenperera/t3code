import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readViewportHeight,
  subscribeToViewportChanges,
  syncViewportHeightCssVar,
} from "./viewport";

function mockWindow(input: {
  innerHeight: number;
  visualViewport?: {
    height: number;
    addEventListener?: ReturnType<typeof vi.fn>;
    removeEventListener?: ReturnType<typeof vi.fn>;
  };
}) {
  return {
    innerHeight: input.innerHeight,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...(input.visualViewport
      ? {
          visualViewport: {
            height: input.visualViewport.height,
            addEventListener: input.visualViewport.addEventListener ?? vi.fn(),
            removeEventListener: input.visualViewport.removeEventListener ?? vi.fn(),
          },
        }
      : {}),
  } as unknown as Window;
}

function mockDocument() {
  const values = new Map<string, string>();

  return {
    documentElement: {
      style: {
        getPropertyValue: (name: string) => values.get(name) ?? "",
        removeProperty: (name: string) => {
          values.delete(name);
        },
        setProperty: (name: string, value: string) => {
          values.set(name, value);
        },
      },
    },
  } as unknown as Document;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readViewportHeight", () => {
  it("prefers the visual viewport height when available", () => {
    vi.stubGlobal(
      "window",
      mockWindow({
        innerHeight: 900,
        visualViewport: { height: 412.6 },
      }),
    );

    expect(readViewportHeight()).toBe(413);
  });

  it("falls back to window.innerHeight when no visual viewport is available", () => {
    vi.stubGlobal(
      "window",
      mockWindow({
        innerHeight: 731,
      }),
    );

    expect(readViewportHeight()).toBe(731);
  });
});

describe("subscribeToViewportChanges", () => {
  it("subscribes to both window and visual viewport changes", () => {
    const callback = vi.fn();
    const addViewportListener = vi.fn();
    const removeViewportListener = vi.fn();
    const windowStub = mockWindow({
      innerHeight: 800,
      visualViewport: {
        height: 500,
        addEventListener: addViewportListener,
        removeEventListener: removeViewportListener,
      },
    });

    vi.stubGlobal("window", windowStub);

    const unsubscribe = subscribeToViewportChanges(callback);

    expect(windowStub.addEventListener).toHaveBeenCalledWith("resize", callback);
    expect(addViewportListener).toHaveBeenCalledWith("resize", callback);
    expect(addViewportListener).toHaveBeenCalledWith("scroll", callback);

    unsubscribe();

    expect(windowStub.removeEventListener).toHaveBeenCalledWith("resize", callback);
    expect(removeViewportListener).toHaveBeenCalledWith("resize", callback);
    expect(removeViewportListener).toHaveBeenCalledWith("scroll", callback);
  });
});

describe("syncViewportHeightCssVar", () => {
  it("stores the current viewport height on the root element", () => {
    vi.stubGlobal(
      "window",
      mockWindow({
        innerHeight: 800,
        visualViewport: { height: 480 },
      }),
    );
    vi.stubGlobal("document", mockDocument());

    syncViewportHeightCssVar();

    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("480px");
  });
});
