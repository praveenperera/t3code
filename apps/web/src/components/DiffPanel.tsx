import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { LOCAL_EXECUTION_TARGET_ID, ThreadId, type TurnId } from "@t3tools/contracts";
import { PanelLeftIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { openInPreferredEditor } from "../editorPreferences";
import { gitBranchesQueryOptions, gitWorkingTreeDiffQueryOptions } from "~/lib/gitReactQuery";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { readNativeApi } from "../nativeApi";
import { resolvePathLinkTarget } from "../terminal-links";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useStore } from "../store";
import { Button } from "./ui/button";
import { useAppSettings } from "../appSettings";
import {
  collectExpandedDirectoryPaths,
  buildDiffFileTree,
  DiffFileTree,
} from "./diff/DiffFileTree";
import { DiffPanelHeader, type DiffRenderMode } from "./diff/DiffPanelHeader";
import {
  readDiffFileTreeScrollTop,
  writeDiffFileTreeScrollTop,
} from "./diff/diffFileTreeScrollState";
import {
  buildFileDiffRenderKey,
  DIFF_PANEL_UNSAFE_CSS,
  getRenderablePatch,
  resolveFileDiffPath,
} from "./diff/diffRendering";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
type DiffThemeType = "light" | "dark";
interface DiffPanelProps {
  mode?: DiffPanelMode;
  onCloseDiff?: () => void;
  variant?: "compact" | "full";
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({
  mode = "inline",
  onCloseDiff,
  variant = "compact",
}: DiffPanelProps) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const { settings } = useAppSettings();
  const isMobileViewport = useMediaQuery("(max-width: 767px)");
  const isTouchViewport = useMediaQuery("(pointer: coarse), (hover: none)");
  const shouldUseCompactMobileHeader = isMobileViewport || isTouchViewport;
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>(
    variant === "full" ? "split" : "stacked",
  );
  const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>({});
  const [isMobileFileTreeOpen, setIsMobileFileTreeOpen] = useState(true);
  const fileTreeViewportRef = useRef<HTMLDivElement>(null);
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const activeThreadId = routeThreadId;
  const activeThread = useStore((store) =>
    activeThreadId ? store.threads.find((thread) => thread.id === activeThreadId) : undefined,
  );
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projects.find((project) => project.id === activeProjectId) : undefined,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd;
  const targetId = activeThread?.targetId ?? LOCAL_EXECUTION_TARGET_ID;
  const gitBranchesQuery = useQuery(gitBranchesQueryOptions({ cwd: activeCwd ?? null, targetId }));
  const isGitRepo = gitBranchesQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  const selectedTurnId = diffSearch.diffTurnId ?? null;
  const selectedDiffScope = diffSearch.diffScope ?? null;
  const isUncommittedSelection = selectedDiffScope === "uncommitted";
  const selectedFilePath =
    variant === "full"
      ? (diffSearch.diffFilePath ?? null)
      : selectedTurnId !== null
        ? (diffSearch.diffFilePath ?? null)
        : null;
  const selectedTurn =
    isUncommittedSelection || selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const conversationCheckpointTurnCount = useMemo(() => {
    const turnCounts = orderedTurnDiffSummaries
      .map(
        (summary) =>
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
      )
      .filter((value): value is number => typeof value === "number");
    if (turnCounts.length === 0) {
      return undefined;
    }
    const latest = Math.max(...turnCounts);
    return latest > 0 ? latest : undefined;
  }, [inferredCheckpointTurnCountByTurnId, orderedTurnDiffSummaries]);
  const conversationCheckpointRange = useMemo(
    () =>
      !isUncommittedSelection &&
      !selectedTurn &&
      typeof conversationCheckpointTurnCount === "number"
        ? {
            fromTurnCount: 0,
            toTurnCount: conversationCheckpointTurnCount,
          }
        : null,
    [conversationCheckpointTurnCount, isUncommittedSelection, selectedTurn],
  );
  const activeCheckpointRange = isUncommittedSelection
    ? null
    : selectedTurn
      ? selectedCheckpointRange
      : conversationCheckpointRange;
  const conversationCacheScope = useMemo(() => {
    if (isUncommittedSelection || selectedTurn || orderedTurnDiffSummaries.length === 0) {
      return null;
    }
    return `conversation:${orderedTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  }, [isUncommittedSelection, orderedTurnDiffSummaries, selectedTurn]);
  const activeCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationCacheScope,
      enabled: isGitRepo && !isUncommittedSelection,
    }),
  );
  const workingTreeDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: activeCwd ?? null,
      targetId,
      enabled: isGitRepo && isUncommittedSelection,
    }),
  );
  const selectedTurnCheckpointDiff = selectedTurn
    ? activeCheckpointDiffQuery.data?.diff
    : undefined;
  const conversationCheckpointDiff = selectedTurn
    ? undefined
    : activeCheckpointDiffQuery.data?.diff;
  const isLoadingCheckpointDiff = isUncommittedSelection
    ? workingTreeDiffQuery.isLoading
    : activeCheckpointDiffQuery.isLoading;
  const checkpointDiffError = isUncommittedSelection
    ? workingTreeDiffQuery.error instanceof Error
      ? workingTreeDiffQuery.error.message
      : workingTreeDiffQuery.error
        ? "Failed to load working tree diff."
        : null
    : activeCheckpointDiffQuery.error instanceof Error
      ? activeCheckpointDiffQuery.error.message
      : activeCheckpointDiffQuery.error
        ? "Failed to load checkpoint diff."
        : null;

  const selectedPatch = isUncommittedSelection
    ? workingTreeDiffQuery.data?.diff
    : selectedTurn
      ? selectedTurnCheckpointDiff
      : conversationCheckpointDiff;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderablePatch = useMemo(
    () => getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`),
    [resolvedTheme, selectedPatch],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);
  const renderableFilesByPath = useMemo(
    () => new Map(renderableFiles.map((fileDiff) => [resolveFileDiffPath(fileDiff), fileDiff])),
    [renderableFiles],
  );
  const fileTreeNodes = useMemo(() => buildDiffFileTree(renderableFiles), [renderableFiles]);
  const activeFilePath = useMemo(() => {
    if (variant !== "full") {
      return selectedFilePath;
    }
    const firstRenderableFile = renderableFiles[0];
    if (!firstRenderableFile) {
      return null;
    }
    if (selectedFilePath && renderableFilesByPath.has(selectedFilePath)) {
      return selectedFilePath;
    }
    return resolveFileDiffPath(firstRenderableFile);
  }, [renderableFiles, renderableFilesByPath, selectedFilePath, variant]);
  const activeFileDiff = activeFilePath
    ? (renderableFilesByPath.get(activeFilePath) ?? null)
    : null;
  const visibleFileDiffs =
    variant === "full" ? (activeFileDiff ? [activeFileDiff] : []) : renderableFiles;
  const shouldCollapseFileTreeOnMobile =
    variant === "full" && (isMobileViewport || isTouchViewport);
  const showFileTree =
    variant === "full" &&
    renderablePatch?.kind === "files" &&
    activeFilePath !== null &&
    (!shouldCollapseFileTreeOnMobile || isMobileFileTreeOpen);
  const diffFileTreeScrollStateKey = useMemo(() => {
    if (variant !== "full" || !routeThreadId) {
      return null;
    }
    return [
      routeThreadId,
      isUncommittedSelection ? "uncommitted" : "checkpoint",
      selectedTurnId ?? "all",
    ].join(":");
  }, [isUncommittedSelection, routeThreadId, selectedTurnId, variant]);

