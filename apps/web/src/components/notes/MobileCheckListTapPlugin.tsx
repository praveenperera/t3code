import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ListItemNode } from "@lexical/list";
import {
  $addUpdateTag,
  $getNearestNodeFromDOMNode,
  SKIP_DOM_SELECTION_TAG,
  SKIP_SELECTION_FOCUS_TAG,
} from "lexical";
import { useEffect } from "react";

function readVisualViewportScale(target: HTMLElement): number {
  const scale = target.ownerDocument.defaultView?.visualViewport?.scale;
  return typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function resolveChecklistTapTarget(event: TouchEvent): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return null;
  }

  const firstChild = target.firstChild;
  if (
    firstChild instanceof HTMLElement &&
    (firstChild.tagName === "UL" || firstChild.tagName === "OL")
  ) {
    return null;
  }

  const parentNode = target.parentNode as ({ __lexicalListType?: string } & Node) | null;
  if (!parentNode || parentNode.__lexicalListType !== "check") {
    return null;
  }

  const touch = event.changedTouches[0] ?? event.touches[0];
  if (!touch) {
    return null;
  }

  const rect = target.getBoundingClientRect();
  const zoom = readVisualViewportScale(target);
  const clientXInPixels = touch.clientX / zoom;
  const beforeWidthInPixels = Number.parseFloat(getComputedStyle(target, "::before").width) || 0;
  const clickAreaPadding = 32;

  const tappedCheckMarker =
    target.dir === "rtl"
      ? clientXInPixels < rect.right + clickAreaPadding &&
        clientXInPixels > rect.right - beforeWidthInPixels - clickAreaPadding
      : clientXInPixels > rect.left - clickAreaPadding &&
        clientXInPixels < rect.left + beforeWidthInPixels + clickAreaPadding;

  return tappedCheckMarker ? target : null;
}

export function MobileCheckListTapPlugin(props: { enabled: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!props.enabled) {
      return;
    }

    return editor.registerRootListener((rootElement, prevElement) => {
      const handleTouchEnd = (event: TouchEvent) => {
        const target = resolveChecklistTapTarget(event);
        if (!target || !editor.isEditable()) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        editor.update(() => {
          const node = $getNearestNodeFromDOMNode(target);
          if (!(node instanceof ListItemNode)) {
            return;
          }
          $addUpdateTag(SKIP_SELECTION_FOCUS_TAG);
          $addUpdateTag(SKIP_DOM_SELECTION_TAG);
          node.toggleChecked();
        });
      };

      if (rootElement) {
        rootElement.addEventListener("touchend", handleTouchEnd, {
          capture: true,
          passive: false,
        });
      }

      if (prevElement) {
        prevElement.removeEventListener("touchend", handleTouchEnd, {
          capture: true,
        });
      }
    });
  }, [editor, props.enabled]);

  return null;
}
