import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GEMINI_ATTEMPT_CAP_FRACTION_ANCHORS,
  GEMINI_ATTEMPT_CAP_FRACTION_NARRATION,
  GEMINI_SLOW_DEMOTION_MS,
  GEMINI_SLOW_LATENCY_FRACTION,
} from "@/lib/config";
import {
  GeminiChain,
  GeminiDeadlineError,
  GeminiQuotaError,
  classifyRateLimit,
  envNumber,
  geminiFailureCode,
  isTransient,
  nextPacificMidnightMs,
  readGeminiConfig,
  resetGeminiCallCount,
  type ChainCall,
} from "@/lib/llm/gemini-chain";
import { ANCHOR_ATTEMPT_CAP_MS, ANCHOR_TIMEOUT_MS, LLM_TIMEOUT_MS, NARRATION_ATTEMPT_CAP_MS } from "@/lib/pipeline/llm";

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

  it("backs off 1000, 2000, 4000, 8000, 8000 on transient 5xx and rotates before sleeping", async () => {
    const sleeps: number[] = [];
    const preferredAtSleep: number[] = [];
    const hooked = new GeminiChain(config(), {
      sleep: async (ms) => {
        preferredAtSleep.push(hooked.modeloPreferidoIdx);
        sleeps.push(ms);
      },
    });
    await expect(hooked.generate(10 * 60_000, async () => {
      throw http(503, "overloaded");
    })).rejects.toMatchObject({ statusCode: 503 });
    expect(sleeps.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(sleeps).toHaveLength(9);
    expect(preferredAtSleep[0]).toBe(1);
    expect(geminiFailureCode(http(429))).toBe("rate_limited");
    expect(isTransient(http(500))).toBe(true);
    expect(isTransient(http(400, "bad"))).toBe(false);
  });

  it("puts a per-day 429 model in cooldown until Pacific midnight and skips it with no sleep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T18:00:00.000Z"));
    const sleeps: number[] = [];
    let now = Date.now();
    const chain = new GeminiChain(config(["principal", "fallback-a"]), {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    const perDay = Object.assign(new Error("Resource exhausted"), {
      statusCode: 429,
      data: { error: { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", metadata: { quota_metric: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" } }] } },
    });
    await expect(
      chain.generate(60_000, async ({ modelId }) => {
        if (modelId === "principal") throw perDay;
        return "ok";
      }),
    ).resolves.toMatchObject({ value: "ok" });
    expect(sleeps).toEqual([]);
    expect(classifyRateLimit(perDay).kind).toBe("per_day");

    const seen: string[] = [];
    const reset = nextPacificMidnightMs(now);
    await expect(
      chain.generate(60_000, async ({ modelId }) => {
        seen.push(modelId);
        return modelId;
      }),
    ).resolves.toMatchObject({ value: "fallback-a" });
    expect(seen).toEqual(["fallback-a"]);
    expect(sleeps).toEqual([]);

    now = reset;
    expect(chain.quotaBlocked()).toBeNull();
    chain.modeloPreferidoIdx = 0;
    const after: string[] = [];
    await chain.generate(60_000, async ({ modelId }) => {
      after.push(modelId);
      return modelId;
    });
    expect(after[0]).toBe("principal");
    vi.useRealTimers();
  });

  it("uses the suggested retry delay for a per-minute 429 cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T18:00:00.000Z"));
    let now = Date.now();
    const sleeps: number[] = [];
    const chain = new GeminiChain(config(["only"]), {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    const perMinute = Object.assign(new Error("Resource exhausted"), {
      statusCode: 429,
      data: { error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "45s" }] } },
    });
    await expect(chain.generate(60_000, async () => {
      throw perMinute;
    })).rejects.toBeInstanceOf(GeminiQuotaError);
    expect(sleeps).toEqual([]);
    expect(geminiFailureCode(new GeminiQuotaError("per_minute"))).toBe("quota_minute");
    expect(chain.quotaBlocked()).toBe("per_minute");

    const skipped: string[] = [];
    await expect(
      chain.generate(60_000, async ({ modelId }) => {
        skipped.push(modelId);
        return "nope";
      }),
    ).rejects.toBeInstanceOf(GeminiQuotaError);
    expect(skipped).toEqual([]);
    expect(sleeps).toEqual([]);

    now += 45_000;
    expect(chain.quotaBlocked()).toBeNull();
    await expect(chain.generate(60_000, async () => "ok")).resolves.toMatchObject({ value: "ok" });
    vi.useRealTimers();
  });

  it("returns immediate quota fallback when every model is in cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T18:00:00.000Z"));
    let now = Date.now();
    const sleeps: number[] = [];
    const chain = new GeminiChain(config(), {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    const bodySnippet = "GenerateRequestsPerDayPerProjectPerModel-FreeTier";
    await expect(
      chain.generate(60_000, async () => {
        throw Object.assign(new Error("quota"), {
          statusCode: 429,
          responseBody: bodySnippet,
        });
      }),
    ).rejects.toMatchObject({ name: "GeminiQuotaError", message: "quota_daily" });
    expect(sleeps).toEqual([]);
    expect(chain.quotaBlocked()).toBe("per_day");

    const attempts: string[] = [];
    await expect(
      chain.generate(60_000, async ({ modelId }) => {
        attempts.push(modelId);
        return "x";
      }),
    ).rejects.toMatchObject({ message: "quota_daily" });
    expect(attempts).toEqual([]);
    // Coverage / logs must never contain the response body text.
    expect(JSON.stringify({ failures: ["quota_daily"], off: "quota" })).not.toContain(bodySnippet);
    vi.useRealTimers();
  });

  it("does not start a sleep that would end after the deadline on transient 5xx", async () => {
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
        throw http(503);
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(sleeps).toEqual([1000]);
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

  it("abandons a hanging principal at the per-attempt cap and lets the next model answer", async () => {
    vi.useFakeTimers();
    const chain = new GeminiChain(config(["principal", "fallback-a"]), {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    const seen: string[] = [];
    const pending = chain.generate(
      6_000,
      ({ modelId, abortSignal }: ChainCall) => {
        seen.push(modelId);
        if (modelId === "principal") {
          return new Promise((_, reject) => {
            abortSignal.addEventListener("abort", () => {
              const error = new Error("This operation was aborted");
              error.name = "AbortError";
              reject(error);
            });
          });
        }
        return Promise.resolve("ok");
      },
      { attemptCapMs: 3_000 },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toMatchObject({ value: "ok", trace: { modelUsed: "fallback-a" } });
    expect(seen).toEqual(["principal", "fallback-a"]);
    expect(chain.isDemoted("principal")).toBe(true);
    vi.useRealTimers();
  });

  it("demotes a model after two slow answers and starts the next call on the next model", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T18:00:00.000Z"));
    let now = Date.now();
    const chain = new GeminiChain(config(["principal", "fallback-a"]), {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const cap = 3_000;
    const slowMs = Math.floor(cap * GEMINI_SLOW_LATENCY_FRACTION) + 1;
    for (let i = 0; i < 2; i += 1) {
      await chain.generate(
        12_000,
        async ({ modelId }) => {
          now += slowMs;
          return modelId;
        },
        { attemptCapMs: cap },
      );
    }
    expect(chain.isDemoted("principal")).toBe(true);
    const seen: string[] = [];
    await chain.generate(
      12_000,
      async ({ modelId }) => {
        seen.push(modelId);
        return modelId;
      },
      { attemptCapMs: cap },
    );
    expect(seen).toEqual(["fallback-a"]);
    vi.useRealTimers();
  });

  it("expires demotion after the configured window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T18:00:00.000Z"));
    let now = Date.now();
    const chain = new GeminiChain(config(["principal", "fallback-a"]), {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const cap = 3_000;
    const slowMs = Math.floor(cap * GEMINI_SLOW_LATENCY_FRACTION) + 1;
    for (let i = 0; i < 2; i += 1) {
      await chain.generate(
        12_000,
        async ({ modelId }) => {
          now += slowMs;
          return modelId;
        },
        { attemptCapMs: cap },
      );
    }
    expect(chain.isDemoted("principal")).toBe(true);
    now += GEMINI_SLOW_DEMOTION_MS;
    expect(chain.isDemoted("principal")).toBe(false);
    chain.modeloPreferidoIdx = 0;
    const seen: string[] = [];
    await chain.generate(12_000, async ({ modelId }) => {
      seen.push(modelId);
      return modelId;
    });
    expect(seen[0]).toBe("principal");
    vi.useRealTimers();
  });

  it("still uses a demoted model when every other model has failed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T18:00:00.000Z"));
    let now = Date.now();
    const chain = new GeminiChain(config(["principal", "fallback-a"]), {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const cap = 3_000;
    const slowMs = Math.floor(cap * GEMINI_SLOW_LATENCY_FRACTION) + 1;
    for (let i = 0; i < 2; i += 1) {
      await chain.generate(
        12_000,
        async ({ modelId }) => {
          now += slowMs;
          return modelId;
        },
        { attemptCapMs: cap },
      );
    }
    expect(chain.isDemoted("principal")).toBe(true);
    const seen: string[] = [];
    const result = await chain.generate(
      60_000,
      async ({ modelId }) => {
        seen.push(modelId);
        if (modelId === "fallback-a") throw http(404, "gone");
        return "from-demoted";
      },
      { attemptCapMs: cap },
    );
    expect(seen).toEqual(["fallback-a", "principal"]);
    expect(result.value).toBe("from-demoted");
    vi.useRealTimers();
  });

  it("uses distinct per-attempt caps for anchors and narration", () => {
    expect(GEMINI_ATTEMPT_CAP_FRACTION_ANCHORS).toBe(0.5);
    expect(GEMINI_ATTEMPT_CAP_FRACTION_NARRATION).toBe(0.5);
    expect(ANCHOR_ATTEMPT_CAP_MS).toBe(Math.floor(ANCHOR_TIMEOUT_MS * GEMINI_ATTEMPT_CAP_FRACTION_ANCHORS));
    expect(NARRATION_ATTEMPT_CAP_MS).toBe(Math.floor(LLM_TIMEOUT_MS * GEMINI_ATTEMPT_CAP_FRACTION_NARRATION));
    expect(ANCHOR_ATTEMPT_CAP_MS).toBe(3_000);
    expect(NARRATION_ATTEMPT_CAP_MS).toBe(6_000);
    expect(ANCHOR_ATTEMPT_CAP_MS).not.toBe(NARRATION_ATTEMPT_CAP_MS);
  });
});

const PER_DAY_BODY = "GenerateRequestsPerDayPerProjectPerModel-FreeTier";

function perDay(): Error {
  return Object.assign(new Error("Resource exhausted"), {
    statusCode: 429,
    responseBody: PER_DAY_BODY,
  });
}

function perMinute(delay: string): Error {
  return Object.assign(new Error("Resource exhausted"), {
    statusCode: 429,
    data: {
      error: {
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay }],
      },
    },
  });
}

