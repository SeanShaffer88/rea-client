import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CONFIG, parseConfig } from "../../src/config.js";

describe("parseConfig", () => {
  it("returns defaults for an empty object", () => {
    const config = parseConfig({});
    expect(config.rea.transport).toBe("stdio");
    expect(config.agent.toolScope).toBe("binary-core");
    expect(config.policy.allowNonLoopback).toBe(false);
  });

  it("applies defaults when input is undefined", () => {
    expect(parseConfig(undefined).llm.model).toBe(DEFAULT_CONFIG.llm.model);
  });

  it("deep-merges partial sections over defaults", () => {
    const config = parseConfig({ llm: { model: "custom-model" } });
    expect(config.llm.model).toBe("custom-model");
    expect(config.llm.maxTokens).toBe(DEFAULT_CONFIG.llm.maxTokens);
  });

  it("preserves the default REA env while merging overrides", () => {
    const config = parseConfig({ rea: { env: { REA_LOG_LEVEL: "debug" } } });
    expect(config.rea.env["NODE_ENV"]).toBe("production");
    expect(config.rea.env["REA_LOG_LEVEL"]).toBe("debug");
  });

  it("rejects a non-loopback model endpoint unless opted in", () => {
    expect(() => parseConfig({ llm: { baseUrl: "http://10.0.0.5:8080/v1" } })).toThrow(
      ConfigError,
    );
    expect(() =>
      parseConfig({
        llm: { baseUrl: "http://10.0.0.5:8080/v1" },
        policy: { allowNonLoopback: true },
      }),
    ).not.toThrow();
  });

  it("names the offending field", () => {
    try {
      parseConfig({ agent: { maxIterations: 0 } });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ConfigError).field).toBe("agent.maxIterations");
    }
  });

  it("rejects an unknown transport", () => {
    expect(() => parseConfig({ rea: { transport: "websocket" } })).toThrow(/expected one of/);
  });

  it("rejects a custom scope with no tools", () => {
    expect(() => parseConfig({ agent: { toolScope: "custom" } })).toThrow(/customTools/);
  });

  it("accepts a custom scope with tools", () => {
    const config = parseConfig({ agent: { toolScope: "custom", customTools: ["open_binary"] } });
    expect(config.agent.customTools).toEqual(["open_binary"]);
  });

  it("rejects non-string env values", () => {
    expect(() => parseConfig({ rea: { env: { PORT: 8080 } } })).toThrow(/expected a string/);
  });

  it("rejects out-of-range numeric settings", () => {
    expect(() => parseConfig({ llm: { temperature: 5 } })).toThrow(/between 0 and 2/);
  });

  it("rejects a top-level array", () => {
    expect(() => parseConfig([])).toThrow(/expected an object/);
  });
});
