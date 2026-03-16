import type { FileDiffMetadata } from "@pierre/diffs/react";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon, PanelLeftCloseIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { resolveFileDiffPath } from "./diffRendering";
import { Button } from "../ui/button";

export type DiffFileTreeNode =
  | {
      kind: "directory";
      id: string;
      name: string;
      path: string;
      children: DiffFileTreeNode[];
    }
  | {
      kind: "file";
      id: string;
      name: string;
      path: string;
      fileDiff: FileDiffMetadata;
    };

type DiffFileTreeFileNode = Extract<DiffFileTreeNode, { kind: "file" }>;
type MutableDiffFileTreeDirectoryNode = {
  kind: "directory";
  id: string;
  name: string;
  path: string;
  children: MutableDiffFileTreeNode[];
  childDirectoryByName: Map<string, MutableDiffFileTreeDirectoryNode>;
};
type MutableDiffFileTreeNode = MutableDiffFileTreeDirectoryNode | DiffFileTreeFileNode;

function finalizeDiffFileTreeChildren(
  children: readonly MutableDiffFileTreeNode[],
): DiffFileTreeNode[] {
  return children
    .map(
      (child): DiffFileTreeNode =>
        child.kind === "directory"
          ? {
              kind: "directory",
              id: child.id,
              name: child.name,
              path: child.path,
              children: finalizeDiffFileTreeChildren(child.children),
            }
          : child,
    )
    .toSorted((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });
}

export function buildDiffFileTree(files: readonly FileDiffMetadata[]): DiffFileTreeNode[] {
  const root: MutableDiffFileTreeDirectoryNode = {
    kind: "directory",
    id: "__root__",
    name: "",
    path: "",
    children: [],
    childDirectoryByName: new Map(),
  };

  for (const fileDiff of files) {
    const filePath = resolveFileDiffPath(fileDiff);
    const pathSegments = filePath.split("/").filter(Boolean);
    if (pathSegments.length === 0) {
      continue;
    }

    let directoryCursor = root;
    for (let index = 0; index < pathSegments.length - 1; index += 1) {
      const segment = pathSegments[index];
      if (!segment) {
        continue;
      }
      const directoryPath = pathSegments.slice(0, index + 1).join("/");
      let nextDirectory = directoryCursor.childDirectoryByName.get(segment);
      if (!nextDirectory) {
        nextDirectory = {
          kind: "directory",
          id: `dir:${directoryPath}`,
          name: segment,
          path: directoryPath,
          children: [],
          childDirectoryByName: new Map(),
        };
        directoryCursor.childDirectoryByName.set(segment, nextDirectory);
        directoryCursor.children.push(nextDirectory);
      }
      directoryCursor = nextDirectory;
    }

    const fileName = pathSegments[pathSegments.length - 1] ?? filePath;
    directoryCursor.children.push({
      kind: "file",
      id: `file:${filePath}`,
      name: fileName,
      path: filePath,
      fileDiff,
    });
  }

  return finalizeDiffFileTreeChildren(root.children);
}

export function collectExpandedDirectoryPaths(nodes: readonly DiffFileTreeNode[]): string[] {
  const directoryPaths: string[] = [];

  const visit = (entries: readonly DiffFileTreeNode[]) => {
    for (const entry of entries) {
      if (entry.kind !== "directory") {
        continue;
      }
      directoryPaths.push(entry.path);
      visit(entry.children);
    }
  };

  visit(nodes);
  return directoryPaths;
}

export function DiffFileTree(props: {
  activeFilePath: string | null;
  expandedDirectories: Record<string, boolean>;
  nodes: readonly DiffFileTreeNode[];
  onOpenInEditor: (filePath: string) => void;
  onSelectFile: (filePath: string) => void;
  onToggleDirectory: (directoryPath: string) => void;
  onToggleVisibility?: () => void;
  showVisibilityToggle?: boolean;
}) {
  return (
    <div className="diff-file-tree-scroll flex min-h-0 flex-col border-b border-border/70 bg-card/35 md:w-64 md:shrink-0 md:border-b-0 md:border-r">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <p className="text-[11px] font-medium tracking-[0.14em] text-muted-foreground/70 uppercase">
          Changed files
        </p>
        {props.showVisibilityToggle && props.onToggleVisibility && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            aria-label="Hide files"
            onClick={props.onToggleVisibility}
          >
            <PanelLeftCloseIcon className="size-4" />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        <div className="space-y-0.5">
          {props.nodes.map((node) => (
            <DiffFileTreeNodeRow
              key={node.id}
              activeFilePath={props.activeFilePath}
              depth={0}
              expandedDirectories={props.expandedDirectories}
              node={node}
              onOpenInEditor={props.onOpenInEditor}
              onSelectFile={props.onSelectFile}
              onToggleDirectory={props.onToggleDirectory}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DiffFileTreeNodeRow(props: {
  activeFilePath: string | null;
  depth: number;
  expandedDirectories: Record<string, boolean>;
  node: DiffFileTreeNode;
  onOpenInEditor: (filePath: string) => void;
  onSelectFile: (filePath: string) => void;
  onToggleDirectory: (directoryPath: string) => void;
}) {
  const {
    activeFilePath,
    depth,
    expandedDirectories,
    node,
    onOpenInEditor,
    onSelectFile,
    onToggleDirectory,
  } = props;

  if (node.kind === "directory") {
    const isExpanded = expandedDirectories[node.path] ?? true;
    return (
      <div>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground/80 transition-colors hover:bg-accent/60 hover:text-foreground"
          onClick={() => onToggleDirectory(node.path)}
          style={{ paddingLeft: `${depth * 0.75 + 0.5}rem` }}
        >
          <ChevronRightIcon
            className={cn("size-3.5 shrink-0 transition-transform", isExpanded && "rotate-90")}
          />
          {isExpanded ? (
            <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground/80" />
          ) : (
            <FolderIcon className="size-4 shrink-0 text-muted-foreground/80" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {isExpanded && (
          <div className="space-y-0.5">
            {node.children.map((child) => (
              <DiffFileTreeNodeRow
                key={child.id}
                activeFilePath={activeFilePath}
                depth={depth + 1}
                expandedDirectories={expandedDirectories}
                node={child}
                onOpenInEditor={onOpenInEditor}
                onSelectFile={onSelectFile}
                onToggleDirectory={onToggleDirectory}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isActive = node.path === activeFilePath;
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        isActive
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground/80 hover:bg-accent/60 hover:text-foreground",
      )}
      title={node.path}
      onClick={() => onSelectFile(node.path)}
      onDoubleClick={() => onOpenInEditor(node.path)}
      style={{ paddingLeft: `${depth * 0.75 + 1.75}rem` }}
    >
      <span className="truncate">{node.name}</span>
    </button>
  );
}
