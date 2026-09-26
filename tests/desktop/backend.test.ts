import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { childEnvironment, DesktopBackend, localRequest } from "../../src/desktop/backend";

const roots: string[] = [];
const hosts: DesktopBackend[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(script: string, overrides: { startupTimeoutMs?: number } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "superstring host 测试 "));
  roots.push(root);
  const entry = path.join(root, "service.cjs");
  writeFileSync(entry, script);
  const logs: string[] = [];
  const exits: boolean[] = [];
  const host = new DesktopBackend({
    executable: process.execPath,
    args: [entry],
    profileRoot: root,
    resourceRoot: root,
    log: (line) => logs.push(line),
    onExit: (expected) => exits.push(expected),
    ...overrides,
  });
  hosts.push(host);
  return { host, logs, exits };
}

const service = `
const http=require('node:http');
const server=http.createServer((req,res)=>{
 if(req.headers.authorization!=='Bearer '+process.env.SUPERSTRING_DESKTOP_TOKEN) {res.writeHead(403).end();return;}
 if(req.url==='/__desktop/stop') {res.end('ok');server.close(()=>process.exit(0));return;}
 res.setHeader('content-type','application/json');
 res.end(JSON.stringify({app:'superstring',desktop:true,state:'ready',close_action:'background',page_connections:1}));
});
process.stdin.resume();
process.stdin.on('end',()=>server.close(()=>process.exit(0)));
server.listen(0,'127.0.0.1',()=>console.log('SUPERSTRING_DESKTOP_PORT '+server.address().port));
`;

describe("native desktop service owner", () => {
  test("uses inherited model configuration but strips executable/database overrides", () => {
    const env = childEnvironment(
      {
        LM_STUDIO_URL: "http://model",
        BUN_BE_BUN: "1",
        NODE_PATH: "wrong",
        NODE_OPTIONS: "--inspect",
        BUN_OPTIONS: "--preload evil",
        SUPERSTRING_DB_PATH: "wrong",
      },
      "/profile",
      "/resources",
      "token",
    );
    expect(env.LM_STUDIO_URL).toBe("http://model");
    expect(env.SUPERSTRING_APP_ROOT).toBe("/profile");
    for (const name of [
      "BUN_BE_BUN",
      "NODE_PATH",
      "NODE_OPTIONS",
      "BUN_OPTIONS",
      "SUPERSTRING_DB_PATH",
    ])
      expect(env[name]).toBeUndefined();
  });

  test("readiness verifies identity and graceful stop waits for owned process exit", async () => {
    const { host, exits } = fixture(service);
    const origin = await host.start();
    expect((await localRequest(origin, "/__desktop/status")).status).toBe(403);
    expect((await host.status()).close_action).toBe("background");
    await Promise.all([host.stop(), host.stop()]);
    expect(exits).toEqual([true]);
    expect(host.exitCode).toBe(0);
    await expect(localRequest(origin, "/__desktop/status")).rejects.toThrow();
  });

  test("a different service identity never becomes ready", async () => {
    const { host } = fixture(service.replace("app:'superstring'", "app:'other'"));
    await expect(host.start()).rejects.toThrow("DESKTOP_SERVICE_IDENTITY_MISMATCH");
    await host.stop();
  });

  test("a startup timeout signals EOF and does not strand a child", async () => {
    const { host, exits } = fixture(
      "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));",
      { startupTimeoutMs: 100 },
    );
    await expect(host.start()).rejects.toThrow("DESKTOP_STARTUP_TIMEOUT");
    await host.stop();
    expect(exits).toEqual([true]);
  });

  test("redacts launch credential in both process output streams", async () => {
    const { host, logs } = fixture(
      `console.error(process.env.SUPERSTRING_DESKTOP_TOKEN);\n${service}`,
    );
    await host.start();
    await host.stop();
    expect(logs.join("\n")).not.toContain(host.token);
    expect(logs.join("\n")).toContain("[desktop credential]");
  });

  test("native control requests never follow redirects or accept non-loopback URLs", async () => {
    let redirected = false;
    const server = createServer((req, res) => {
      if (req.url === "/destination") redirected = true;
      res.writeHead(302, { location: "/destination" }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test bind failed");
      expect(
        (await localRequest(`http://127.0.0.1:${address.port}`, "/status", "private")).status,
      ).toBe(302);
      expect(redirected).toBe(false);
      await expect(localRequest("https://example.com", "/status", "private")).rejects.toThrow(
        "DESKTOP_INVALID_SERVICE_ORIGIN",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
