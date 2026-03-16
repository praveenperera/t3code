import { ThreadId } from "@t3tools/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { Suspense, useEffect } from "react";

import DiffPanel from "../components/DiffPanel";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
} from "../components/DiffPanelShell";
import { useComposerDraftStore } from "../composerDraftStore";
import { type DiffRouteSearch, parseDiffRouteSearch } from "../diffRouteSearch";
import { APP_VIEWPORT_CSS_HEIGHT } from "../lib/viewport";
import { useStore } from "../store";
import { SidebarInset } from "~/components/ui/sidebar";

function FullDiffLoadingFallback() {
  return (
    <DiffPanelShell mode="sheet" header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading full diff..." />
    </DiffPanelShell>
  );
}

function FullDiffRouteView() {
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const threadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  const draftThreadExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const routeThreadExists = threadExists || draftThreadExists;

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
    }
  }, [navigate, routeThreadExists, threadsHydrated]);

  if (!threadsHydrated || !routeThreadExists) {
    return null;
  }

  return (
    <SidebarInset
      className="min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground"
      style={{ height: APP_VIEWPORT_CSS_HEIGHT }}
    >
      <DiffWorkerPoolProvider>
        <Suspense fallback={<FullDiffLoadingFallback />}>
          <DiffPanel
            mode="sheet"
            variant="full"
            onCloseDiff={() => {
              void navigate({
                to: "/$threadId",
                params: { threadId },
                replace: true,
                search: {
                  diff: "1",
                  ...(search.diffScope ? { diffScope: search.diffScope } : {}),
                  ...(search.diffTurnId ? { diffTurnId: search.diffTurnId } : {}),
                  ...(search.diffFilePath ? { diffFilePath: search.diffFilePath } : {}),
                },
              });
            }}
          />
        </Suspense>
      </DiffWorkerPoolProvider>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$threadId/diff")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [retainSearchParams<DiffRouteSearch>(["diffScope", "diffTurnId", "diffFilePath"])],
  },
  component: FullDiffRouteView,
});