  useEffect(() => {
    if (!shouldCollapseFileTreeOnMobile) {
      setIsMobileFileTreeOpen(true);
    }
  }, [shouldCollapseFileTreeOnMobile]);

  useEffect(() => {
    if (variant !== "full") {
      return;
    }
    if (fileTreeNodes.length === 0) {
      setExpandedDirectories({});
      return;
    }

    const nextExpandedDirectories = Object.fromEntries(
      collectExpandedDirectoryPaths(fileTreeNodes).map((directoryPath) => [directoryPath, true]),
    );
    setExpandedDirectories((current) => {
      let changed = Object.keys(current).length !== Object.keys(nextExpandedDirectories).length;
      const merged = { ...nextExpandedDirectories };
      for (const [directoryPath, isExpanded] of Object.entries(current)) {
        if (!(directoryPath in nextExpandedDirectories)) {
          continue;
        }
        if (merged[directoryPath] !== isExpanded) {
          changed = true;
        }
        merged[directoryPath] = isExpanded;
      }
      return changed ? merged : current;
    });
  }, [fileTreeNodes, variant]);

  useLayoutEffect(() => {
    if (variant !== "full" || !showFileTree || !diffFileTreeScrollStateKey) {
      return;
    }
    const viewport = fileTreeViewportRef.current;
    if (!viewport) {
      return;
    }
    const savedScrollTop = readDiffFileTreeScrollTop(diffFileTreeScrollStateKey);
    if (viewport.scrollTop === savedScrollTop) {
      return;
    }
    viewport.scrollTop = savedScrollTop;
  }, [activeFilePath, diffFileTreeScrollStateKey, fileTreeNodes, showFileTree, variant]);

