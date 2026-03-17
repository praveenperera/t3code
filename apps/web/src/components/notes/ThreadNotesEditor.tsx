import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { $createCodeNode, $isCodeNode, CodeHighlightNode, CodeNode } from "@lexical/code";
import {
  getCodeLanguageOptions,
  registerCodeHighlighting,
  ShikiTokenizer,
} from "@lexical/code-shiki";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import {
  INSERT_CHECK_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  ListNode,
  REMOVE_LIST_COMMAND,
} from "@lexical/list";
import { $createHeadingNode, $createQuoteNode, HeadingNode, QuoteNode } from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import {
  BoldIcon,
  ChevronDownIcon,
  Code2Icon,
  ListChecksIcon,
  MinusIcon,
  Redo2Icon,
  Heading2Icon,
  ItalicIcon,
  PlusIcon,
  TextQuoteIcon,
  TypeIcon,
  Undo2Icon,
} from "lucide-react";
import {
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  $nodesOfType,
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import { memo, useCallback, useEffect, useState, type ReactNode } from "react";

import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useTheme } from "../../hooks/useTheme";
import { readUiScaleFromDocument, rootFontSizePxForUiScale } from "../../lib/uiScale";
import { MobileCheckListTapPlugin } from "./MobileCheckListTapPlugin";
import { resolveThreadNotesInitialEditorState } from "./threadNotesEditorState";
import { cn } from "~/lib/utils";

const THREAD_NOTES_EDITOR_NAMESPACE = "t3tools-thread-notes";
const TOUCH_VIEWPORT_MEDIA_QUERY = "(pointer: coarse), (hover: none)";
const LIGHT_CODE_THEME = "github-light";
const DARK_CODE_THEME = "github-dark";

type NotesBlockType =
  | "paragraph"
  | "heading2"
  | "heading3"
  | "heading4"
  | "quote"
  | "code"
  | "bullet"
  | "checklist";
type NotesStructuredBlockType = Extract<
  NotesBlockType,
  "paragraph" | "heading2" | "heading3" | "heading4" | "quote" | "code"
>;

interface NotesToolbarState {
  blockType: NotesBlockType;
  canRedo: boolean;
  canUndo: boolean;
  codeLanguage: string;
  isBold: boolean;
  isItalic: boolean;
}

type NotesFontFamily = "sans" | "serif" | "mono";

const DEFAULT_TOOLBAR_STATE: NotesToolbarState = {
  blockType: "paragraph",
  canRedo: false,
  canUndo: false,
  codeLanguage: "javascript",
  isBold: false,
  isItalic: false,
};

const NOTES_FONT_FAMILIES: Record<NotesFontFamily, string> = {
  mono: '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
  sans: '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  serif: '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif',
};

const NOTES_CODE_LANGUAGE_OPTIONS = getCodeLanguageOptions().map(([value, label]) => ({
  label,
  value,
}));

