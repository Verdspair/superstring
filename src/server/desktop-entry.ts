import { prepareDesktopEnvironment } from "./desktop-bootstrap";

// Compiled sidecars locate immutable resources beside the real executable, not
// relative to cwd, the user's profile, or an inherited development override.
prepareDesktopEnvironment(process.env, process.execPath);
await import("./index");
