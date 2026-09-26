import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "../components/ui/tooltip";

/** Visual lifetimes never own domain actions, drafts, or protected request payloads. */
export function DesignSystemProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.16, ease: "easeOut" }}>
      <TooltipProvider delayDuration={350} skipDelayDuration={100}>
        {children}
      </TooltipProvider>
    </MotionConfig>
  );
}
