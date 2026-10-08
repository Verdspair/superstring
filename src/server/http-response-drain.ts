type OwnedReader = {
  cancelAndRelease(): Promise<void>;
};

export class HttpResponseDrain {
  private readonly readers = new Set<OwnedReader>();

  constructor(private readonly releaseRequest: () => void) {}

  wrap(response: Response): Response {
    if (!response.body) {
      this.releaseRequest();
      return response;
    }

    const reader = response.body.getReader();
    let released = false;
    let owned: OwnedReader;
    let cancellation: Promise<void> | undefined;
    const release = () => {
      if (released) return;
      released = true;
      this.readers.delete(owned);
      this.releaseRequest();
    };
    const releaseAfterRead = () => {
      if (!cancellation) release();
    };
    owned = {
      cancelAndRelease() {
        cancellation ??= (async () => {
          try {
            await reader.cancel();
          } finally {
            release();
          }
        })();
        return cancellation;
      },
    };
    this.readers.add(owned);

    const body = new ReadableStream<Uint8Array>({
      pull: (controller) =>
        reader.read().then(
          ({ done, value }) => {
            if (done) {
              controller.close();
              releaseAfterRead();
            } else {
              controller.enqueue(value);
            }
          },
          (error) => {
            controller.error(error);
            releaseAfterRead();
          },
        ),
      cancel: () => owned.cancelAndRelease(),
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  async cancelActive(): Promise<void> {
    await Promise.allSettled([...this.readers].map((reader) => reader.cancelAndRelease()));
  }
}
