/**
 * summary.json + report.html. The HTML references the screenshots with relative paths, so
 * the `docs/e2e/` folder is portable and nothing needs the network.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { E2E_ROOT, writeJson, writeText, type CheckResult, type Profile } from "./harness";

export type Summary = {
  profile: Profile;
  base: string;
  startedAt: string;
  finishedAt: string;
  ms: number;
  budget: { gemini: number; qloo: number; qlooBuilt: number; qlooOther: number; geminiMax: number; qlooMax: number };
  totals: { pass: number; fail: number; skip: number };
  checks: CheckResult[];
};

export function buildSummary(input: Omit<Summary, "totals">): Summary {
  const totals = { pass: 0, fail: 0, skip: 0 };
  for (const check of input.checks) {
    if (check.status === "PASS") totals.pass += 1;
    else if (check.status === "FAIL") totals.fail += 1;
    else totals.skip += 1;
  }
  return { ...input, totals };
}

export async function writeSummary(summary: Summary): Promise<void> {
  await writeJson(path.join(E2E_ROOT, "summary.json"), summary);
}

export async function writeReportHtml(summary: Summary): Promise<string> {
  const file = path.join(E2E_ROOT, "report.html");
  await writeText(file, renderHtml(summary));
  return file;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusClass(status: string): string {
  return status === "PASS" ? "pass" : status === "FAIL" ? "fail" : "skip";
}

function thumbnail(shot: string): string {
  const relative = path.relative(E2E_ROOT, shot).split(path.sep).join("/");
  const name = path.basename(shot);
  if (!existsSync(shot)) return `<span class="missing">${escapeHtml(name)}</span>`;
  return `<a href="${escapeHtml(relative)}" target="_blank"><img src="${escapeHtml(relative)}" alt="${escapeHtml(name)}" loading="lazy"></a>`;
}

export function renderHtml(summary: Summary): string {
  const rows = summary.checks
    .map((check) => {
      const shots = check.screenshots.slice(0, 4).map(thumbnail).join(" ");
      const more = check.screenshots.length > 4 ? ` <span class="more">+${check.screenshots.length - 4} more</span>` : "";
      const details = check.details.length
        ? `<ul>${check.details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>`
        : "";
      return `<tr>
        <td class="id">${escapeHtml(check.id)}</td>
        <td>${escapeHtml(check.name)}<div class="meta">${escapeHtml(check.profile)} · ${escapeHtml(check.cost)}</div></td>
        <td class="status ${statusClass(check.status)}">${check.status}${check.reason ? ` <span class="reason">${escapeHtml(check.reason)}</span>` : ""}</td>
        <td class="ms">${check.ms > 0 ? `${check.ms} ms` : "—"}</td>
        <td class="shots">${shots}${more}${details}</td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DropQ e2e report — ${escapeHtml(summary.profile)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.45 system-ui, sans-serif; margin: 0; padding: 24px; background: Canvas; color: CanvasText; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { opacity: .7; margin-bottom: 16px; }
  .totals { display: flex; gap: 16px; margin: 12px 0 20px; flex-wrap: wrap; }
  .totals div { border: 1px solid rgba(128,128,128,.4); border-radius: 8px; padding: 8px 14px; }
  .totals b { font-size: 20px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; vertical-align: top; border-bottom: 1px solid rgba(128,128,128,.25); padding: 8px 10px; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; opacity: .7; }
  .id { font-family: ui-monospace, monospace; white-space: nowrap; }
  .meta { font-size: 11px; opacity: .6; }
  .status { font-weight: 700; white-space: nowrap; }
  .status.pass { color: #14804a; }
  .status.fail { color: #b3261e; }
  .status.skip { color: #8a6d00; }
  .reason { font-weight: 400; opacity: .8; }
  .ms { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .shots img { height: 60px; border: 1px solid rgba(128,128,128,.4); border-radius: 4px; margin-right: 4px; }
  .missing { font-size: 11px; opacity: .5; }
  .more { font-size: 11px; opacity: .6; }
  ul { margin: 6px 0 0; padding-left: 18px; font-size: 12px; }
  li { margin: 1px 0; }
</style>
</head>
<body>
<h1>DropQ end-to-end report</h1>
<div class="sub">
  profile <b>${escapeHtml(summary.profile)}</b> · base <code>${escapeHtml(summary.base)}</code><br>
  ${escapeHtml(summary.startedAt)} → ${escapeHtml(summary.finishedAt)} (${summary.ms} ms)<br>
  budget: gemini ${summary.budget.gemini}/${summary.budget.geminiMax}, qloo ${summary.budget.qloo}/${summary.budget.qlooMax}
  (built ${summary.budget.qlooBuilt}, estimated ${summary.budget.qlooOther})
</div>
<div class="totals">
  <div><b class="status pass">${summary.totals.pass}</b> PASS</div>
  <div><b class="status fail">${summary.totals.fail}</b> FAIL</div>
  <div><b class="status skip">${summary.totals.skip}</b> SKIP</div>
</div>
<table>
<thead><tr><th>id</th><th>check</th><th>status</th><th>time</th><th>evidence</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p class="sub">A SKIP is never a pass. Screenshots live in <code>screenshots/</code> next to this file.</p>
</body>
</html>
`;
}
