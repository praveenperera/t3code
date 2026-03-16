import type { ExecutionTargetId, ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Badge } from "../ui/badge";
import { SidebarTrigger } from "../ui/sidebar";
import { gitBranchesQueryOptions, gitStatusQueryOptions } from "../../lib/gitReactQuery";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { type ThreadSessionTab } from "../../threadTabs";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadHeaderTabs } from "./ThreadHeaderTabs";
import { GitHubIcon } from "../Icons";

const EMPTY_AVAILABLE_EDITORS: readonly [] = [];
const EMPTY_KEYBINDINGS: readonly [] = [];

interface ThreadPageHeaderProps {
  activeProjectName: string | undefined;
  activeTab: ThreadSessionTab;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  children?: ReactNode;
  gitCwd?: string | null;
  isGitRepo?: boolean;
  openInCwd?: string | null;
  targetId?: ExecutionTargetId | null;
}

export function ThreadPageHeader({
  activeProjectName,
  activeTab,
  activeThreadId,
  activeThreadTitle,
  children,
  gitCwd,
  isGitRepo,
  openInCwd,
  targetId,
}: ThreadPageHeaderProps) {
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const { data: branchList } = useQuery(
    gitBranchesQueryOptions({ cwd: gitCwd ?? null, targetId: targetId ?? null }),
  );
  const { data: gitStatus } = useQuery(
    gitStatusQueryOptions({ cwd: gitCwd ?? null, targetId: targetId ?? null }),
  );
  const openPrUrl = gitStatus?.pr?.state === "open" ? gitStatus.pr.url : null;
  const githubTargetUrl = openPrUrl ?? branchList?.originWebUrl ?? null;
  const githubTargetLabel = openPrUrl ? "Open PR" : "GitHub";
  const availableEditors = serverConfigQuery.data?.availableEditors ?? EMPTY_AVAILABLE_EDITORS;
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const mobileMenuActions = githubTargetUrl
    ? [
        {
          icon: GitHubIcon,
          id: "open-github",
          label: githubTargetLabel,
          onSelect: () => window.open(githubTargetUrl, "_blank", "noopener,noreferrer"),
        },
      ]
    : [];

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 items-center gap-2 overflow-hidden sm:flex-1 sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0" />
        <h2
          className="min-w-0 shrink truncate text-sm font-medium text-foreground"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        {activeProjectName && (
          <Badge variant="outline" className="hidden min-w-0 shrink truncate sm:inline-flex">
            {activeProjectName}
          </Badge>
        )}
        {activeProjectName && isGitRepo === false && (
          <Badge
            variant="outline"
            className="hidden shrink-0 text-[10px] text-amber-700 sm:inline-flex"
          >
            No Git
          </Badge>
        )}
      </div>
      <div className="hidden min-w-0 justify-center sm:flex">
        <ThreadHeaderTabs activeTab={activeTab} mode="inline" threadId={activeThreadId} />
      </div>
      <div className="@container/header-actions flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:gap-2 @sm/header-actions:gap-3">
        {(openInCwd || githubTargetUrl) && (
          <div className="hidden sm:block">
            <OpenInPicker
              availableEditors={availableEditors}
              githubTargetLabel={githubTargetLabel}
              githubTargetUrl={githubTargetUrl}
              keybindings={keybindings}
              openInCwd={openInCwd ?? null}
            />
          </div>
        )}
        {children}
        <div className="sm:hidden">
          <ThreadHeaderTabs
            activeTab={activeTab}
            extraActions={mobileMenuActions}
            mode="menu"
            threadId={activeThreadId}
          />
        </div>
      </div>
    </div>
  );
}
