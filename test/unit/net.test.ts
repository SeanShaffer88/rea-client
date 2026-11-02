import { describe, expect, it } from "vitest";
import { NetworkPolicyError, assertLoopbackUrl, isLoopbackHostname } from "../../src/platform/net.js";

describe("isLoopbackHostname", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "api.localhost",
    "127.0.0.1",
    "127.10.20.30",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "[0:0:0:0:0:0:0:1]",
    "::ffff:127.0.0.1",
    "[::ffff:127.0.0.1]",
    "[::ffff:7f00:1]",
  ])("accepts %s", (host) => {
    expect(isLoopbackHostname(host)).toBe(true);
  });

  it.each([
    "example.com",
    "0.0.0.0",
    "192.168.1.10",
    "10.0.0.5",
    "::ffff:8.8.8.8",
    "[::ffff:8.8.8.8]",
    "[::ffff:192.0.2.1]",
    "",
  ])(
    "rejects %s",
    (host) => {
      expect(isLoopbackHostname(host)).toBe(false);
    },
  );
});

describe("assertLoopbackUrl", () => {
  it("returns the parsed URL for a loopback endpoint", () => {
    const url = assertLoopbackUrl("http://127.0.0.1:8080/v1");
    expect(url.port).toBe("8080");
  });

  it("accepts IPv4-mapped IPv6 and uncompressed IPv6 loopback URLs", () => {
    expect(() => assertLoopbackUrl("http://[::ffff:127.0.0.1]:8080/v1")).not.toThrow();
    expect(() => assertLoopbackUrl("http://[0:0:0:0:0:0:0:1]:8080/v1")).not.toThrow();
    expect(() => assertLoopbackUrl("http://[::ffff:192.0.2.1]:8080/v1")).toThrow(
      NetworkPolicyError,
    );
  });

  it("refuses a remote host by default", () => {
    expect(() => assertLoopbackUrl("http://10.0.0.5:8080/v1")).toThrow(NetworkPolicyError);
  });

  it("allows a remote host when explicitly opted in", () => {
    expect(() =>
      assertLoopbackUrl("http://10.0.0.5:8080/v1", { allowNonLoopback: true }),
    ).not.toThrow();
  });

  it("names the setting in the error", () => {
    try {
      assertLoopbackUrl("http://example.com/v1", { settingName: "llm.baseUrl" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("llm.baseUrl");
      expect((error as Error).message).toContain("example.com");
    }
  });

  it("rejects non-http protocols", () => {
    expect(() => assertLoopbackUrl("ftp://127.0.0.1/model")).toThrow(/http or https/);
  });

  it("rejects malformed input", () => {
    expect(() => assertLoopbackUrl("not a url")).toThrow(NetworkPolicyError);
  });
});
