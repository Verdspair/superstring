import * as Tooltip from "@radix-ui/react-tooltip";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/** Visual lifetimes never own domain actions, drafts, or protected request payloads. */
export function DesignSystemProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.16, ease: "easeOut" }}>
      <Tooltip.Provider delayDuration={350} skipDelayDuration={100}>
        {children}
      </Tooltip.Provider>
    </MotionConfig>
  );
}
