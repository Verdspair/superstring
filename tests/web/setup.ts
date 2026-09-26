// DOM capabilities used by the official UI primitives. Geometry is verified in a real browser.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => {
    const target = new EventTarget();
    const evaluate = () => {
      const width = /\((min|max)-width:\s*([\d.]+)px\)/.exec(query);
      return width
        ? width[1] === "max"
          ? innerWidth <= Number(width[2])
          : innerWidth >= Number(width[2])
        : false;
    };
    let previous = evaluate();
    const media = Object.assign(target, {
      media: query,
      get matches() {
        return evaluate();
      },
      onchange: null as MediaQueryList["onchange"],
      addListener(listener: (event: MediaQueryListEvent) => void) {
        target.addEventListener("change", listener as EventListener);
      },
      removeListener(listener: (event: MediaQueryListEvent) => void) {
        target.removeEventListener("change", listener as EventListener);
      },
    });
    Object.defineProperty(media, "matches", { get: evaluate });
    window.addEventListener("resize", () => {
      const matches = evaluate();
      if (matches === previous) return;
      previous = matches;
      const event = Object.assign(new Event("change"), { matches, media: query });
      target.dispatchEvent(event);
      media.onchange?.call(media as MediaQueryList, event as MediaQueryListEvent);
    });
    return media as MediaQueryList;
  };
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
if (!HTMLElement.prototype.hasPointerCapture) HTMLElement.prototype.hasPointerCapture = () => false;
if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {};
if (!HTMLElement.prototype.releasePointerCapture)
  HTMLElement.prototype.releasePointerCapture = () => {};