const notesTheme: NonNullable<InitialConfigType["theme"]> = {
  code: "my-4 block overflow-x-auto whitespace-pre-wrap rounded-xl border border-border/80 bg-muted/45 px-4 py-3 font-mono text-[0.92em] leading-7 text-foreground [tab-size:2]",
  codeHighlight: {
    atrule: "text-sky-700 dark:text-sky-300",
    attr: "text-violet-700 dark:text-violet-300",
    boolean: "text-amber-700 dark:text-amber-300",
    builtin: "text-cyan-700 dark:text-cyan-300",
    cdata: "text-muted-foreground",
    char: "text-emerald-700 dark:text-emerald-300",
    class: "text-orange-700 dark:text-orange-300",
    "class-name": "text-orange-700 dark:text-orange-300",
    comment: "text-muted-foreground italic",
    constant: "text-amber-700 dark:text-amber-300",
    deleted: "text-rose-700 dark:text-rose-300",
    doctype: "text-muted-foreground",
    entity: "text-red-700 dark:text-red-300",
    function: "text-blue-700 dark:text-blue-300",
    important: "text-fuchsia-700 dark:text-fuchsia-300 font-medium",
    inserted: "text-emerald-700 dark:text-emerald-300",
    keyword: "text-fuchsia-700 dark:text-fuchsia-300 font-medium",
    namespace: "text-foreground",
    number: "text-amber-700 dark:text-amber-300",
    operator: "text-slate-700 dark:text-slate-300",
    prolog: "text-muted-foreground",
    property: "text-cyan-700 dark:text-cyan-300",
    punctuation: "text-muted-foreground",
    regex: "text-rose-700 dark:text-rose-300",
    selector: "text-cyan-700 dark:text-cyan-300",
    string: "text-emerald-700 dark:text-emerald-300",
    symbol: "text-violet-700 dark:text-violet-300",
    tag: "text-blue-700 dark:text-blue-300",
    url: "text-blue-700 underline decoration-blue-500/50 underline-offset-2 dark:text-blue-300",
    variable: "text-orange-700 dark:text-orange-300",
  },
  heading: {
    h2: "mt-3 mb-3 text-[2rem] leading-tight font-semibold tracking-tight text-foreground",
    h3: "mt-3 mb-2 text-[1.55rem] leading-tight font-semibold tracking-tight text-foreground",
    h4: "mt-3 mb-2 text-[1.2rem] leading-tight font-semibold tracking-tight text-foreground",
  },
  list: {
    checklist: "my-3 ml-0 list-none space-y-1",
    listitem: "my-1",
    listitemChecked:
      "relative ml-0 list-none pl-7 text-muted-foreground line-through before:absolute before:top-[0.32rem] before:left-0 before:flex before:size-4 before:items-center before:justify-center before:rounded-[4px] before:border before:border-primary before:bg-primary before:text-[11px] before:text-primary-foreground before:shadow-[0_0_0_1px_var(--color-primary)] before:content-['✓'] dark:before:border-primary dark:before:bg-primary dark:before:text-primary-foreground dark:before:shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-background)_20%,var(--color-primary))]",
    listitemUnchecked:
      "relative ml-0 list-none pl-7 before:absolute before:top-[0.32rem] before:left-0 before:size-4 before:rounded-[4px] before:border before:border-foreground/35 before:bg-background before:shadow-[0_0_0_1px_var(--color-border)] before:content-[''] dark:before:border-white/70 dark:before:bg-neutral-950 dark:before:shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-white)_22%,transparent)]",
    nested: {
      listitem: "ml-4",
    },
    ol: "my-3 ml-5 list-decimal space-y-1",
    ul: "my-3 ml-5 list-disc space-y-1",
  },
  ltr: "text-left",
  paragraph: "my-2 text-foreground",
  quote: "my-4 border-l-3 border-border pl-4 italic text-muted-foreground",
  rtl: "text-right",
  text: {
    bold: "font-semibold text-foreground",
    code: "rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-foreground",
    italic: "italic",
  },
};

function applyStructuredBlockType(editor: LexicalEditor, kind: NotesStructuredBlockType) {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      return;
    }
    if (kind === "heading2") {
      $setBlocksType(selection, () => $createHeadingNode("h2"));
      return;
    }
    if (kind === "heading3") {
      $setBlocksType(selection, () => $createHeadingNode("h3"));
      return;
    }
    if (kind === "heading4") {
      $setBlocksType(selection, () => $createHeadingNode("h4"));
      return;
    }
    if (kind === "quote") {
      $setBlocksType(selection, () => $createQuoteNode());
      return;
    }
    if (kind === "code") {
      $setBlocksType(selection, () => $createCodeNode());
      return;
    }
    $setBlocksType(selection, () => $createParagraphNode());
  });
}

function getSelectedCodeNode(selection: ReturnType<typeof $getSelection>): CodeNode | null {
  if (!$isRangeSelection(selection)) {
    return null;
  }

  let currentNode: LexicalNode | null = selection.anchor.getNode();
  while (currentNode) {
    if ($isCodeNode(currentNode)) {
      return currentNode;
    }
    currentNode = currentNode.getParent();
  }

  const topLevelNode = selection.anchor.getNode().getTopLevelElementOrThrow();
  return $isCodeNode(topLevelNode) ? topLevelNode : null;
}

function setSelectedCodeLanguage(editor: LexicalEditor, language: string) {
  editor.update(() => {
    const selection = $getSelection();
    const codeNode = getSelectedCodeNode(selection);
    if (codeNode === null) {
      return;
    }
    codeNode.setLanguage(language);
  });
}

function readDefaultNotesFontSizePx(): number {
  if (typeof document === "undefined") {
    return rootFontSizePxForUiScale("medium");
  }

  return rootFontSizePxForUiScale(readUiScaleFromDocument());
}

