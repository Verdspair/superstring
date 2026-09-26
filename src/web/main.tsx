import { bootstrapWebApplication } from "./bootstrap";

// The dynamic boundary is deliberate: App/i18n/appearance read preferences during evaluation.
void bootstrapWebApplication(() => import("./render"));
