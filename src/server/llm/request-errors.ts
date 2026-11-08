/** Internal HTTP facts and request-shape fallback policy shared by chat and vision. */
export interface ModelHttpError extends Error {
  readonly status: number;
  readonly providerErrorCode?: string;
}

/** Extract the provider code from the complete body, before any diagnostic is shortened. */
export function createModelHttpError(status: number, rawBody: string): ModelHttpError {
  let providerErrorCode: string | undefined;
  try {
    const payload: unknown = JSON.parse(rawBody);
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      const error = (payload as { error?: unknown }).error;
      if (error !== null && typeof error === "object" && !Array.isArray(error)) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string") providerErrorCode = code;
      }
    }
  } catch {
    // Non-JSON bodies carry no typed discriminator and keep the existing generic policy.
  }
  return Object.assign(new Error(`LM Studio ${status}: ${rawBody}`), {
    status,
    ...(providerErrorCode === undefined ? {} : { providerErrorCode }),
  });
}

/** Only these exact wire codes on 400/404 identify an unavailable model. */
export function isModelUnavailableFailure(error: unknown): boolean {
  const facts = error as { status?: unknown; providerErrorCode?: unknown } | null;
  return (
    (facts?.status === 400 || facts?.status === 404) &&
    (facts.providerErrorCode === "model_not_found" ||
      facts.providerErrorCode === "model_not_loaded")
  );
}

// Image-content failures retain their public error but must not retry the same image as a shape.
const IMAGE_CONTENT_REJECTED: unique symbol = Symbol("model.imageContentRejected");

interface ContentMarkedError {
  [IMAGE_CONTENT_REJECTED]?: boolean;
}

export function markImageContentRejection(error: unknown): unknown {
  if (error instanceof Error) (error as Error & ContentMarkedError)[IMAGE_CONTENT_REJECTED] = true;
  return error;
}

/** Unknown non-auth 4xx keep the existing broad tools/format fallback eligibility. */
export function isModelRequestShapeRejection(error: unknown): boolean {
  if ((error as ContentMarkedError | null)?.[IMAGE_CONTENT_REJECTED] === true) return false;
  if (isModelUnavailableFailure(error)) return false;
  const status = (error as { status?: unknown } | null)?.status;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 403 &&
    status !== 408 &&
    status !== 413 &&
    status !== 429
  );
}
