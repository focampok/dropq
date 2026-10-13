/**
 * Check context and a small accumulator: a check id can span several scenarios (three
 * presets × two languages), so it is PASS only when every scenario passed.
 */
import type { Browser } from "playwright";
import { Budget, makeResult, type CheckResult, type Cost, type Profile, type Recorder } from "./harness";

export type Ctx = {
  profile: Profile;
  base: string;
  browser: Browser;
  budget: Budget;
  recorder: Recorder;
  log: (line: string) => void;
  /** Local profile only: Qloo build calls recorded by the app since the run started. */
  qlooBuiltSince: (since: number) => Promise<number>;
  /** Qloo calls a live bridge refinement is charged (not persisted by the app). */
  refineQlooEstimate: number;
  runStart: number;
  /** Set once a quota/auth failure makes further LLM work pointless. */
  llmSkipped: string | null;
};

export class Acc {
  private readonly failures: string[] = [];
  private readonly notes: string[] = [];
  private scenarios = 0;
  private skipReason: string | null = null;
  private lastScreenshots: string[] = [];

  constructor(
    readonly id: string,
    readonly name: string,
    readonly cost: Cost,
  ) {}

  fail(message: string): void {
    this.failures.push(message);
  }

  note(message: string): void {
    this.notes.push(message);
  }

  /** One scenario finished without a recorded failure. */
  pass(screenshots?: string[]): void {
    this.scenarios += 1;
    if (screenshots && screenshots.length > 0) this.lastScreenshots = screenshots;
  }

  skip(reason: string): void {
    this.skipReason = reason;
  }

  get failed(): boolean {
    return this.failures.length > 0;
  }

  finish(recorder: Recorder, ms: number): void {
    const status = this.failures.length > 0 ? "FAIL" : this.scenarios === 0 && this.skipReason ? "SKIP" : "PASS";
    const details = [...this.notes];
    for (const failure of this.failures.slice(0, 12)) details.push(`FAIL: ${failure}`);
    if (this.failures.length > 12) details.push(`… ${this.failures.length - 12} more`);
    this.record(recorder, status, ms, details);
  }

  /** A check that could not run at all (no browser, quota, profile). */
  finishSkipped(recorder: Recorder, reason: string): void {
    this.record(recorder, "SKIP", 0, [], reason);
  }

  private record(recorder: Recorder, status: CheckResult["status"], ms: number, details: string[], reason?: string): void {
    const computedReason = status === "SKIP" ? reason ?? this.skipReason ?? "skipped" : undefined;
    recorder.record(
      makeResult({
        id: this.id,
        name: this.name,
        profile: recorder.profile,
        cost: this.cost,
        status,
        ...(computedReason ? { reason: computedReason } : {}),
        ms,
        screenshots: this.lastScreenshots,
        details,
      }),
    );
  }
}
