import {
  DEFAULT_RUNTIME_MODE,
  LOCAL_EXECUTION_TARGET_ID,
  type ExecutionTargetId,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback } from "react";
import { inferProviderForModel } from "@t3tools/shared/model";
import {
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newThreadId } from "../lib/utils";
import { useStore } from "../store";

export function useHandleNewThread() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const stickyModel = useComposerDraftStore((store) => store.stickyModel);
  const stickyModelOptions = useComposerDraftStore((store) => store.stickyModelOptions);
  const navigate = useNavigate();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const activeDraftThread = useComposerDraftStore((store) =>
    routeThreadId ? (store.draftThreadsByThreadId[routeThreadId] ?? null) : null,
  );

  const activeThread = routeThreadId
    ? threads.find((thread) => thread.id === routeThreadId)
    : undefined;

  const handleNewThread = useCallback(
    (
      projectId: ProjectId,
      options?: {
        targetId?: ExecutionTargetId;
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ): Promise<void> => {
      const {
        clearProjectDraftThreadId,
        getDraftThread,
        getDraftThreadByProjectId,
        setModel,
        setModelOptions,
        setProvider,
        setDraftThreadContext,
        setProjectDraftThreadId,
      } = useComposerDraftStore.getState();
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const hasTargetIdOption = options?.targetId !== undefined;
      const projectTargetId =
        options?.targetId ??
        projects.find((project) => project.id === projectId)?.targetId ??
        LOCAL_EXECUTION_TARGET_ID;
      const storedDraftThread = getDraftThreadByProjectId(projectId);
      const latestActiveDraftThread: DraftThreadState | null = routeThreadId
        ? getDraftThread(routeThreadId)
        : null;
      if (storedDraftThread) {
        return (async () => {
          const shouldSyncStoredDraftTarget = storedDraftThread.targetId !== projectTargetId;
          if (
            hasBranchOption ||
            hasWorktreePathOption ||
            hasEnvModeOption ||
            hasTargetIdOption ||
            shouldSyncStoredDraftTarget
          ) {
            setDraftThreadContext(storedDraftThread.threadId, {
              ...(hasTargetIdOption || shouldSyncStoredDraftTarget
                ? { targetId: projectTargetId }
                : {}),
              ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
              ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
              ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
            });
          }
          setProjectDraftThreadId(projectId, storedDraftThread.threadId);
          if (routeThreadId === storedDraftThread.threadId) {
            return;
          }
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        })();
      }

      clearProjectDraftThreadId(projectId);

      if (
        latestActiveDraftThread &&
        routeThreadId &&
        latestActiveDraftThread.projectId === projectId
      ) {
        const shouldSyncActiveDraftTarget = latestActiveDraftThread.targetId !== projectTargetId;
        if (
          hasBranchOption ||
          hasWorktreePathOption ||
          hasEnvModeOption ||
          hasTargetIdOption ||
          shouldSyncActiveDraftTarget
        ) {
          setDraftThreadContext(routeThreadId, {
            ...(hasTargetIdOption || shouldSyncActiveDraftTarget
              ? { targetId: projectTargetId }
              : {}),
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        setProjectDraftThreadId(projectId, routeThreadId);
        return Promise.resolve();
      }

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        setProjectDraftThreadId(projectId, threadId, {
          createdAt,
          targetId: projectTargetId,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: options?.envMode ?? "local",
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });
        if (stickyModel) {
          setProvider(threadId, inferProviderForModel(stickyModel));
          setModel(threadId, stickyModel);
        }
        if (Object.keys(stickyModelOptions).length > 0) {
          setModelOptions(threadId, stickyModelOptions);
        }

        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
      })();
    },
    [navigate, projects, routeThreadId, stickyModel, stickyModelOptions],
  );

  return {
    activeDraftThread,
    activeThread,
    handleNewThread,
    projects,
    routeThreadId,
  };
}
