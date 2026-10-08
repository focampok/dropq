import { afterEach, describe, expect, it } from "vitest";
import { openSessionCookie, sealSessionId } from "@/lib/session/cookie";

const originalSecret = process.env.SESSION_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSecret;
});

describe("session cookie", () => {
  it("round-trips a session id", async () => {
    process.env.SESSION_SECRET = "test-secret";
    const sealed = await sealSessionId("session-1");
    expect(sealed.startsWith("session-1.")).toBe(true);
    expect(await openSessionCookie(sealed)).toBe("session-1");
  });

  it("rejects a bad signature and a mismatched payload", async () => {
    process.env.SESSION_SECRET = "test-secret";
    const sealed = await sealSessionId("session-1");
    const [id, signature] = sealed.split(".");
    expect(await openSessionCookie(`${id}.${signature.slice(0, -1)}x`)).toBeNull();
    expect(await openSessionCookie("other-session." + signature)).toBeNull();
    expect(await openSessionCookie("nosignature")).toBeNull();
  });

  it("rejects a cookie signed with a different secret", async () => {
    process.env.SESSION_SECRET = "one";
    const sealed = await sealSessionId("session-1");
    process.env.SESSION_SECRET = "two";
    expect(await openSessionCookie(sealed)).toBeNull();
  });
});