  useEffect(() => {
    if (variant !== "full") {
      if (!selectedFilePath || !patchViewportRef.current) {
        return;
      }
      const target = Array.from(
        patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
      ).find((element) => element.dataset.diffFilePath === selectedFilePath);
      target?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (!patchViewportRef.current) {
      return;
    }
    patchViewportRef.current.scrollTop = 0;
    patchViewportRef.current.scrollLeft = 0;
  }, [activeFilePath, selectedFilePath, variant]);

  const openDiffFileInEditor = useCallback(
    (filePath: string) => {
      const api = readNativeApi();
      if (!api) return;
      const targetPath = activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath;
      void openInPreferredEditor(api, targetPath).catch((error) => {
        console.warn("Failed to open diff file in editor.", error);
      });
    },
    [activeCwd],
  );
  const diffRouteTo = variant === "full" ? "/$threadId/diff" : "/$threadId";
  const buildDiffSearch = useCallback(
    (next: {
      diffFilePath?: string;
      diffScope?: "uncommitted" | null;
      diffTurnId?: TurnId | null;
    }) => {
      return (previous: ReturnType<typeof parseDiffRouteSearch>) => {
        const rest = stripDiffSearchParams(previous as Record<string, unknown>);
        return {
          ...rest,
          ...(variant === "full" ? {} : { diff: "1" as const }),
          ...(next.diffScope === "uncommitted" ? { diffScope: "uncommitted" as const } : {}),
          ...(next.diffTurnId ? { diffTurnId: next.diffTurnId } : {}),
          ...(next.diffFilePath ? { diffFilePath: next.diffFilePath } : {}),
        };
      };
    },
    [variant],
  );

  const selectTurn = (turnId: TurnId) => {
    if (!activeThread) return;
    void navigate({
      to: diffRouteTo,
      params: { threadId: activeThread.id },
      search: buildDiffSearch({ diffScope: null, diffTurnId: turnId }),
    });
  };
  const selectWholeConversation = () => {
    if (!activeThread) return;
    void navigate({
      to: diffRouteTo,
      params: { threadId: activeThread.id },
      search: buildDiffSearch({ diffScope: null }),
    });
  };
  const selectUncommitted = () => {
    if (!activeThread) return;
    void navigate({
      to: diffRouteTo,
      params: { threadId: activeThread.id },
      search: buildDiffSearch({ diffScope: "uncommitted" }),
    });
  };
  const selectFile = useCallback(
    (filePath: string) => {
      if (!activeThread) return;
      if (diffFileTreeScrollStateKey && fileTreeViewportRef.current) {
        writeDiffFileTreeScrollTop(
          diffFileTreeScrollStateKey,
          fileTreeViewportRef.current.scrollTop,
        );
      }
      if (shouldCollapseFileTreeOnMobile) {
        setIsMobileFileTreeOpen(false);
      }
      void navigate({
        to: diffRouteTo,
        params: { threadId: activeThread.id },
        search: buildDiffSearch({
          diffScope: isUncommittedSelection ? "uncommitted" : null,
          diffTurnId: selectedTurnId,
          diffFilePath: filePath,
        }),
      });
    },
    [
      activeThread,
      buildDiffSearch,
      diffFileTreeScrollStateKey,
      diffRouteTo,
      fileTreeViewportRef,
      isUncommittedSelection,
      navigate,
      selectedTurnId,
      shouldCollapseFileTreeOnMobile,
    ],
  );
  const toggleDirectory = useCallback((directoryPath: string) => {
    setExpandedDirectories((current) => ({
      ...current,
      [directoryPath]: !(current[directoryPath] ?? true),
    }));
  }, []);
  const openFullDiff = useCallback(() => {
    if (!routeThreadId) return;
    void navigate({
      to: "/$threadId/diff",
      params: { threadId: routeThreadId },
      search: {
        ...(isUncommittedSelection ? { diffScope: "uncommitted" as const } : {}),
        ...(selectedTurnId ? { diffTurnId: selectedTurnId } : {}),
        ...(activeFilePath ? { diffFilePath: activeFilePath } : {}),
      },
    });
  }, [activeFilePath, isUncommittedSelection, navigate, routeThreadId, selectedTurnId]);

  const closeDiff = useCallback(() => {
    if (onCloseDiff) {
      onCloseDiff();
      return;
    }
    if (!routeThreadId) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: routeThreadId },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: undefined };
      },
    });
  }, [navigate, onCloseDiff, routeThreadId]);
  const headerRow = (
    <DiffPanelHeader
      closeDiff={closeDiff}
      diffRenderMode={diffRenderMode}
      isUncommittedSelection={isUncommittedSelection}
      onOpenFullDiff={openFullDiff}
      onSelectTurn={selectTurn}
      onSelectUncommitted={selectUncommitted}
      onSelectWholeConversation={selectWholeConversation}
      orderedTurnDiffSummaries={orderedTurnDiffSummaries}
      routeThreadId={routeThreadId}
      selectedRenderedTurnId={selectedTurn?.turnId ?? null}
      selectedTurnId={selectedTurnId}
      setDiffRenderMode={setDiffRenderMode}
      shouldUseCompactMobileHeader={shouldUseCompactMobileHeader}
      timestampFormat={settings.timestampFormat}
      turnCountByTurnId={inferredCheckpointTurnCountByTurnId}
      variant={variant}
    />
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : variant === "full" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
          {showFileTree && (
            <DiffFileTree
              activeFilePath={activeFilePath}
              expandedDirectories={expandedDirectories}
              nodes={fileTreeNodes}
              onOpenInEditor={openDiffFileInEditor}
              onScrollViewport={(scrollTop) => {
                if (!diffFileTreeScrollStateKey) {
                  return;
                }
                writeDiffFileTreeScrollTop(diffFileTreeScrollStateKey, scrollTop);
              }}
              onSelectFile={selectFile}
              onToggleDirectory={toggleDirectory}
              scrollViewportRef={fileTreeViewportRef}
              {...(shouldCollapseFileTreeOnMobile
                ? {
                    onToggleVisibility: () => setIsMobileFileTreeOpen(false),
                    showVisibilityToggle: true,
                  }
                : {})}
            />
          )}
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            {shouldCollapseFileTreeOnMobile &&
              renderablePatch?.kind === "files" &&
              !showFileTree && (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="absolute left-5 top-3 z-10 size-8 border-border/90 bg-popover/95 text-foreground shadow-lg backdrop-blur-md dark:bg-popover/92"
                  aria-label="Show files"
                  onClick={() => setIsMobileFileTreeOpen(true)}
                >
                  <PanelLeftIcon className="size-4" />
                </Button>
              )}
            <div
              ref={patchViewportRef}
              className="diff-panel-viewport flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            >
              {checkpointDiffError && !renderablePatch && (
                <div className="px-3">
                  <p className="mb-2 text-[11px] text-red-500/80">{checkpointDiffError}</p>
                </div>
              )}
              {!renderablePatch ? (
                isLoadingCheckpointDiff ? (
                  <DiffPanelLoadingState label="Loading checkpoint diff..." />
                ) : (
                  <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                    <p>
                      {hasNoNetChanges
                        ? "No net changes in this selection."
                        : "No patch available for this selection."}
                    </p>
                  </div>
                )
              ) : renderablePatch.kind === "files" ? (
                <Virtualizer
                  className="diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2"
                  config={{
                    overscrollSize: 600,
                    intersectionObserverMargin: 1200,
                  }}
                >
                  <div
                    className="diff-render-canvas min-w-full w-max"
                    data-diff-render-mode={diffRenderMode}
                  >
                    {visibleFileDiffs.map((fileDiff) => {
                      const filePath = resolveFileDiffPath(fileDiff);
                      const fileKey = buildFileDiffRenderKey(fileDiff);
                      const themedFileKey = `${fileKey}:${resolvedTheme}`;
                      return (
                        <div
                          key={themedFileKey}
                          data-diff-file-path={filePath}
                          className="diff-render-file mb-2 rounded-md first:mt-2 last:mb-0"
                          onClickCapture={(event) => {
                            const nativeEvent = event.nativeEvent as MouseEvent;
                            const composedPath = nativeEvent.composedPath?.() ?? [];
                            const clickedHeader = composedPath.some((node) => {
                              if (!(node instanceof Element)) return false;
                              return node.hasAttribute("data-title");
                            });
                            if (!clickedHeader) return;
                            openDiffFileInEditor(filePath);
                          }}
                        >
                          <FileDiff
                            fileDiff={fileDiff}
                            options={{
                              diffStyle: diffRenderMode === "split" ? "split" : "unified",
                              lineDiffType: "none",
                              theme: resolveDiffThemeName(resolvedTheme),
                              themeType: resolvedTheme as DiffThemeType,
                              unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </Virtualizer>
              ) : (
                <div className="diff-raw-surface h-full overflow-auto p-2">
                  <div className="diff-render-canvas min-w-full w-max space-y-2">
                    <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                    <pre className="max-h-[72vh] min-w-[48rem] overflow-auto rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90 max-md:min-w-[42rem]">
                      {renderablePatch.text}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div
          ref={patchViewportRef}
          className="diff-panel-viewport flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
          {checkpointDiffError && !renderablePatch && (
            <div className="px-3">
              <p className="mb-2 text-[11px] text-red-500/80">{checkpointDiffError}</p>
            </div>
          )}
          {!renderablePatch ? (
            isLoadingCheckpointDiff ? (
              <DiffPanelLoadingState label="Loading checkpoint diff..." />
            ) : (
              <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                <p>
                  {hasNoNetChanges
                    ? "No net changes in this selection."
                    : "No patch available for this selection."}
                </p>
              </div>
            )
          ) : renderablePatch.kind === "files" ? (
            <Virtualizer
              className="diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2"
              config={{
                overscrollSize: 600,
                intersectionObserverMargin: 1200,
              }}
            >
              {visibleFileDiffs.map((fileDiff) => {
                const filePath = resolveFileDiffPath(fileDiff);
                const fileKey = buildFileDiffRenderKey(fileDiff);
                const themedFileKey = `${fileKey}:${resolvedTheme}`;
                return (
                  <div
                    key={themedFileKey}
                    data-diff-file-path={filePath}
                    className="diff-render-file mb-2 rounded-md first:mt-2 last:mb-0"
                    onClickCapture={(event) => {
                      const nativeEvent = event.nativeEvent as MouseEvent;
                      const composedPath = nativeEvent.composedPath?.() ?? [];
                      const clickedHeader = composedPath.some((node) => {
                        if (!(node instanceof Element)) return false;
                        return node.hasAttribute("data-title");
                      });
                      if (!clickedHeader) return;
                      openDiffFileInEditor(filePath);
                    }}
                  >
                    <FileDiff
                      fileDiff={fileDiff}
                      options={{
                        diffStyle: diffRenderMode === "split" ? "split" : "unified",
                        lineDiffType: "none",
                        theme: resolveDiffThemeName(resolvedTheme),
                        themeType: resolvedTheme as DiffThemeType,
                        unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
                      }}
                    />
                  </div>
                );
              })}
            </Virtualizer>
          ) : (
            <div className="diff-raw-surface h-full overflow-auto p-2">
              <div className="space-y-2">
                <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                <pre className="max-h-[72vh] overflow-auto rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90">
                  {renderablePatch.text}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </DiffPanelShell>
  );
}
