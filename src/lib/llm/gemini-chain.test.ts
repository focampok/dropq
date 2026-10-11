import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiChain,
  GeminiDeadlineError,
  envNumber,
  geminiFailureCode,
  isTransient,
  readGeminiConfig,
  resetGeminiCallCount,
  type ChainCall,
} from "@/lib/llm/gemini-chain";

const THREE = ["principal", "fallback-a", "fallback-b"];

function config(models = THREE) {
  return { apiKey: "test-key", models, retryAttempts: 3, retryDelayMs: 1000, retryMaxDelayMs: 8000 };
}

function http(status: number, message = "nope"): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

afterEach(() => {
  resetGeminiCallCount();
  delete process.env.DROPQ_LLM_BUDGET;
});

describe("gemini config", () => {
  it("returns no_key and does not build a chain when both key variables are empty", () => {
    expect(readGeminiConfig({ GEMINI_MODEL: "principal", LLM_MODEL: "other" })).toEqual({ ok: false, off: "no_key" });
  });

  it("accepts GEMINI_API_KEY when the Google variable is empty", () => {
    const read = readGeminiConfig({ GEMINI_API_KEY: "alias", GEMINI_MODEL: "principal" });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.config.models).toEqual(["principal"]);
  });

  it("trims the chain, drops empties, and does not repeat the principal", () => {
    const read = readGeminiConfig({
      GOOGLE_GENERATIVE_AI_API_KEY: "k",
      GEMINI_MODEL: " principal ",
      GEMINI_FALLBACK_MODELS: " principal, , fallback-a, fallback-a ,fallback-b",
    });
    expect(read.ok && read.config.models).toEqual(["principal", "fallback-a", "fallback-a", "fallback-b"]);
  });

  it("uses LLM_MODEL only when GEMINI_MODEL is empty", () => {
    const withPrincipal = readGeminiConfig({
      GOOGLE_GENERATIVE_AI_API_KEY: "k",
      GEMINI_MODEL: "fast",
      LLM_MODEL: "slow",
    });
    const without = readGeminiConfig({
      GOOGLE_GENERATIVE_AI_API_KEY: "k",
      LLM_MODEL: "slow",
      GEMINI_FALLBACK_MODELS: "slow,other",
    });
    expect(withPrincipal.ok && withPrincipal.config.models).toEqual(["fast"]);
    expect(without.ok && without.config.models).toEqual(["slow", "other"]);
  });

  it("returns no_model when the principal is empty", () => {
    expect(readGeminiConfig({ GOOGLE_GENERATIVE_AI_API_KEY: "k", GEMINI_MODEL: "  ", LLM_MODEL: "" })).toEqual({
      ok: false,
      off: "no_model",
    });
  });

  it("uses the numeric defaults for 0, empty and NaN", () => {
    expect(envNumber("0", 3)).toBe(3);
    expect(envNumber("", 1000)).toBe(1000);
    expect(envNumber("nope", 8000)).toBe(8000);
    expect(envNumber("2", 3)).toBe(2);
    const read = readGeminiConfig({
      GOOGLE_GENERATIVE_AI_API_KEY: "k",
      GEMINI_MODEL: "principal",
      GEMINI_RETRY_ATTEMPTS: "0",
      GEMINI_RETRY_DELAY_MS: "",
      GEMINI_RETRY_MAX_DELAY_MS: "nope",
    });
    expect(read.ok && read.config.retryAttempts).toBe(3);
    expect(read.ok && read.config.retryDelayMs).toBe(1000);
    expect(read.ok && read.config.retryMaxDelayMs).toBe(8000);
  });
});

