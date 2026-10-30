import type { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps, RefObject } from "react";
import { useRef } from "react";

type FocusHandlers = Pick<
  ComponentProps<typeof DialogPrimitive.Content>,
  "onOpenAutoFocus" | "onCloseAutoFocus" | "onBlurCapture"
>;

export function useOverlayReturnFocus({
  onOpenAutoFocus,
  onCloseAutoFocus,
  onBlurCapture,
  returnFocusRef,
}: FocusHandlers & { returnFocusRef?: RefObject<HTMLElement | null> }): FocusHandlers {
  const openingFocus = useRef<HTMLElement | null>(null);
  const registeredTrigger = useRef(false);
  const closingFocus = useRef<HTMLElement | null>(null);
  const openingSource = useRef(returnFocusRef);
  const currentSource = useRef(returnFocusRef);
  currentSource.current = returnFocusRef;
  const eligible = (element: HTMLElement | null): element is HTMLElement => {
    if (
      !element?.isConnected ||
      element === element.ownerDocument.body ||
      element === element.ownerDocument.documentElement ||
      element.matches(":disabled")
    )
      return false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = node.ownerDocument.defaultView?.getComputedStyle(node);
      if (
        node.hidden ||
        node.hasAttribute("inert") ||
        style?.display === "none" ||
        style?.visibility === "hidden" ||
        style?.visibility === "collapse"
      )
        return false;
    }
    return element.tabIndex >= 0 || element.hasAttribute("tabindex") || element.isContentEditable;
  };
  const restoreOpeningFocus = (event: Event) => {
    const target = openingSource.current === currentSource.current ? openingFocus.current : null;
    const destination = closingFocus.current;
    openingFocus.current = null;
    closingFocus.current = null;
    const content = event.currentTarget;
    if (!(content instanceof HTMLElement)) return;
    const document = content.ownerDocument;
    // Registered triggers retain Radix's original return-focus semantics.
    if (registeredTrigger.current) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !content.contains(active) && eligible(active)) {
      event.preventDefault();
      return;
    }
    if (
      destination?.ownerDocument === document &&
      eligible(destination) &&
      !content.contains(destination)
    ) {
      event.preventDefault();
      destination.focus({ preventScroll: true });
      return;
    }
    if (target?.ownerDocument === document && eligible(target)) {
      event.preventDefault();
      target.focus({ preventScroll: true });
    }
  };
  return {
    onOpenAutoFocus: (event) => {
      const document =
        event.currentTarget instanceof HTMLElement
          ? event.currentTarget.ownerDocument
          : window.document;
      openingSource.current = returnFocusRef;
      openingFocus.current = returnFocusRef
        ? returnFocusRef.current
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      closingFocus.current = null;
      const content = event.currentTarget;
      registeredTrigger.current =
        content instanceof HTMLElement &&
        Array.from(
          document.querySelectorAll<HTMLElement>('[aria-haspopup="dialog"][aria-controls]'),
        ).some((trigger) => trigger.getAttribute("aria-controls") === content.id);
      onOpenAutoFocus?.(event);
    },
    onBlurCapture: (event) => {
      onBlurCapture?.(event);
      const destination = event.relatedTarget;
      // A close commit can focus its next page before Radix releases its trap.
      if (
        !onCloseAutoFocus &&
        event.currentTarget.dataset.state === "closed" &&
        destination instanceof HTMLElement &&
        !event.currentTarget.contains(destination) &&
        eligible(destination)
      )
        closingFocus.current = destination;
    },
    onCloseAutoFocus: onCloseAutoFocus ?? restoreOpeningFocus,
  };
}
