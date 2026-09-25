// The desktop close preference's page-facing route (§12).
//
// It is mounted in every mode rather than only in desktop mode: the value describes what the
// desktop host does when its window closes, so in a plain browser launch it is a stored answer
// with nothing to apply it to — the same shape as the QQ transport settings existing while the
// transport is switched off. The settings page is what hides it from a non-desktop user.

import { Hono } from "hono";
import { DesktopSettingsUpdateSchema } from "../../shared/contracts/desktop";
import type { BusinessDbHandle } from "../db/connection";
import { readDesktopSettings, updateDesktopSettings } from "../db/desktop-repository";
import { parseBody, readJsonBody } from "./validation";

export function desktopRoutes(business: BusinessDbHandle): Hono {
  const router = new Hono();
  router.get("/desktop/settings", (c) => c.json(readDesktopSettings(business.orm)));
  router.put("/desktop/settings", async (c) =>
    c.json(
      updateDesktopSettings(
        business.orm,
        parseBody(DesktopSettingsUpdateSchema, await readJsonBody(c.req.raw)),
      ),
    ),
  );
  return router;
}
