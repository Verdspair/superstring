import type { RenderOptions, RenderResult } from "@testing-library/react";
import { render as rtlRender } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { DesignSystemProvider } from "../../../src/web/design-system/Providers";

export function render(ui: ReactNode, options: RenderOptions = {}): RenderResult {
  const callerWrapper = options.wrapper;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      DesignSystemProvider,
      null,
      callerWrapper ? createElement(callerWrapper, null, children) : children,
    );
  return rtlRender(ui, { ...options, wrapper });
}
