/**
 * `pnpm warm:remote` — warm the deployment without the connection string ever landing
 * in the shell history, in a file, or in any output.
 *
 * It reads the remote connection string from the TTY **with echo off**, keeps it in the
 * child process environment only, prints the word `remote`, asks for a typed `yes`, and
 * then runs `pnpm warm` with `--confirm-remote` implied. Everything after that behaves
 * exactly like a local warm: the flags are forwarded and the child's own `warm` guard
 * still refuses a non-local database without the flag.
 *
 * Refusals are explicit and happen before anything is spawned: stdin has to be a TTY
 * (there is no way to hide input otherwise), the value has to be a Postgres URL, and the
 * host must not look local — if it is local, `pnpm warm` is the command you want.
 */
import { spawn } from "node:child_process";

/** Flags `warm` understands, forwarded one by one. Anything else is refused. */
const VALUE_FLAGS = ["--only", "--max-rounds", "--pause-s"] as const;
const BOOLEAN_FLAGS = ["--check", "--until-ok", "--confirm-remote"] as const;

export class WarmRemoteArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WarmRemoteArgError";
  }
}

/** Everything a warm:remote run needs from the outside world, so it can be tested. */
export type WarmRemoteIo = {
  isTty(): boolean;
  /** Read one line with echo off. The value is never written anywhere. */
  readHidden(prompt: string): Promise<string>;
  /** Run `warm` with this environment and these arguments; resolve its exit code. */
  run(env: NodeJS.ProcessEnv, args: string[]): Promise<number>;
  out(line: string): void;
};

export function validateRemoteConnectionString(
  value: string,
): { ok: true } | { ok: false; reason: string } {
  const raw = value.trim();
  if (!raw) return { ok: false, reason: "empty" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) return { ok: false, reason: "not a Postgres URL" };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, reason: "no host" };
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return { ok: false, reason: "host is local; use pnpm warm for this database" };
  }
  return { ok: true };
}

/**
 * The `warm` arguments this helper forwards. `--confirm-remote` is accepted but dropped,
 * because it is implied here and added back exactly once.
 */
export function forwardedArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if ((BOOLEAN_FLAGS as readonly string[]).includes(token)) {
      if (token !== "--confirm-remote") out.push(token);
      continue;
    }
    if ((VALUE_FLAGS as readonly string[]).includes(token)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new WarmRemoteArgError(`${token} needs a value`);
      out.push(token, value);
      index += 1;
      continue;
    }
    throw new WarmRemoteArgError(`unknown argument "${token}"; warm:remote forwards ${[...BOOLEAN_FLAGS, ...VALUE_FLAGS].join(", ")}`);
  }
  return out;
}

/**
 * The confirmation string is compared exactly, so a stray keystroke cannot pass as a
 * `yes`, and the answer is read with echo off like the connection string.
 */
export function isConfirmation(value: string): boolean {
  return value.trim().toLowerCase() === "yes";
}

export async function runWarmRemote(argv: readonly string[], io: WarmRemoteIo): Promise<number> {
  if (!io.isTty()) {
    io.out("remote warm refused: stdin is not a TTY, so the connection string could not be hidden");
    return 2;
  }

  let args: string[];
  try {
    args = forwardedArgs(argv);
  } catch (error) {
    io.out(error instanceof Error ? error.message : "bad arguments");
    return 2;
  }

  const connection = await io.readHidden("remote database connection string (hidden): ");
  const check = validateRemoteConnectionString(connection);
  if (!check.ok) {
    // The reason only: never the value, not even a length.
    io.out(`remote warm refused: ${check.reason}`);
    return 2;
  }

  io.out("remote");
  const answer = await io.readHidden("type yes to confirm warming that database: ");
  if (!isConfirmation(answer)) {
    io.out("remote warm refused: not confirmed");
    return 2;
  }

  // The string lives in this object and nowhere else: not in the arguments (so not in
  // the shell history or a process listing) and not in the parent's environment.
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: connection };
  return io.run(env, [...args, "--confirm-remote"]);
}

// --- the real I/O -----------------------------------------------------------

/** Read a line with echo off: raw mode, and the characters are never written back. */
async function readHiddenFromTty(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  output.write(prompt);
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve) => {
    let value = "";
    const done = () => {
      input.off("data", onData);
      if (input.isTTY) input.setRawMode(wasRaw);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          done();
          output.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003" || char === "\u0004") {
          // Ctrl-C / Ctrl-D: leave the terminal the way it was found.
          done();
          output.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char < " ") continue;
        value += char;
      }
    };
    input.on("data", onData);
  });
}

function spawnWarm(env: NodeJS.ProcessEnv, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    // `stdio: inherit` keeps the warm's own output (and its prompts) on this terminal.
    const child = spawn("pnpm", ["warm", ...args], { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const code = await runWarmRemote(process.argv.slice(2), {
    isTty: () => process.stdin.isTTY === true,
    readHidden: readHiddenFromTty,
    run: spawnWarm,
    out: (line) => console.log(line),
  });
  process.exit(code);
}

const invoked =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("warm-remote.ts") || process.argv[1].endsWith("warm-remote.js"));
if (invoked) void main();
