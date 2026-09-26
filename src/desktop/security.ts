import type { Session, WebContents } from "electron";

const ACCESS_HEADER = "X-Superstring-Desktop";

export function isServiceUrl(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "ws:") url.protocol = "http:";
    return url.protocol === "http:" && url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function externalHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** A single session hook removes caller-supplied credentials before applying host ownership. */
export function installSessionSecurity(
  session: Session,
  getBackend: () => { origin: string; token: string } | null,
  getContents: () => WebContents | null,
): void {
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    for (const key of Object.keys(requestHeaders)) {
      if (key.toLowerCase() === ACCESS_HEADER.toLowerCase()) delete requestHeaders[key];
    }
    const backend = getBackend();
    const contents = getContents();
    const frameUrl = details.frame?.url;
    const currentUrl = contents && !contents.isDestroyed() ? contents.getURL() : null;
    const initialDocument =
      details.resourceType === "mainFrame" &&
      (currentUrl === "about:blank" || currentUrl === "") &&
      (frameUrl === undefined || frameUrl === "about:blank" || frameUrl === "");
    if (
      backend &&
      contents &&
      !contents.isDestroyed() &&
      details.webContentsId === contents.id &&
      isServiceUrl(details.url, backend.origin) &&
      (!details.initiatorOrigin || isServiceUrl(details.initiatorOrigin, backend.origin)) &&
      (initialDocument || (frameUrl !== undefined && isServiceUrl(frameUrl, backend.origin)))
    ) {
      requestHeaders[ACCESS_HEADER] = backend.token;
    }
    callback({ requestHeaders });
  });
  // Clipboard writes are a user-facing feature; no camera/microphone/location entitlement is needed.
  session.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    const backend = getBackend();
    return (
      permission === "clipboard-sanitized-write" &&
      contents === getContents() &&
      !!backend &&
      isServiceUrl(requestingOrigin, backend.origin)
    );
  });
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const backend = getBackend();
    callback(
      permission === "clipboard-sanitized-write" &&
        contents === getContents() &&
        !!backend &&
        isServiceUrl(details.requestingUrl, backend.origin),
    );
  });
  session.on("will-download", (event, item, contents) => {
    const backend = getBackend();
    // Downloads initiated by the product retain Electron's native Save dialog.
    let ownedBlob = false;
    try {
      const url = new URL(item.getURL());
      ownedBlob = url.protocol === "blob:" && url.origin === backend?.origin;
    } catch {
      /* An invalid download target is rejected below. */
    }
    if (
      contents !== getContents() ||
      !backend ||
      (!ownedBlob && !isServiceUrl(item.getURL(), backend.origin))
    )
      event.preventDefault();
  });
}
