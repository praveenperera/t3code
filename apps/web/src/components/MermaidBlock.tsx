import {
  CheckIcon,
  CopyIcon,
  Maximize2Icon,
  MinusIcon,
  RotateCcwIcon,
  XIcon,
  PlusIcon,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { randomUUID } from "../lib/utils";
import { renderMermaidDiagram } from "../lib/mermaid";
import { Spinner } from "./ui/spinner";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Button } from "./ui/button";
import { Dialog, DialogPopup } from "./ui/dialog";

type MermaidViewMode = "preview" | "code";
type MermaidRenderState = "idle" | "loading" | "rendered" | "error";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.2;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

interface MermaidBlockProps {
  code: string;
  isStreaming: boolean;
  resolvedTheme: "light" | "dark";
}

const MermaidBlock = memo(function MermaidBlock({
  code,
  isStreaming,
  resolvedTheme,
}: MermaidBlockProps) {
  const idRef = useRef(`mermaid-${randomUUID()}`);
  const previewRef = useRef<HTMLDivElement>(null);
  const fullscreenPreviewRef = useRef<HTMLDivElement>(null);
  const bindFunctionsRef = useRef<((element: Element) => void) | undefined>(undefined);
  const panPointerRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const forcedCodeViewRef = useRef(false);
  const [viewMode, setViewMode] = useState<MermaidViewMode>(isStreaming ? "code" : "preview");
  const [renderState, setRenderState] = useState<MermaidRenderState>(
    isStreaming ? "idle" : "loading",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [renderedSvg, setRenderedSvg] = useState<string | null>(null);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const { copied, handleCopy } = useCopyToClipboard(code);

  useEffect(() => {
    if (isStreaming) {
      if (viewMode !== "code") {
        forcedCodeViewRef.current = true;
        setViewMode("code");
      }
      return;
    }

    if (forcedCodeViewRef.current && viewMode === "code") {
      forcedCodeViewRef.current = false;
      setViewMode("preview");
    }
  }, [isStreaming, viewMode]);

  useEffect(() => {
    if (viewMode !== "preview") {
      setFullscreenOpen(false);
    }
  }, [viewMode]);

  useEffect(() => {
    if (!fullscreenOpen) {
      setZoomLevel(1);
      setPanOffset({ x: 0, y: 0 });
      panPointerRef.current = null;
    }
  }, [fullscreenOpen]);

  useEffect(() => {
    if (isStreaming || viewMode !== "preview") {
      setRenderState("idle");
      setErrorMessage(null);
      setRenderedSvg(null);
      bindFunctionsRef.current = undefined;
      return;
    }

    let cancelled = false;
    setRenderState("loading");
    setErrorMessage(null);
    setRenderedSvg(null);
    bindFunctionsRef.current = undefined;

    void renderMermaidDiagram({
      code,
      id: idRef.current,
      theme: resolvedTheme,
    })
      .then(({ svg, bindFunctions }) => {
        if (cancelled) {
          return;
        }

        setRenderedSvg(svg);
        bindFunctionsRef.current = bindFunctions;
        setRenderState("rendered");
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setRenderedSvg(null);
        bindFunctionsRef.current = undefined;
        setRenderState("error");
        setErrorMessage(
          error instanceof Error ? error.message : "Unable to render Mermaid diagram.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [code, isStreaming, resolvedTheme, viewMode]);

  useEffect(() => {
    if (!renderedSvg || !previewRef.current) {
      return;
    }

    bindFunctionsRef.current?.(previewRef.current);
  }, [renderedSvg]);

  useEffect(() => {
    if (!fullscreenOpen || !renderedSvg || !fullscreenPreviewRef.current) {
      return;
    }

    bindFunctionsRef.current?.(fullscreenPreviewRef.current);
  }, [fullscreenOpen, renderedSvg]);

  const updateZoomLevel = (nextValue: number) => {
    const clamped = clampZoom(nextValue);
    setZoomLevel(clamped);
    if (clamped <= 1) {
      setPanOffset({ x: 0, y: 0 });
    }
  };

  const resetFullscreenView = () => {
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
  };

  return (
    <>
      <div className="chat-markdown-mermaid-block">
        <div className="chat-markdown-mermaid-toolbar">
          <ToggleGroup
            size="xs"
            variant="outline"
            value={[viewMode]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "preview" || next === "code") {
                setViewMode(next);
              }
            }}
          >
            <Toggle aria-label="Mermaid diagram preview" disabled={isStreaming} value="preview">
              Preview
            </Toggle>
            <Toggle aria-label="Mermaid source code" value="code">
              Code
            </Toggle>
          </ToggleGroup>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={renderState !== "rendered" || renderedSvg == null}
              onClick={() => setFullscreenOpen(true)}
              title="Open fullscreen Mermaid preview"
            >
              <Maximize2Icon className="size-3" />
              <span>Fullscreen</span>
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={handleCopy}
              title={copied ? "Copied" : "Copy Mermaid code"}
            >
              {copied ? (
                <CheckIcon className="size-3 text-success" />
              ) : (
                <CopyIcon className="size-3" />
              )}
              <span>{copied ? "Copied" : "Copy"}</span>
            </Button>
          </div>
        </div>

        {viewMode === "preview" ? (
          <div className="chat-markdown-mermaid-surface">
            {renderState === "loading" ? (
              <div className="chat-markdown-mermaid-status">
                <Spinner className="size-4 text-muted-foreground" />
                <span>Rendering diagram...</span>
              </div>
            ) : null}
            {renderState === "error" ? (
              <div className="chat-markdown-mermaid-status chat-markdown-mermaid-status-error">
                <span>{errorMessage ?? "Unable to render Mermaid diagram."}</span>
              </div>
            ) : null}
            {isStreaming ? (
              <div className="chat-markdown-mermaid-status">
                <span>Diagram preview will render when streaming finishes.</span>
              </div>
            ) : null}
            {renderState === "rendered" && renderedSvg ? (
              <div
                ref={previewRef}
                className="chat-markdown-mermaid-preview"
                dangerouslySetInnerHTML={{ __html: renderedSvg }}
              />
            ) : null}
          </div>
        ) : (
          <div className="chat-markdown-mermaid-surface">
            <pre className="chat-markdown-mermaid-code">
              <code>{code}</code>
            </pre>
          </div>
        )}
      </div>

      <Dialog
        open={fullscreenOpen}
        onOpenChange={(open) => {
          setFullscreenOpen(open);
        }}
      >
        <DialogPopup
          bottomStickOnMobile={false}
          showCloseButton={false}
          className="h-screen w-screen max-w-none rounded-none border-0 bg-background/96 p-0 before:hidden"
        >
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-3 sm:px-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Mermaid diagram</p>
                <p className="text-xs text-muted-foreground">
                  Wheel to zoom. Drag to pan when zoomed in.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="icon-xs"
                  variant="outline"
                  onClick={() => updateZoomLevel(zoomLevel - ZOOM_STEP)}
                  title="Zoom out"
                >
                  <MinusIcon className="size-3" />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="outline"
                  onClick={resetFullscreenView}
                  title="Reset zoom"
                >
                  <RotateCcwIcon className="size-3" />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="outline"
                  onClick={() => updateZoomLevel(zoomLevel + ZOOM_STEP)}
                  title="Zoom in"
                >
                  <PlusIcon className="size-3" />
                </Button>
                <span className="min-w-12 text-right text-xs font-medium tabular-nums text-muted-foreground">
                  {Math.round(zoomLevel * 100)}%
                </span>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="outline"
                  onClick={() => setFullscreenOpen(false)}
                  title="Close fullscreen Mermaid preview"
                >
                  <XIcon className="size-3" />
                </Button>
              </div>
            </div>

            <div
              className="chat-markdown-mermaid-fullscreen-viewport"
              onDoubleClick={resetFullscreenView}
              onPointerDown={(event) => {
                if (zoomLevel <= 1) {
                  return;
                }

                event.currentTarget.setPointerCapture(event.pointerId);
                panPointerRef.current = {
                  id: event.pointerId,
                  startX: event.clientX,
                  startY: event.clientY,
                  originX: panOffset.x,
                  originY: panOffset.y,
                };
              }}
              onPointerMove={(event) => {
                const activePan = panPointerRef.current;
                if (!activePan || activePan.id !== event.pointerId) {
                  return;
                }

                setPanOffset({
                  x: activePan.originX + (event.clientX - activePan.startX),
                  y: activePan.originY + (event.clientY - activePan.startY),
                });
              }}
              onPointerUp={(event) => {
                if (panPointerRef.current?.id === event.pointerId) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  panPointerRef.current = null;
                }
              }}
              onPointerCancel={(event) => {
                if (panPointerRef.current?.id === event.pointerId) {
                  panPointerRef.current = null;
                }
              }}
              onWheel={(event) => {
                event.preventDefault();
                updateZoomLevel(zoomLevel + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
              }}
            >
              {renderedSvg ? (
                <div className="chat-markdown-mermaid-fullscreen-stage">
                  <div
                    ref={fullscreenPreviewRef}
                    className="chat-markdown-mermaid-fullscreen-preview"
                    dangerouslySetInnerHTML={{ __html: renderedSvg }}
                    style={{
                      transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`,
                    }}
                  />
                </div>
              ) : null}
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
});

export default MermaidBlock;
