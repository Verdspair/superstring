/** Why an image could not be prepared, as an error the caller can show or log. */
export class QqImagePrepareError extends Error {
  readonly reason: "unreadable_image" | "unsupported_animation" | "cancelled" | "decode_failed";

  constructor(reason: QqImagePrepareError["reason"], detail?: string) {
    super(detail ?? reason);
    this.name = "QqImagePrepareError";
    this.reason = reason;
  }
}
