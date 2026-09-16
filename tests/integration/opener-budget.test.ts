import { describe, expect, it } from "bun:test";
import http from "node:http";
import type { Socket } from "node:net";
import { healthReady, remainingMs, runOpenMechanisms } from "../../tools/ops/open-when-ready";

async function withStub(delay: number | null, check: (port: number) => Promise<void>) {
  const sockets = new Set<Socket>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const server = http.createServer((_req, res) => {
    if (delay !== null)
      timers.push(
        setTimeout(() => {
          res.writeHead(200);
          res.end("ok");
        }, delay),
      );
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await check((server.address() as { port: number }).port);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("opener total deadline", () => {
  it("caps a silent health server by the remaining total budget", async () => {
    await withStub(null, async (port) => {
      const start = performance.now();
      expect(await healthReady(port, start + 100)).toBe(false);
      expect(performance.now() - start).toBeLessThan(750);
    });
  });
  it("accepts delayed healthy replies with sufficient budget", async () => {
    await withStub(150, async (port) => {
      expect(await healthReady(port, performance.now() + 1500)).toBe(true);
    });
  });
  it("does not start requests with an exhausted deadline", async () => {
    expect(remainingMs(performance.now() - 1)).toBe(0);
    expect(await healthReady(1, performance.now() - 1)).toBe(false);
  });
  it("kills only its own hanging opener command within the shared budget", async () => {
    const start = performance.now();
    const command = [process.execPath, "-e", "setInterval(() => {}, 1000)"];
    expect(await runOpenMechanisms([command], start + 200)).toBe(false);
    // Windows/Bun process termination acknowledgement measured ~3s locally.
    // The budget triggers kill; process reaping adds bounded test tolerance.
    expect(performance.now() - start).toBeLessThan(5000);
  });
  it("awaits successful dispatch and supports failure fallback without opening a browser", async () => {
    expect(
      await runOpenMechanisms(
        [
          [process.execPath, "-e", "process.exit(1)"],
          [process.execPath, "-e", "process.exit(0)"],
        ],
        performance.now() + 3000,
      ),
    ).toBe(true);
  });
  it("real CLI shares the budget with polling sleeps", async () => {
    await withStub(null, async (port) => {
      const start = performance.now();
      const child = Bun.spawn(
        [
          process.execPath,
          "tools/ops/open-when-ready.ts",
          "--port",
          String(port),
          "--timeout",
          "100",
          "--print-only",
        ],
        {
          cwd: new URL("../../", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"),
          stdout: "pipe",
          stderr: "pipe",
          timeout: 4000,
        },
      );
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      expect(await child.exited).toBe(1);
      expect(await stdout).toContain("server not ready within 100 ms");
      expect(await stderr).toBe("");
      expect(performance.now() - start).toBeLessThan(3000);
    });
  });
});
