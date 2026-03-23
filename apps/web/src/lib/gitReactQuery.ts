import type { ExecutionTargetId, GitStackedAction } from "@t3tools/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";

const GIT_STATUS_STALE_TIME_MS = 5_000;
const GIT_STATUS_REFETCH_INTERVAL_MS = 15_000;
const GIT_BRANCHES_STALE_TIME_MS = 15_000;
const GIT_BRANCHES_REFETCH_INTERVAL_MS = 60_000;

export const gitQueryKeys = {
  all: ["git"] as const,
  status: (cwd: string | null, targetId: ExecutionTargetId | null) =>
    ["git", "status", cwd, targetId] as const,
  workingTreeDiff: (cwd: string | null, targetId: ExecutionTargetId | null) =>
    ["git", "working-tree-diff", cwd, targetId] as const,
  branches: (cwd: string | null, targetId: ExecutionTargetId | null) =>
    ["git", "branches", cwd, targetId] as const,
};

export const gitMutationKeys = {
  init: (cwd: string | null, targetId: ExecutionTargetId | null) =>
    ["git", "mutation", "init", cwd, targetId] as const,
  checkout: (cwd: string | null, targetId: ExecutionTargetId | null) =>
    ["git", "mutation", "checkout", cwd, targetId] as const,
  runStackedAction: (cwd: string | null, targetId: ExecutionTargetId | null) =>
    ["git", "mutation", "run-stacked-action", cwd, targetId] as const,
  pull: (cwd: string | null, targetId: ExecutionTargetId | null) =>
    ["git", "mutation", "pull", cwd, targetId] as const,
  preparePullRequestThread: (cwd: string | null, targetId: ExecutionTargetId | null) =>
    ["git", "mutation", "prepare-pull-request-thread", cwd, targetId] as const,
};

export function invalidateGitQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
}

export function gitStatusQueryOptions(input: {
  cwd: string | null;
  targetId?: ExecutionTargetId | null;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.status(input.cwd, input.targetId ?? null),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git status is unavailable.");
      return api.git.status({
        cwd: input.cwd,
        ...(input.targetId ? { targetId: input.targetId } : {}),
      });
    },
    enabled: input.cwd !== null,
    staleTime: GIT_STATUS_STALE_TIME_MS,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: GIT_STATUS_REFETCH_INTERVAL_MS,
  });
}

export function gitWorkingTreeDiffQueryOptions(input: {
  cwd: string | null;
  targetId?: ExecutionTargetId | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.workingTreeDiff(input.cwd, input.targetId ?? null),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git working tree diff is unavailable.");
      return api.git.workingTreeDiff({
        cwd: input.cwd,
        ...(input.targetId ? { targetId: input.targetId } : {}),
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: GIT_STATUS_STALE_TIME_MS,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: GIT_STATUS_REFETCH_INTERVAL_MS,
  });
}

export function gitBranchesQueryOptions(input: {
  cwd: string | null;
  targetId?: ExecutionTargetId | null;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.branches(input.cwd, input.targetId ?? null),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git branches are unavailable.");
      return api.git.listBranches({
        cwd: input.cwd,
        ...(input.targetId ? { targetId: input.targetId } : {}),
      });
    },
    enabled: input.cwd !== null,
    staleTime: GIT_BRANCHES_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: GIT_BRANCHES_REFETCH_INTERVAL_MS,
  });
}

export function gitResolvePullRequestQueryOptions(input: {
  cwd: string | null;
  targetId?: ExecutionTargetId | null;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: ["git", "pull-request", input.cwd, input.targetId ?? null, input.reference] as const,
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.reference) {
        throw new Error("Pull request lookup is unavailable.");
      }
      return api.git.resolvePullRequest({
        cwd: input.cwd,
        ...(input.targetId ? { targetId: input.targetId } : {}),
        reference: input.reference,
      });
    },
    enabled: input.cwd !== null && input.reference !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function gitInitMutationOptions(input: {
  cwd: string | null;
  targetId?: ExecutionTargetId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.init(input.cwd, input.targetId ?? null),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git init is unavailable.");
      return api.git.init({
        cwd: input.cwd,
        ...(input.targetId ? { targetId: input.targetId } : {}),
      });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitCheckoutMutationOptions(input: {
  cwd: string | null;
  targetId?: ExecutionTargetId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.checkout(input.cwd, input.targetId ?? null),
    mutationFn: async (branch: string) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git checkout is unavailable.");
      return api.git.checkout({
        cwd: input.cwd,
        ...(input.targetId ? { targetId: input.targetId } : {}),
        branch,
      });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitRunStackedActionMutationOptions(input: {
  cwd: string | null;
  targetId?: ExecutionTargetId | null;
  queryClient: QueryClient;
  model?: string | null;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.runStackedAction(input.cwd, input.targetId ?? null),
    mutationFn: async ({
      action,
      commitMessage,
      featureBranch,
      filePaths,
    }: {
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
    }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git action is unavailable.");
      return api.git.runStackedAction({
        cwd: input.cwd,
        ...(input.targetId ? { targetId: input.targetId } : {}),
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        ...(input.model ? { model: input.model } : {}),
      });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitPullMutationOptions(input: {
  cwd: string | null;
  targetId?: ExecutionTargetId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.pull(input.cwd, input.targetId ?? null),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git pull is unavailable.");
      return api.git.pull({
        cwd: input.cwd,
        ...(input.targetId ? { targetId: input.targetId } : {}),
      });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitCreateWorktreeMutationOptions(input: {
  targetId?: ExecutionTargetId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationFn: async ({
      cwd,
      branch,
      newBranch,
      path,
      targetId,
    }: {
      cwd: string;
      branch: string;
      newBranch: string;
      path?: string | null;
      targetId?: ExecutionTargetId | null;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree creation is unavailable.");
      const resolvedTargetId = targetId ?? input.targetId ?? undefined;
      return api.git.createWorktree({
        cwd,
        ...(resolvedTargetId ? { targetId: resolvedTargetId } : {}),
        branch,
        newBranch,
        path: path ?? null,
      });
    },
    mutationKey: ["git", "mutation", "create-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitRemoveWorktreeMutationOptions(input: {
  targetId?: ExecutionTargetId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationFn: async ({
      cwd,
      path,
      force,
      targetId,
    }: {
      cwd: string;
      path: string;
      force?: boolean;
      targetId?: ExecutionTargetId | null;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree removal is unavailable.");
      const resolvedTargetId = targetId ?? input.targetId ?? undefined;
      return api.git.removeWorktree({
        cwd,
        ...(resolvedTargetId ? { targetId: resolvedTargetId } : {}),
        path,
        force,
      });
    },
    mutationKey: ["git", "mutation", "remove-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitPreparePullRequestThreadMutationOptions(input: {
  cwd: string | null;
  targetId?: ExecutionTargetId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationFn: async ({ reference, mode }: { reference: string; mode: "local" | "worktree" }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Pull request thread preparation is unavailable.");
      return api.git.preparePullRequestThread({
        cwd: input.cwd,
        ...(input.targetId ? { targetId: input.targetId } : {}),
        reference,
        mode,
      });
    },
    mutationKey: gitMutationKeys.preparePullRequestThread(input.cwd, input.targetId ?? null),
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}