function SelectionTextPlugin(props: { onSelectionTextChange: (selectionText: string) => void }) {
  const [editor] = useLexicalComposerContext();

  const publishSelectionText = useCallback(() => {
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      const selectionText =
        $isRangeSelection(selection) && !selection.isCollapsed()
          ? selection.getTextContent().trim()
          : "";
      props.onSelectionTextChange(selectionText);
    });
  }, [editor, props]);

  useEffect(() => {
    const unregisterSelection = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        publishSelectionText();
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    const unregisterUpdate = editor.registerUpdateListener(() => {
      publishSelectionText();
    });

    return () => {
      unregisterSelection();
      unregisterUpdate();
    };
  }, [editor, publishSelectionText]);

  return null;
}

function PersistEditorStatePlugin(props: { onChange: (serializedEditorState: string) => void }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState }) => {
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
        return;
      }

      props.onChange(JSON.stringify(editorState.toJSON()));
    });
  }, [editor, props]);

  return null;
}

function FloatingSelectionToolbarPlugin(props: { onSendSelectionToChat: () => void }) {
  const [editor] = useLexicalComposerContext();
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const updatePosition = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    const rootElement = editor.getRootElement();
    const domSelection = window.getSelection();
    if (
      !rootElement ||
      !domSelection ||
      domSelection.rangeCount === 0 ||
      domSelection.isCollapsed
    ) {
      setPosition(null);
      return;
    }

    const anchorNode = domSelection.anchorNode;
    if (!(anchorNode instanceof Node) || !rootElement.contains(anchorNode)) {
      setPosition(null);
      return;
    }

    const range = domSelection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setPosition(null);
      return;
    }

    setPosition({
      left: rect.left + rect.width / 2,
      top: Math.max(12, rect.top - 56),
    });
  }, [editor]);

  useEffect(() => {
    const unregisterSelection = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        updatePosition();
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    const unregisterUpdate = editor.registerUpdateListener(() => {
      updatePosition();
    });

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      unregisterSelection();
      unregisterUpdate();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [editor, updatePosition]);

  if (position === null) {
    return null;
  }

  return (
    <div
      className="fixed z-30 flex items-center gap-1 rounded-xl border border-border/80 bg-background/95 px-2 py-1.5 shadow-lg backdrop-blur"
      style={{
        left: position.left,
        top: position.top,
        transform: "translateX(-50%)",
      }}
    >
      <ToolbarButton
        ariaLabel="Text"
        onClick={() => {
          applyStructuredBlockType(editor, "paragraph");
        }}
      >
        <TypeIcon className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        ariaLabel="Heading 2"
        onClick={() => {
          applyStructuredBlockType(editor, "heading2");
        }}
      >
        <Heading2Icon className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        ariaLabel="Heading 3"
        onClick={() => {
          applyStructuredBlockType(editor, "heading3");
        }}
      >
        <span className="font-semibold text-xs leading-none">H3</span>
      </ToolbarButton>
      <ToolbarButton
        ariaLabel="Heading 4"
        onClick={() => {
          applyStructuredBlockType(editor, "heading4");
        }}
      >
        <span className="font-semibold text-xs leading-none">H4</span>
      </ToolbarButton>
      <ToolbarButton
        ariaLabel="Quote"
        onClick={() => {
          applyStructuredBlockType(editor, "quote");
        }}
      >
        <TextQuoteIcon className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        ariaLabel="Code"
        onClick={() => {
          applyStructuredBlockType(editor, "code");
        }}
      >
        <Code2Icon className="size-3.5" />
        <span>Code</span>
      </ToolbarButton>
      <Separator className="mx-0.5 h-6 bg-border/80" orientation="vertical" />
      <ToolbarButton
        ariaLabel="Bold"
        onClick={() => {
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold");
        }}
      >
        <BoldIcon className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        ariaLabel="Italic"
        onClick={() => {
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic");
        }}
      >
        <ItalicIcon className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        ariaLabel="Bulleted list"
        onClick={() => {
          editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
        }}
      >
        <ChevronDownIcon className="size-3.5 rotate-90" />
        <TypeIcon className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        ariaLabel="Checklist"
        onClick={() => {
          editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
        }}
      >
        <ListChecksIcon className="size-3.5" />
        <span>Checklist</span>
      </ToolbarButton>
      <ToolbarButton
        ariaLabel="Clear list"
        onClick={() => {
          editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
        }}
      >
        <span className="text-sm leading-none">T</span>
      </ToolbarButton>
      <Separator className="mx-0.5 h-6 bg-border/80" orientation="vertical" />
      <Button
        className="rounded-md px-3"
        size="xs"
        variant="default"
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={props.onSendSelectionToChat}
      >
        Send to AI
      </Button>
    </div>
  );
}