describe("gemini fallback loop", () => {
  it("discards a permanent 404 with no sleep and tries the next model", async () => {
    const sleeps: number[] = [];
    const seen: string[] = [];
    const chain = new GeminiChain(config(), { sleep: async (ms) => void sleeps.push(ms) });
    const result = await chain.generate(60_000, async ({ modelId }) => {
      seen.push(modelId);
      if (modelId === "principal") throw http(404, "missing");
      return "ok";
    });
    expect(sleeps).toEqual([]);
    expect(seen).toEqual(["principal", "fallback-a"]);
    expect(result.value).toBe("ok");
    expect(result.trace.modelUsed).toBe("fallback-a");
    expect(result.trace.attempts).toBe(1);
    expect(geminiFailureCode(http(404))).toBe("model_unavailable");
  });

  it("never retries 401 or 400 against the same model", async () => {
    const seen: string[] = [];
    const chain = new GeminiChain(config(), { sleep: async () => undefined });
    await chain.generate(60_000, async ({ modelId }) => {
      seen.push(modelId);
      if (modelId === "principal") throw http(401, "unauthorized");
      if (modelId === "fallback-a") throw http(400, "bad prompt");
      return "ok";
    });
    expect(seen).toEqual(["principal", "fallback-a", "fallback-b"]);
    expect(geminiFailureCode(http(401))).toBe("auth");
    expect(geminiFailureCode(http(403))).toBe("auth");
  });

  it("backs off 1000, 2000, 4000, 8000, 8000 and rotates the preferred index before sleeping", async () => {
    const sleeps: number[] = [];
    const preferredAtSleep: number[] = [];
    const hooked = new GeminiChain(config(), {
      sleep: async (ms) => {
        preferredAtSleep.push(hooked.modeloPreferidoIdx);
        sleeps.push(ms);
      },
    });
    await expect(hooked.generate(10 * 60_000, async () => {
      throw http(429, "slow down");
    })).rejects.toMatchObject({ statusCode: 429 });
    expect(sleeps.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(sleeps).toHaveLength(9);
    expect(preferredAtSleep[0]).toBe(1);
    expect(geminiFailureCode(http(429))).toBe("rate_limited");
    expect(isTransient(http(500))).toBe(true);
    expect(isTransient(http(400, "bad"))).toBe(false);
  });

  it("stops when every model is discarded and throws the last error", async () => {
    const chain = new GeminiChain(config(), { sleep: async () => undefined });
    const seen: string[] = [];
    await expect(
      chain.generate(60_000, async ({ modelId }) => {
        seen.push(modelId);
        throw http(404, `missing ${modelId}`);
      }),
    ).rejects.toMatchObject({ message: "missing fallback-b" });
    expect(seen).toEqual(THREE);
  });

  it("sticks to the model that succeeded", async () => {
    const chain = new GeminiChain(config(), { sleep: async () => undefined });
    const first: string[] = [];
    await chain.generate(60_000, async ({ modelId }) => {
      first.push(modelId);
      if (modelId === "principal") throw http(404);
      return "ok";
    });
    const second: string[] = [];
    await chain.generate(60_000, async ({ modelId }) => {
      second.push(modelId);
      return modelId;
    });
    expect(first).toEqual(["principal", "fallback-a"]);
    expect(second).toEqual(["fallback-a"]);
  });

  it("does not start a sleep that would end after the deadline", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const chain = new GeminiChain(config(["only"]), {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    await expect(
      chain.generate(1500, async () => {
        throw http(429);
      }),
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(sleeps).toEqual([1000]);
  });

  it("aborts a hung attempt at the deadline and treats that abort as transient", async () => {
    vi.useFakeTimers();
    const chain = new GeminiChain(config(["only"]), {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    let aborted = false;
    const pending = chain.generate(1000, ({ abortSignal }: ChainCall) => {
      return new Promise((_, reject) => {
        abortSignal.addEventListener("abort", () => {
          aborted = true;
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    const expectation = expect(pending).rejects.toBeInstanceOf(GeminiDeadlineError);
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
    expect(aborted).toBe(true);
    expect(isTransient(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    expect(geminiFailureCode(new GeminiDeadlineError())).toBe("deadline");
    vi.useRealTimers();
  });

  it("retries a model once without thinking when that option is rejected, then remembers", async () => {
    const chain = new GeminiChain(config(["only"]), { sleep: async () => undefined });
    const thinking: boolean[] = [];
    await chain.generate(60_000, async ({ thinking: enabled }) => {
      thinking.push(enabled);
      if (enabled) throw http(400, "thinkingLevel is not supported");
      return "ok";
    });
    const again: boolean[] = [];
    await chain.generate(60_000, async ({ thinking: enabled }) => {
      again.push(enabled);
      return "ok";
    });
    expect(thinking).toEqual([true, false]);
    expect(again).toEqual([false]);
  });

  it("does not rotate or discard a model on a JSON parse failure", async () => {
    const chain = new GeminiChain(config(), { sleep: async () => undefined });
    const error = new SyntaxError("bad json");
    await expect(chain.generate(60_000, async () => {
      throw error;
    })).rejects.toBe(error);
    expect(chain.modeloPreferidoIdx).toBe(0);
    expect(isTransient(error)).toBe(false);
  });
});
