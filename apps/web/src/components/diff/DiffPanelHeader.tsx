import { type TurnId } from "@t3tools/contracts";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  Maximize2Icon,
  Rows3Icon,
  XIcon,
} from "lucide-react";
import {
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { formatShortTimestamp } from "~/timestampFormat";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "~/appSettings";
import { type TurnDiffSummary } from "~/types";

import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export type DiffRenderMode = "stacked" | "split";

export function DiffPanelHeader(props: {
  closeDiff: () => void;
  diffRenderMode: DiffRenderMode;
  isUncommittedSelection: boolean;
  onOpenFullDiff: () => void;
  onSelectTurn: (turnId: TurnId) => void;
  onSelectUncommitted: () => void;
  onSelectWholeConversation: () => void;
  orderedTurnDiffSummaries: readonly TurnDiffSummary[];
  routeThreadId: TurnId | null | string | null;
  selectedRenderedTurnId: TurnId | null;
  selectedTurnId: TurnId | null;
  setDiffRenderMode: (mode: DiffRenderMode) => void;
  shouldUseCompactMobileHeader: boolean;
  timestampFormat: TimestampFormat;
  turnCountByTurnId: Record<string, number | undefined>;
  variant: "compact" | "full";
}) {
  const shouldShowTurnStripScrollButtons = !props.shouldUseCompactMobileHeader;
  const turnStripRef = useRef<HTMLDivElement>(null);
  const [canScrollTurnStripLeft, setCanScrollTurnStripLeft] = useState(false);
  const [canScrollTurnStripRight, setCanScrollTurnStripRight] = useState(false);

  const updateTurnStripScrollState = useCallback(() => {
    const element = turnStripRef.current;
    if (!element) {
      setCanScrollTurnStripLeft(false);
      setCanScrollTurnStripRight(false);
      return;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    setCanScrollTurnStripLeft(element.scrollLeft > 4);
    setCanScrollTurnStripRight(element.scrollLeft < maxScrollLeft - 4);
  }, []);

  const scrollTurnStripBy = useCallback((offset: number) => {
    const element = turnStripRef.current;
    if (!element) return;
    element.scrollBy({ left: offset, behavior: "smooth" });
  }, []);

  const onTurnStripWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const element = turnStripRef.current;
    if (!element) return;
    if (element.scrollWidth <= element.clientWidth + 1) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    event.preventDefault();
    element.scrollBy({ left: event.deltaY, behavior: "auto" });
  }, []);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    const onScroll = () => updateTurnStripScrollState();

    element.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateTurnStripScrollState());
    resizeObserver.observe(element);

    return () => {
      window.cancelAnimationFrame(frameId);
      element.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
    };
  }, [updateTurnStripScrollState]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    props.isUncommittedSelection,
    props.orderedTurnDiffSummaries,
    props.selectedTurnId,
    updateTurnStripScrollState,
  ]);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const selectedChip = element.querySelector<HTMLElement>("[data-turn-chip-selected='true']");
    selectedChip?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [props.isUncommittedSelection, props.selectedRenderedTurnId, props.selectedTurnId]);

  return (
    <>
      <div className="relative min-w-0 flex-1 [-webkit-app-region:no-drag]">
        {shouldShowTurnStripScrollButtons && canScrollTurnStripLeft && (
          <div className="pointer-events-none absolute inset-y-0 left-8 z-10 w-7 bg-linear-to-r from-card to-transparent" />
        )}
        {shouldShowTurnStripScrollButtons && canScrollTurnStripRight && (
          <div className="pointer-events-none absolute inset-y-0 right-8 z-10 w-7 bg-linear-to-l from-card to-transparent" />
        )}
        {shouldShowTurnStripScrollButtons && (
          <button
            type="button"
            className={cn(
              "absolute left-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
              canScrollTurnStripLeft
                ? "border-border/70 hover:border-border hover:text-foreground"
                : "cursor-not-allowed border-border/40 text-muted-foreground/40",
            )}
            onClick={() => scrollTurnStripBy(-180)}
            disabled={!canScrollTurnStripLeft}
            aria-label="Scroll turn list left"
          >
            <ChevronLeftIcon className="size-3.5" />
          </button>
        )}
        {shouldShowTurnStripScrollButtons && (
          <button
            type="button"
            className={cn(
              "absolute right-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
              canScrollTurnStripRight
                ? "border-border/70 hover:border-border hover:text-foreground"
                : "cursor-not-allowed border-border/40 text-muted-foreground/40",
            )}
            onClick={() => scrollTurnStripBy(180)}
            disabled={!canScrollTurnStripRight}
            aria-label="Scroll turn list right"
          >
            <ChevronRightIcon className="size-3.5" />
          </button>
        )}
        <div
          ref={turnStripRef}
          className={cn(
            "turn-chip-strip flex gap-1 overflow-x-auto py-0.5",
            shouldShowTurnStripScrollButtons ? "px-8" : "px-1",
          )}
          onWheel={onTurnStripWheel}
        >
          <button
            type="button"
            className="shrink-0 rounded-md"
            onClick={props.onSelectUncommitted}
            data-turn-chip-selected={props.isUncommittedSelection}
          >
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-left transition-colors",
                props.isUncommittedSelection
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
              )}
            >
              <div className="text-[10px] leading-tight font-medium">Uncommitted</div>
            </div>
          </button>
          <button
            type="button"
            className="shrink-0 rounded-md"
            onClick={props.onSelectWholeConversation}
            data-turn-chip-selected={!props.isUncommittedSelection && props.selectedTurnId === null}
          >
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-left transition-colors",
                !props.isUncommittedSelection && props.selectedTurnId === null
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
              )}
            >
              <div className="text-[10px] leading-tight font-medium">
                {props.shouldUseCompactMobileHeader ? "All" : "All turns"}
              </div>
            </div>
          </button>
          {props.orderedTurnDiffSummaries.map((summary) => (
            <button
              key={summary.turnId}
              type="button"
              className="shrink-0 rounded-md"
              onClick={() => props.onSelectTurn(summary.turnId)}
              title={summary.turnId}
              data-turn-chip-selected={summary.turnId === props.selectedRenderedTurnId}
            >
              <div
                className={cn(
                  "rounded-md border px-2 py-1 text-left transition-colors",
                  summary.turnId === props.selectedRenderedTurnId
                    ? "border-border bg-accent text-accent-foreground"
                    : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
                )}
              >
                <div className="flex items-center gap-1">
                  <span className="text-[10px] leading-tight font-medium">
                    {props.shouldUseCompactMobileHeader ? "T" : "Turn"}{" "}
                    {summary.checkpointTurnCount ?? props.turnCountByTurnId[summary.turnId] ?? "?"}
                  </span>
                  {!props.shouldUseCompactMobileHeader && (
                    <span className="text-[9px] leading-tight opacity-70">
                      {formatShortTimestamp(summary.completedAt, props.timestampFormat)}
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]",
          props.shouldUseCompactMobileHeader &&
            "rounded-lg border border-border/80 bg-popover/95 p-1 shadow-lg backdrop-blur-md dark:bg-popover/92",
        )}
      >
        <ToggleGroup
          className="shrink-0"
          variant={props.shouldUseCompactMobileHeader ? "default" : "outline"}
          size="xs"
          value={[props.diffRenderMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              props.setDiffRenderMode(next);
            }
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked">
            <Rows3Icon className="size-3" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-3" />
          </Toggle>
        </ToggleGroup>
        {props.variant === "compact" && props.routeThreadId && (
          <Button
            type="button"
            size="sm"
            variant={props.shouldUseCompactMobileHeader ? "ghost" : "outline"}
            className={cn("h-7 shrink-0", props.shouldUseCompactMobileHeader ? "px-1.5" : "px-2")}
            onClick={props.onOpenFullDiff}
            aria-label="Open full diff view"
          >
            {props.shouldUseCompactMobileHeader ? (
              <Maximize2Icon className="size-3.5" />
            ) : (
              "Full diff"
            )}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant={props.shouldUseCompactMobileHeader ? "ghost" : "outline"}
          className={cn(
            "h-7 shrink-0",
            props.shouldUseCompactMobileHeader ? "gap-0 px-1.5" : "gap-1.5 px-2",
          )}
          aria-label="Close diff panel"
          onClick={props.closeDiff}
        >
          <XIcon className="size-3.5" />
          {!props.shouldUseCompactMobileHeader && <span>Close</span>}
        </Button>
      </div>
    </>
  );
}