const ToolbarButton = memo(function ToolbarButton(props: {
  active?: boolean;
  ariaLabel: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      aria-label={props.ariaLabel}
      className={cn(
        "gap-1.5 border-transparent bg-transparent text-muted-foreground shadow-none before:hidden",
        "hover:bg-accent/70 hover:text-foreground",
        props.active && "border-border/80 bg-background text-foreground shadow-xs/5",
      )}
      disabled={props.disabled}
      size="xs"
      variant="ghost"
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
});

function ToolbarSelect(props: {
  items: ReadonlyArray<{ label: string; value: string }>;
  onValueChange: (value: string | null) => void;
  value: string;
}) {
  return (
    <Select value={props.value} onValueChange={props.onValueChange}>
      <SelectTrigger
        className="min-h-8 min-w-0 rounded-md border-transparent px-2.5 text-sm text-foreground shadow-none before:hidden hover:bg-accent/60 data-[popup-open]:bg-accent/70"
        size="xs"
        variant="ghost"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {props.items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function getSelectedBlockType(selection: ReturnType<typeof $getSelection>): NotesBlockType {
  if (!$isRangeSelection(selection)) {
    return "paragraph";
  }

  let currentNode: LexicalNode | null = selection.anchor.getNode();
  while (currentNode) {
    if ($isCodeNode(currentNode)) {
      return "code";
    }
    if (currentNode instanceof ListNode) {
      return currentNode.getListType() === "check" ? "checklist" : "bullet";
    }
    currentNode = currentNode.getParent();
  }

  const topLevelNode = selection.anchor.getNode().getTopLevelElementOrThrow();
  if ($isCodeNode(topLevelNode)) {
    return "code";
  }
  switch (topLevelNode.getType()) {
    case "heading":
      return topLevelNode instanceof HeadingNode
        ? topLevelNode.getTag() === "h4"
          ? "heading4"
          : topLevelNode.getTag() === "h3"
            ? "heading3"
            : "heading2"
        : "heading2";
    case "quote":
      return "quote";
    default:
      return "paragraph";
  }
}

function useNotesToolbarModel() {
  const [editor] = useLexicalComposerContext();
  const [toolbarState, setToolbarState] = useState(DEFAULT_TOOLBAR_STATE);

  const syncToolbarState = useCallback(() => {
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      const selectedCodeNode = getSelectedCodeNode(selection);
      const nextState: NotesToolbarState = $isRangeSelection(selection)
        ? {
            blockType: getSelectedBlockType(selection),
            canRedo: toolbarState.canRedo,
            canUndo: toolbarState.canUndo,
            codeLanguage: selectedCodeNode?.getLanguage() ?? "javascript",
            isBold: selection.hasFormat("bold"),
            isItalic: selection.hasFormat("italic"),
          }
        : {
            blockType: "paragraph",
            canRedo: toolbarState.canRedo,
            canUndo: toolbarState.canUndo,
            codeLanguage: "javascript",
            isBold: false,
            isItalic: false,
          };

      setToolbarState((currentState) =>
        currentState.blockType === nextState.blockType &&
        currentState.canRedo === nextState.canRedo &&
        currentState.canUndo === nextState.canUndo &&
        currentState.codeLanguage === nextState.codeLanguage &&
        currentState.isBold === nextState.isBold &&
        currentState.isItalic === nextState.isItalic
          ? currentState
          : nextState,
      );
    });
  }, [editor, toolbarState.canRedo, toolbarState.canUndo]);

  useEffect(() => {
    const unregisterUpdate = editor.registerUpdateListener(() => {
      syncToolbarState();
    });
    const unregisterSelection = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        syncToolbarState();
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    const unregisterCanUndo = editor.registerCommand(
      CAN_UNDO_COMMAND,
      (canUndo) => {
        setToolbarState((currentState) =>
          currentState.canUndo === canUndo ? currentState : { ...currentState, canUndo },
        );
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    const unregisterCanRedo = editor.registerCommand(
      CAN_REDO_COMMAND,
      (canRedo) => {
        setToolbarState((currentState) =>
          currentState.canRedo === canRedo ? currentState : { ...currentState, canRedo },
        );
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      unregisterUpdate();
      unregisterSelection();
      unregisterCanUndo();
      unregisterCanRedo();
    };
  }, [editor, syncToolbarState]);

  const setBlockKind = useCallback(
    (kind: NotesStructuredBlockType) => {
      applyStructuredBlockType(editor, kind);
    },
    [editor],
  );

  const setBlockType = useCallback(
    (nextBlockType: string | null) => {
      if (
        nextBlockType !== "paragraph" &&
        nextBlockType !== "heading2" &&
        nextBlockType !== "heading3" &&
        nextBlockType !== "heading4" &&
        nextBlockType !== "quote" &&
        nextBlockType !== "code" &&
        nextBlockType !== "bullet" &&
        nextBlockType !== "checklist"
      ) {
        return;
      }

      if (nextBlockType === "bullet") {
        editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
        return;
      }

      if (nextBlockType === "checklist") {
        editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
        return;
      }

      setBlockKind(nextBlockType);
    },
    [editor, setBlockKind],
  );

  const setCodeLanguage = useCallback(
    (nextValue: string | null) => {
      if (nextValue == null) {
        return;
      }

      setSelectedCodeLanguage(editor, nextValue);
    },
    [editor],
  );

  return {
    editor,
    setBlockKind,
    setBlockType,
    setCodeLanguage,
    toolbarState,
  };
}

function SelectionFormattingControls(props: {
  className?: string;
  compact?: boolean;
  onSendSelectionToChat?: () => void;
}) {
  const { editor, setBlockKind, setBlockType, setCodeLanguage, toolbarState } =
    useNotesToolbarModel();

  return (
    <div className={cn("flex min-w-max items-center gap-1 text-foreground", props.className)}>
      <ToolbarSelect
        items={[
          { label: "Text", value: "paragraph" },
          { label: "Heading 2", value: "heading2" },
          { label: "Heading 3", value: "heading3" },
          { label: "Heading 4", value: "heading4" },
          { label: "Quote", value: "quote" },
          { label: "Code", value: "code" },
          { label: "Bulleted List", value: "bullet" },
          { label: "Checklist", value: "checklist" },
        ]}
        value={toolbarState.blockType}
        onValueChange={setBlockType}
      />

      {toolbarState.blockType === "code" ? (
        <ToolbarSelect
          items={NOTES_CODE_LANGUAGE_OPTIONS}
          value={toolbarState.codeLanguage}
          onValueChange={setCodeLanguage}
        />
      ) : null}

      <Separator className="mx-0.5 h-6 bg-border/80" orientation="vertical" />

      <ToolbarButton
        active={toolbarState.isBold}
        ariaLabel="Bold"
        onClick={() => {
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold");
        }}
      >
        <BoldIcon className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={toolbarState.isItalic}
        ariaLabel="Italic"
        onClick={() => {
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic");
        }}
      >
        <ItalicIcon className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={toolbarState.blockType === "heading2"}
        ariaLabel="Heading 2"
        onClick={() => {
          setBlockKind("heading2");
        }}
      >
        <Heading2Icon className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={toolbarState.blockType === "heading3"}
        ariaLabel="Heading 3"
        onClick={() => {
          setBlockKind("heading3");
        }}
      >
        <span className="font-semibold text-xs leading-none">H3</span>
      </ToolbarButton>
      <ToolbarButton
        active={toolbarState.blockType === "heading4"}
        ariaLabel="Heading 4"
        onClick={() => {
          setBlockKind("heading4");
        }}
      >
        <span className="font-semibold text-xs leading-none">H4</span>
      </ToolbarButton>
      <ToolbarButton
        active={toolbarState.blockType === "quote"}
        ariaLabel="Quote"
        onClick={() => {
          setBlockKind("quote");
        }}
      >
        <TextQuoteIcon className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={toolbarState.blockType === "code"}
        ariaLabel="Code"
        onClick={() => {
          setBlockKind("code");
        }}
      >
        <Code2Icon className="size-3.5" />
        {props.compact ? null : <span>Code</span>}
      </ToolbarButton>
      <ToolbarButton
        active={toolbarState.blockType === "bullet"}
        ariaLabel="Bulleted list"
        onClick={() => {
          editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
        }}
      >
        <ChevronDownIcon className="size-3.5 rotate-90" />
        <TypeIcon className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={toolbarState.blockType === "checklist"}
        ariaLabel="Checklist"
        onClick={() => {
          editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
        }}
      >
        <ListChecksIcon className="size-3.5" />
        {props.compact ? null : <span>Checklist</span>}
      </ToolbarButton>
      <ToolbarButton
        ariaLabel="Clear list"
        onClick={() => {
          editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
        }}
      >
        <span className="text-sm leading-none">T</span>
      </ToolbarButton>

      {props.onSendSelectionToChat ? (
        <>
          <Separator className="mx-0.5 h-6 bg-border/80" orientation="vertical" />
          <Button
            className="rounded-md px-3"
            size="xs"
            variant="default"
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={props.onSendSelectionToChat}
          >
            Send to AI
          </Button>
        </>
      ) : null}
    </div>
  );
}

function NotesToolbar(props: {
  canSendSelection: boolean;
  fontFamily: NotesFontFamily;
  fontSize: number;
  onFontFamilyChange: (nextFontFamily: NotesFontFamily) => void;
  onFontSizeChange: (updater: (currentFontSize: number) => number) => void;
  onSendSelectionToChat: () => void;
}) {
  const { editor, setBlockKind, setBlockType, setCodeLanguage, toolbarState } =
    useNotesToolbarModel();

  return (
    <div className="sticky top-0 z-20 border-b border-border/80 bg-background/95 backdrop-blur">
      <div className="flex items-center gap-3 px-2 py-1.5 sm:px-3">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="flex min-w-max items-center text-foreground">
            <ToolbarButton
              ariaLabel="Undo"
              disabled={!toolbarState.canUndo}
              onClick={() => {
                editor.dispatchCommand(UNDO_COMMAND, undefined);
              }}
            >
              <Undo2Icon className="size-3.5" />
            </ToolbarButton>
            <ToolbarButton
              ariaLabel="Redo"
              disabled={!toolbarState.canRedo}
              onClick={() => {
                editor.dispatchCommand(REDO_COMMAND, undefined);
              }}
            >
              <Redo2Icon className="size-3.5" />
            </ToolbarButton>

            <Separator className="mx-1 h-6 bg-border/80" orientation="vertical" />

            <ToolbarSelect
              items={[
                { label: "Text", value: "paragraph" },
                { label: "Heading 2", value: "heading2" },
                { label: "Heading 3", value: "heading3" },
                { label: "Heading 4", value: "heading4" },
                { label: "Quote", value: "quote" },
                { label: "Code", value: "code" },
                { label: "Bulleted List", value: "bullet" },
                { label: "Checklist", value: "checklist" },
              ]}
              value={toolbarState.blockType}
              onValueChange={setBlockType}
            />

            {toolbarState.blockType === "code" ? (
              <>
                <Separator className="mx-1 h-6 bg-border/80" orientation="vertical" />

                <ToolbarSelect
                  items={NOTES_CODE_LANGUAGE_OPTIONS}
                  value={toolbarState.codeLanguage}
                  onValueChange={setCodeLanguage}
                />
              </>
            ) : null}

            <Separator className="mx-1 h-6 bg-border/80" orientation="vertical" />

            <ToolbarSelect
              items={[
                { label: "DM Sans", value: "sans" },
                { label: "Georgia", value: "serif" },
                { label: "Mono", value: "mono" },
              ]}
              value={props.fontFamily}
              onValueChange={(nextValue) => {
                if (nextValue !== "sans" && nextValue !== "serif" && nextValue !== "mono") {
                  return;
                }
                props.onFontFamilyChange(nextValue);
              }}
            />

            <Separator className="mx-1 h-6 bg-border/80" orientation="vertical" />

            <div className="flex items-center gap-0.5 rounded-md border border-border/80 px-1 py-0.5">
              <ToolbarButton
                ariaLabel="Decrease font size"
                onClick={() => {
                  props.onFontSizeChange((currentFontSize) => Math.max(13, currentFontSize - 1));
                }}
              >
                <MinusIcon className="size-3.5" />
              </ToolbarButton>
              <span className="min-w-8 text-center font-medium text-sm text-foreground">
                {props.fontSize}
              </span>
              <ToolbarButton
                ariaLabel="Increase font size"
                onClick={() => {
                  props.onFontSizeChange((currentFontSize) => Math.min(18, currentFontSize + 1));
                }}
              >
                <PlusIcon className="size-3.5" />
              </ToolbarButton>
            </div>

            <Separator className="mx-1 h-6 bg-border/80" orientation="vertical" />

            <ToolbarButton
              active={toolbarState.isBold}
              ariaLabel="Bold"
              onClick={() => {
                editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold");
              }}
            >
              <BoldIcon className="size-3.5" />
            </ToolbarButton>
            <ToolbarButton
              active={toolbarState.isItalic}
              ariaLabel="Italic"
              onClick={() => {
                editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic");
              }}
            >
              <ItalicIcon className="size-3.5" />
            </ToolbarButton>
            <ToolbarButton
              active={toolbarState.blockType === "heading2"}
              ariaLabel="Heading 2"
              onClick={() => {
                setBlockKind("heading2");
              }}
            >
              <Heading2Icon className="size-3.5" />
            </ToolbarButton>
            <ToolbarButton
              active={toolbarState.blockType === "heading3"}
              ariaLabel="Heading 3"
              onClick={() => {
                setBlockKind("heading3");
              }}
            >
              <span className="font-semibold text-xs leading-none">H3</span>
            </ToolbarButton>
            <ToolbarButton
              active={toolbarState.blockType === "heading4"}
              ariaLabel="Heading 4"
              onClick={() => {
                setBlockKind("heading4");
              }}
            >
              <span className="font-semibold text-xs leading-none">H4</span>
            </ToolbarButton>
            <ToolbarButton
              active={toolbarState.blockType === "quote"}
              ariaLabel="Quote"
              onClick={() => {
                setBlockKind("quote");
              }}
            >
              <TextQuoteIcon className="size-3.5" />
            </ToolbarButton>
            <ToolbarButton
              active={toolbarState.blockType === "code"}
              ariaLabel="Code"
              onClick={() => {
                setBlockKind("code");
              }}
            >
              <Code2Icon className="size-3.5" />
              <span>Code</span>
            </ToolbarButton>
            <ToolbarButton
              active={toolbarState.blockType === "bullet"}
              ariaLabel="Bulleted list"
              onClick={() => {
                editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
              }}
            >
              <ChevronDownIcon className="size-3.5 rotate-90" />
              <TypeIcon className="size-3.5" />
            </ToolbarButton>
            <ToolbarButton
              active={toolbarState.blockType === "checklist"}
              ariaLabel="Checklist"
              onClick={() => {
                editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
              }}
            >
              <ListChecksIcon className="size-3.5" />
              <span>Checklist</span>
            </ToolbarButton>
            <ToolbarButton
              ariaLabel="Clear list"
              onClick={() => {
                editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
              }}
            >
              <span className="text-sm leading-none">T</span>
            </ToolbarButton>

            <Separator className="mx-1 h-6 bg-border/80" orientation="vertical" />

            <Button
              disabled={!props.canSendSelection}
              className="rounded-md px-3"
              size="xs"
              variant="default"
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={props.onSendSelectionToChat}
            >
              Send to AI
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CodeHighlightingPlugin() {
  const [editor] = useLexicalComposerContext();
  const { resolvedTheme } = useTheme();
  const codeTheme = resolvedTheme === "dark" ? DARK_CODE_THEME : LIGHT_CODE_THEME;

  useEffect(() => {
    return registerCodeHighlighting(editor, {
      ...ShikiTokenizer,
      defaultTheme: codeTheme,
    });
  }, [codeTheme, editor]);

  useEffect(() => {
    editor.update(() => {
      for (const codeNode of $nodesOfType(CodeNode)) {
        if (codeNode.getTheme() !== codeTheme) {
          codeNode.setTheme(codeTheme);
          codeNode.markDirty();
        }
      }
    });
  }, [codeTheme, editor]);

  return null;
}

function LegacyNotesMigrationPlugin(props: {
  enabled: boolean;
  onChange: (serializedEditorState: string) => void;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!props.enabled) {
      return;
    }

    editor.getEditorState().read(() => {
      const root = $getRoot();
      if (root.getChildrenSize() === 0) {
        return;
      }
      props.onChange(JSON.stringify(editor.getEditorState().toJSON()));
    });
  }, [editor, props]);

  return null;
}

function MobileSelectionToolbar(props: {
  onSendSelectionToChat: () => void;
  selectedCharacterCount: number;
}) {
  if (props.selectedCharacterCount === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] sm:hidden">
      <div className="pointer-events-auto overflow-hidden rounded-[1.4rem] border border-border/80 bg-background/95 shadow-xl backdrop-blur">
        <div className="border-border/70 border-b px-4 py-2 text-muted-foreground text-xs">
          {props.selectedCharacterCount} characters selected
        </div>
        <div className="overflow-x-auto px-2 py-2 [-webkit-overflow-scrolling:touch]">
          <SelectionFormattingControls
            compact
            onSendSelectionToChat={props.onSendSelectionToChat}
          />
        </div>
      </div>
    </div>
  );
}

export function ThreadNotesEditor(props: {
  initialState: string;
  onChange: (serializedEditorState: string) => void;
  onSelectionTextChange: (selectionText: string) => void;
  onSendSelectionToChat: () => void;
  placeholder?: string;
  selectedCharacterCount: number;
  threadId: string;
}) {
  const { editorState: initialEditorState, shouldMigrateLegacyNotes } =
    resolveThreadNotesInitialEditorState(props.initialState);
  const isTouchViewport = useMediaQuery(TOUCH_VIEWPORT_MEDIA_QUERY);
  const [fontFamily, setFontFamily] = useState<NotesFontFamily>("sans");
  const [defaultFontSize, setDefaultFontSize] = useState(readDefaultNotesFontSizePx);
  const [fontSizeOverride, setFontSizeOverride] = useState<number | null>(null);
  const fontSize = fontSizeOverride ?? defaultFontSize;

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const updateDefaultFontSize = () => {
      setDefaultFontSize(readDefaultNotesFontSizePx());
    };

    updateDefaultFontSize();

    const appearanceObserver = new MutationObserver(() => {
      updateDefaultFontSize();
    });

    appearanceObserver.observe(document.documentElement, {
      attributeFilter: ["data-ui-scale"],
      attributes: true,
    });

    return () => {
      appearanceObserver.disconnect();
    };
  }, []);

  const initialConfig = {
    namespace: THREAD_NOTES_EDITOR_NAMESPACE,
    nodes: [CodeNode, CodeHighlightNode, HeadingNode, QuoteNode, ListNode, ListItemNode],
    onError: (error: Error) => {
      throw error;
    },
    theme: notesTheme,
    ...(initialEditorState ? { editorState: initialEditorState } : {}),
  } satisfies InitialConfigType;

  return (
    <LexicalComposer key={props.threadId} initialConfig={initialConfig}>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <NotesToolbar
          canSendSelection={props.selectedCharacterCount > 0}
          fontFamily={fontFamily}
          fontSize={fontSize}
          onFontFamilyChange={setFontFamily}
          onFontSizeChange={(updater) => {
            setFontSizeOverride((currentOverride) => {
              const nextFontSize = updater(currentOverride ?? defaultFontSize);
              return nextFontSize === defaultFontSize ? null : nextFontSize;
            });
          }}
          onSendSelectionToChat={props.onSendSelectionToChat}
        />
        <div className="min-h-0 flex-1 overflow-visible">
          <div className="flex min-h-full justify-start px-5 py-4 pb-40 sm:px-8 sm:py-6 sm:pb-32 lg:px-12">
            <div className="flex min-h-full w-full max-w-[72rem] flex-col">
              <div className="relative min-h-[calc(100dvh-12rem)] flex-1">
                <RichTextPlugin
                  contentEditable={
                    <ContentEditable
                      aria-label="Thread notes editor"
                      className={cn(
                        "min-h-[calc(100dvh-16rem)] rounded-none border-0 bg-transparent outline-none",
                        "leading-[1.75] text-foreground",
                        "touch-auto",
                        "[&_ol]:ml-6 [&_ol]:list-decimal [&_ul]:ml-6 [&_ul]:list-disc",
                      )}
                      style={{
                        fontFamily: NOTES_FONT_FAMILIES[fontFamily],
                        fontSize: `${fontSize}px`,
                      }}
                    />
                  }
                  placeholder={
                    <div
                      className="pointer-events-none absolute top-0 left-0 max-w-2xl text-muted-foreground leading-[1.75]"
                      style={{
                        fontFamily: NOTES_FONT_FAMILIES[fontFamily],
                        fontSize: `${fontSize}px`,
                      }}
                    >
                      {props.placeholder ??
                        "Capture feature ideas, rough specs, and implementation notes here."}
                    </div>
                  }
                  ErrorBoundary={LexicalErrorBoundary}
                />
              </div>
            </div>
          </div>
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <CheckListPlugin disableTakeFocusOnClick={isTouchViewport} />
        <MobileCheckListTapPlugin enabled={isTouchViewport} />
        <CodeHighlightingPlugin />
        {isTouchViewport ? (
          <MobileSelectionToolbar
            onSendSelectionToChat={props.onSendSelectionToChat}
            selectedCharacterCount={props.selectedCharacterCount}
          />
        ) : (
          <FloatingSelectionToolbarPlugin onSendSelectionToChat={props.onSendSelectionToChat} />
        )}
        <SelectionTextPlugin onSelectionTextChange={props.onSelectionTextChange} />
        <LegacyNotesMigrationPlugin enabled={shouldMigrateLegacyNotes} onChange={props.onChange} />
        <PersistEditorStatePlugin onChange={props.onChange} />
      </div>
    </LexicalComposer>
  );
}
