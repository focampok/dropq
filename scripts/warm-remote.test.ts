import { describe, expect, it, vi } from "vitest";
import {
  forwardedArgs,
  isConfirmation,
  runWarmRemote,
  validateRemoteConnectionString,
  WarmRemoteArgError,
  type WarmRemoteIo,
} from "./warm-remote";

/** A value that must never appear in any output, on any path. */
const SENTINEL = "postgresql://sentinel-user:sentinel-password@sentinel-host.example:5432/sentinel-db";

function makeIo(input: {
  replies: string[];
  tty?: boolean;
  exitCode?: number;
}): {
  io: WarmRemoteIo;
  printed: string[];
  spawned: { env: NodeJS.ProcessEnv; args: string[] }[];
  prompts: string[];
} {
  const printed: string[] = [];
  const spawned: { env: NodeJS.ProcessEnv; args: string[] }[] = [];
  const prompts: string[] = [];
  const replies = [...input.replies];
  const io: WarmRemoteIo = {
    isTty: () => input.tty ?? true,
    readHidden: async (prompt) => {
      prompts.push(prompt);
      return replies.shift() ?? "";
    },
    run: async (env, args) => {
      spawned.push({ env, args });
      return input.exitCode ?? 0;
    },
    out: (line) => printed.push(line),
  };
  return { io, printed, spawned, prompts };
}

/** Everything the run could have printed, as one string, to search for the sentinel. */
function captured(printed: readonly string[], spawned: { env: NodeJS.ProcessEnv; args: string[] }[]): string {
  return [...printed, ...spawned.flatMap((call) => call.args)].join("\n");
}

describe("connection string validation", () => {
  it("accepts a Postgres URL and refuses anything else by reason", () => {
    expect(validateRemoteConnectionString(SENTINEL)).toEqual({ ok: true });
    expect(validateRemoteConnectionString("postgres://u:p@db.example.com:5432/x")).toEqual({ ok: true });
    expect(validateRemoteConnectionString("  ")).toEqual({ ok: false, reason: "empty" });
    expect(validateRemoteConnectionString("not a url")).toEqual({ ok: false, reason: "not a URL" });
    expect(validateRemoteConnectionString("mysql://u:p@db.example.com/x")).toEqual({
      ok: false,
      reason: "not a Postgres URL",
    });
    expect(validateRemoteConnectionString("postgresql://u:p@localhost:5432/x")).toEqual({
      ok: false,
      reason: "host is local; use pnpm warm for this database",
    });
    expect(validateRemoteConnectionString("postgresql://u:p@127.0.0.1:5432/x").ok).toBe(false);
    expect(validateRemoteConnectionString("postgresql://u:p@[::1]:5432/x").ok).toBe(false);
  });
});

describe("forwarded arguments", () => {
  it("forwards the supported flags and drops --confirm-remote", () => {
    expect(forwardedArgs([])).toEqual([]);
    expect(forwardedArgs(["--check"])).toEqual(["--check"]);
    expect(forwardedArgs(["--until-ok", "--max-rounds", "2", "--pause-s", "60"])).toEqual([
      "--until-ok",
      "--max-rounds",
      "2",
      "--pause-s",
      "60",
    ]);
    expect(forwardedArgs(["--only", "roots-gt-la:es", "--confirm-remote"])).toEqual([
      "--only",
      "roots-gt-la:es",
    ]);
  });

  it("refuses an unknown flag or a flag without its value", () => {
    expect(() => forwardedArgs(["--remote"])).toThrow(WarmRemoteArgError);
    expect(() => forwardedArgs(["--only"])).toThrow(WarmRemoteArgError);
    expect(() => forwardedArgs(["--max-rounds", "--check"])).toThrow(WarmRemoteArgError);
  });
});

describe("warm:remote", () => {
  it("runs the warm with the string in the child environment only", async () => {
    const { io, printed, spawned, prompts } = makeIo({ replies: [SENTINEL, "yes"], exitCode: 7 });
    const code = await runWarmRemote(["--until-ok", "--max-rounds", "2"], io);

    expect(code).toBe(7);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.env.DATABASE_URL).toBe(SENTINEL);
    expect(spawned[0]!.args).toEqual(["--until-ok", "--max-rounds", "2", "--confirm-remote"]);
    expect(printed).toEqual(["remote"]);
    expect(prompts).toHaveLength(2);
    // The sentinel is nowhere in what a log, a terminal or a process list would show.
    expect(captured(printed, spawned)).not.toContain(SENTINEL);
    expect(captured(printed, spawned)).not.toContain("sentinel-password");
    // And it is not left behind in this process's own environment either.
    expect(process.env.DATABASE_URL).not.toBe(SENTINEL);
  });

  it("refuses without a TTY before asking for anything", async () => {
    const { io, printed, spawned, prompts } = makeIo({ replies: [SENTINEL], tty: false });
    expect(await runWarmRemote([], io)).toBe(2);
    expect(prompts).toEqual([]);
    expect(spawned).toEqual([]);
    expect(printed.join(" ")).toContain("not a TTY");
    expect(captured(printed, spawned)).not.toContain(SENTINEL);
  });

  it("refuses an empty value, a local host and a non-Postgres URL", async () => {
    for (const [reply, expected] of [
      ["", "empty"],
      ["postgresql://u:p@localhost:5432/x", "host is local"],
      ["https://example.com/db", "not a Postgres URL"],
    ] as const) {
      const { io, printed, spawned } = makeIo({ replies: [reply] });
      expect(await runWarmRemote([], io)).toBe(2);
      expect(spawned).toEqual([]);
      expect(printed.join(" ")).toContain(expected);
      if (reply) expect(captured(printed, spawned)).not.toContain(reply);
    }
  });

  it("refuses when the confirmation is not exactly yes", async () => {
    for (const answer of ["y", "si", "YES please", ""]) {
      const { io, spawned, printed } = makeIo({ replies: [SENTINEL, answer] });
      expect(await runWarmRemote([], io)).toBe(2);
      expect(spawned).toEqual([]);
      expect(printed.join(" ")).toContain("not confirmed");
      expect(captured(printed, spawned)).not.toContain(SENTINEL);
    }
    expect(isConfirmation("yes")).toBe(true);
    expect(isConfirmation(" YES ")).toBe(true);
    expect(isConfirmation("y")).toBe(false);
  });

  it("refuses an unknown argument before the prompt", async () => {
    const { io, printed, prompts } = makeIo({ replies: [SENTINEL] });
    expect(await runWarmRemote(["--nope"], io)).toBe(2);
    expect(prompts).toEqual([]);
    expect(printed.join(" ")).toContain("unknown argument");
  });

  it("returns the child's exit code", async () => {
    const ok = makeIo({ replies: [SENTINEL, "yes"], exitCode: 0 });
    expect(await runWarmRemote(["--check"], ok.io)).toBe(0);
    const bad = makeIo({ replies: [SENTINEL, "yes"], exitCode: 1 });
    expect(await runWarmRemote(["--check"], bad.io)).toBe(1);
  });
});