describe("per-model quota exhaustion", () => {
  /** A chain where `live` rate-limits once and the two fallbacks are out of daily quota. */
  function throttledChain() {
    let now = Date.parse("2026-10-12T18:00:00.000Z");
    const calls = new Map<string, number>(["live", "dead-a", "dead-b"].map((id) => [id, 0]));
    let liveFails = true;
    const sleeps: number[] = [];
    const chain = new GeminiChain(config(["live", "dead-a", "dead-b"]), {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    const run = async ({ modelId }: ChainCall) => {
      calls.set(modelId, (calls.get(modelId) ?? 0) + 1);
      if (modelId === "live") {
        if (liveFails) return Promise.reject(perMinute("45s"));
        return "ok";
      }
      return Promise.reject(perDay());
    };
    return {
      chain,
      calls,
      sleeps,
      run,
      reached: (ms: number) => {
        now += ms;
      },
      allowLive: () => {
        liveFails = false;
      },
    };
  }

  it("calls a per-day exhausted model at most once per process, across many requests", async () => {
    const t = throttledChain();
    await expect(t.chain.generate(60_000, t.run)).rejects.toMatchObject({ name: "GeminiQuotaError" });
    expect(t.calls.get("live")).toBe(1);
    expect(t.calls.get("dead-a")).toBe(1);
    expect(t.calls.get("dead-b")).toBe(1);
    expect(t.sleeps).toEqual([]);

    // Every later request inside the cooldown window pays nothing: the two dead
    // models stay skipped until their daily reset, so only the cooldown of `live`
    // is in the way.
    for (let request = 0; request < 5; request += 1) {
      await expect(t.chain.generate(60_000, t.run)).rejects.toMatchObject({ name: "GeminiQuotaError" });
    }
    expect(t.calls.get("live")).toBe(1);
    expect(t.calls.get("dead-a")).toBe(1);
    expect(t.calls.get("dead-b")).toBe(1);

    // Once the per-minute cooldown expires the principal answers again, and the
    // daily-exhausted fallbacks are still never called a second time.
    t.reached(45_000);
    t.allowLive();
    await expect(t.chain.generate(60_000, t.run)).resolves.toMatchObject({ value: "ok" });
    expect(t.calls.get("live")).toBe(2);
    expect(t.calls.get("dead-a")).toBe(1);
    expect(t.calls.get("dead-b")).toBe(1);
  });

  it("skips a cooling model with no call and tries it again when the cooldown expires", async () => {
    let now = Date.parse("2026-10-12T18:00:00.000Z");
    const chain = new GeminiChain(config(["only"]), { now: () => now, sleep: async (ms) => void (now += ms) });
    let calls = 0;
    const run = async () => {
      calls += 1;
      if (calls === 1) throw perMinute("45s");
      return "ok";
    };
    await expect(chain.generate(60_000, run)).rejects.toMatchObject({ name: "GeminiQuotaError" });
    expect(calls).toBe(1);
    await expect(chain.generate(60_000, run)).rejects.toMatchObject({ name: "GeminiQuotaError" });
    expect(calls).toBe(1);
    now += 45_000;
    await expect(chain.generate(60_000, run)).resolves.toMatchObject({ value: "ok" });
    expect(calls).toBe(2);
  });

  it("caps a per-minute cooldown at five minutes", async () => {
    let now = Date.parse("2026-10-12T18:00:00.000Z");
    const chain = new GeminiChain(config(["only"]), { now: () => now, sleep: async (ms) => void (now += ms) });
    await expect(
      chain.generate(60_000, async () => {
        throw perMinute("900s");
      }),
    ).rejects.toMatchObject({ name: "GeminiQuotaError" });
    expect(chain.skips()).toEqual([{ model: "only", skipped: "quota_minute", until: now + 300_000 }]);
    now += 300_000;
    await expect(chain.generate(60_000, async () => "ok")).resolves.toMatchObject({ value: "ok" });
  });

  it("makes zero calls and no sleeps when every model is already skipped", async () => {
    let now = Date.parse("2026-10-12T18:00:00.000Z");
    const sleeps: number[] = [];
    const chain = new GeminiChain(config(["live", "dead-a"]), {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    const calls: string[] = [];
    await expect(
      chain.generate(60_000, async ({ modelId }) => {
        calls.push(modelId);
        if (modelId === "live") throw perMinute("45s");
        throw perDay();
      }),
    ).rejects.toMatchObject({ name: "GeminiQuotaError" });
    expect(calls).toEqual(["live", "dead-a"]);

    const refused: string[] = [];
    for (let request = 0; request < 3; request += 1) {
      await expect(
        chain.generate(60_000, async ({ modelId }) => {
          refused.push(modelId);
          return "ok";
        }),
      ).rejects.toMatchObject({ name: "GeminiQuotaError" });
    }
    expect(refused).toEqual([]);
    expect(sleeps).toEqual([]);
    expect(chain.skips().map((skip) => `${skip.model}:${skip.skipped}`)).toEqual([
      "live:quota_minute",
      "dead-a:quota_daily",
    ]);
    expect(chain.skips().find((skip) => skip.skipped === "quota_daily")?.resetMs).toBe(
      nextPacificMidnightMs(now),
    );
  });

  it("reports a permanently discarded model as discarded", async () => {
    const chain = new GeminiChain(config(["gone", "ok"]), { sleep: async () => undefined });
    await expect(chain.generate(60_000, async ({ modelId }) => {
      if (modelId === "gone") throw http(404, "missing");
      return "ok";
    })).resolves.toMatchObject({ value: "ok" });
    expect(chain.skips()).toEqual([{ model: "gone", skipped: "discarded", until: Infinity }]);
    // The discarded model is not called again, even though it is still first in the order.
    chain.modeloPreferidoIdx = 0;
    const seen: string[] = [];
    await chain.generate(60_000, async ({ modelId }) => {
      seen.push(modelId);
      return modelId;
    });
    expect(seen).toEqual(["ok"]);
  });
});

describe("Pacific daily reset", () => {
  it("lands on midnight in America/Los_Angeles in both winter and summer", () => {
    const near = (expectedIso: string, nowIso: string) => {
      const got = nextPacificMidnightMs(Date.parse(nowIso));
      const expected = Date.parse(expectedIso);
      expect(got).toBeGreaterThanOrEqual(expected);
      expect(got - expected).toBeLessThanOrEqual(250);
    };
    // PST (UTC-8) in January, PDT (UTC-7) in July.
    near("2026-01-15T08:00:00.000Z", "2026-01-15T00:00:00.000Z");
    near("2026-07-15T07:00:00.000Z", "2026-07-15T00:00:00.000Z");
    // The Sundays the clock changes, either side of it.
    near("2026-03-09T07:00:00.000Z", "2026-03-08T12:00:00.000Z");
    near("2026-11-02T08:00:00.000Z", "2026-11-01T12:00:00.000Z");
    // The instant after the spring-forward jump is already the next day in the zone.
    expect(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", day: "2-digit" }).format(
      new Date(nextPacificMidnightMs(Date.parse("2026-03-09T03:30:00.000Z"))),
    )).toBe("09");
  });
});
