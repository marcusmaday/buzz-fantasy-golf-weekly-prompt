#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const outputDir = resolve(rootDir, "output");
const promptTemplatePath = resolve(rootDir, "prompts", "weekly-pick-agent.md");
const schedulePath = resolve(outputDir, "tournament-schedule.json");
const outputPath = resolve(outputDir, "weekly-agent-prompt.md");

loadDotEnv(resolve(rootDir, ".env"));

const options = parseArgs(process.argv.slice(2));
const usagePath = resolveUsagePath(options.usage);
const usage = JSON.parse(readFileSync(usagePath, "utf8"));
const schedule = existsSync(schedulePath) ? JSON.parse(readFileSync(schedulePath, "utf8")) : [];

if (schedule.length && usage.byTournament?.length) {
  applyScheduleCutoff(usage, schedule, options.cutoff ? new Date(options.cutoff) : new Date());
}

const agentInstructions = readFileSync(promptTemplatePath, "utf8").trim();
const usageMarkdown = usage.markdown ?? renderUsageMarkdown(usage);
const inferredTournament = inferTournament(schedule, options.cutoff ? new Date(options.cutoff) : new Date());
const weeklyPrompt = renderWeeklyPrompt({
  agentInstructions,
  usageMarkdown,
  usagePath,
  tournament: options.tournament ?? inferredTournament?.tournament,
  date: options.date ?? inferredTournament?.date,
  inferredTournament,
  fieldPath: options.field,
  notesPath: options.notes,
});

mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, "agent-context.md"), usageMarkdown.endsWith("\n") ? usageMarkdown : `${usageMarkdown}\n`, "utf8");
writeFileSync(resolve(outputDir, "golfer-usage.json"), `${JSON.stringify(usage, null, 2)}\n`, "utf8");
writeFileSync(outputPath, weeklyPrompt, "utf8");

console.log(`Wrote ${outputPath}`);
console.log(`Usage source: ${usagePath}`);
if (usage.countedThrough) console.log(`Counted through: ${usage.countedThrough}`);
if (!options.tournament && inferredTournament) {
  console.log(`Inferred tournament: ${inferredTournament.tournament} (${inferredTournament.date})`);
}

function renderWeeklyPrompt({ agentInstructions, usageMarkdown, usagePath, tournament, date, inferredTournament, fieldPath, notesPath }) {
  const currentWeek = [
    "# Current Week Inputs",
    "",
    `Tournament: ${tournament ?? "[fill in current tournament]"}`,
    `Tournament date/week: ${date ?? "[fill in current tournament date]"}`,
    inferredTournament && !fieldPath ? `Schedule inference: ${inferredTournament.reason}` : "",
    "",
    "Current field:",
    fieldPath ? readOptionalFile(fieldPath) : "[paste current-year field or tell the agent to verify the current field before recommending picks]",
    "",
    "Odds / weather / injury / withdrawal / ownership notes:",
    notesPath ? readOptionalFile(notesPath) : "[paste any current notes here, or leave blank and require the agent to research/verify current data]",
    "",
  ].filter((line, index, all) => line || all[index - 1] !== "").join("\n");

  return [
    "# Weekly Fantasy Golf Pick Request",
    "",
    "Paste everything below into the pick agent.",
    "",
    "## My Current Usage Context",
    "",
    `Usage source file: ${usagePath}`,
    "",
    usageMarkdown.trim(),
    "",
    currentWeek.trim(),
    "",
    "## Agent Instructions",
    "",
    agentInstructions,
    "",
  ].join("\n");
}

function renderUsageMarkdown(data) {
  const rows = Object.entries(data.usedGolfers ?? {});
  return [
    "# Buzz Fantasy Golf Usage",
    "",
    `Team: ${data.teamName ?? env("BFG_TEAM_NAME", "Shankhopanonymous")}`,
    `League: ${data.leagueId ?? env("BFG_LEAGUE_ID", "25119")}`,
    `Generated: ${data.generatedAt ?? new Date().toISOString()}`,
    data.countedThrough ? `Counted tournaments through: ${data.countedThrough}` : "",
    "",
    "Use this in pick prompts: each golfer can be selected 4 times for the season.",
    "",
    "| Golfer | Starts Used | Starts Remaining |",
    "| --- | ---: | ---: |",
    ...rows.map(([golfer, starts]) => `| ${golfer} | ${starts} | ${Math.max(0, 4 - Number(starts))} |`),
    "",
  ].filter((line, index, all) => line || all[index - 1] !== "").join("\n");
}

function applyScheduleCutoff(data, schedule, cutoff) {
  cutoff.setHours(23, 59, 59, 999);
  const dateByTournament = Object.fromEntries(schedule.map((event) => [event.tournament, event.date]));
  const counted = data.byTournament
    .filter((event) => dateByTournament[event.tournament] && parseUsDate(dateByTournament[event.tournament]) <= cutoff)
    .map((event) => ({ date: dateByTournament[event.tournament], ...event }));

  const counts = new Map();
  for (const event of counted) {
    for (const golfer of event.golfers ?? []) {
      counts.set(golfer, (counts.get(golfer) ?? 0) + 1);
    }
  }

  data.cutoffDate = cutoff.toISOString();
  data.countedThrough = counted.at(-1)?.tournament ?? null;
  data.byTournament = counted;
  data.usedGolfers = Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  data.remainingStarts = Object.fromEntries(
    Object.entries(data.usedGolfers).map(([golfer, starts]) => [golfer, Math.max(0, 4 - starts)])
  );
  delete data.markdown;
}

function resolveUsagePath(explicitPath) {
  if (explicitPath) {
    const fullPath = resolve(rootDir, explicitPath);
    if (!existsSync(fullPath)) throw new Error(`Usage file not found: ${fullPath}`);
    return fullPath;
  }

  const candidates = [
    resolve(outputDir, "browser-golfer-usage.json"),
    resolve(outputDir, "golfer-usage.json"),
    ...findDownloadsExports(),
  ].filter(existsSync);

  if (!candidates.length) {
    throw new Error("No usage export found. Run the browser extractor first, then run npm run weekly.");
  }

  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function inferTournament(schedule, today) {
  if (!schedule.length) return null;

  const dated = schedule
    .map((event) => ({ ...event, parsedDate: parseUsDate(event.date), startDate: parseUsDateStart(event.date) }))
    .sort((a, b) => a.parsedDate - b.parsedDate);

  const todayEnd = new Date(today);
  todayEnd.setHours(23, 59, 59, 999);
  const todayStart = startOfDay(today);

  const upcoming = dated.find((event) => event.startDate >= todayStart);
  if (upcoming) {
    const previous = dated[dated.indexOf(upcoming) - 1];
    const daysUntil = Math.round((upcoming.startDate - todayStart) / 86_400_000);
    return {
      tournament: upcoming.tournament,
      date: upcoming.date,
      reason: daysUntil === 0
        ? "selected because it starts today according to the Buzz schedule"
        : "selected as the next upcoming tournament on the Buzz schedule",
      previousTournament: previous?.tournament ?? null,
    };
  }

  const last = dated.at(-1);
  return {
    tournament: last.tournament,
    date: last.date,
    reason: "selected as the final tournament on the Buzz schedule because no future tournament remains",
    previousTournament: dated.at(-2)?.tournament ?? null,
  };
}

function findDownloadsExports() {
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) return [];
  const downloads = join(userProfile, "Downloads");
  if (!existsSync(downloads)) return [];

  return readdirSync(downloads)
    .filter((name) => /^buzz-golfer-usage-\d{4}-\d{2}-\d{2}\.json$/i.test(name))
    .map((name) => join(downloads, name));
}

function readOptionalFile(path) {
  const fullPath = resolve(rootDir, path);
  if (!existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);
  return readFileSync(fullPath, "utf8").trim() || "[file was empty]";
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--usage=")) options.usage = arg.slice("--usage=".length);
    else if (arg === "--usage") options.usage = args[++index];
    else if (arg.startsWith("--tournament=")) options.tournament = arg.slice("--tournament=".length);
    else if (arg === "--tournament") options.tournament = args[++index];
    else if (arg.startsWith("--date=")) options.date = arg.slice("--date=".length);
    else if (arg === "--date") options.date = args[++index];
    else if (arg.startsWith("--cutoff=")) options.cutoff = arg.slice("--cutoff=".length);
    else if (arg === "--cutoff") options.cutoff = args[++index];
    else if (arg.startsWith("--field=")) options.field = arg.slice("--field=".length);
    else if (arg === "--field") options.field = args[++index];
    else if (arg.startsWith("--notes=")) options.notes = arg.slice("--notes=".length);
    else if (arg === "--notes") options.notes = args[++index];
    else if (!options.usage && arg.endsWith(".json")) options.usage = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function parseUsDate(value) {
  const [month, day, year] = value.split("/").map(Number);
  return new Date(year, month - 1, day, 23, 59, 59, 999);
}

function parseUsDateStart(value) {
  const [month, day, year] = value.split("/").map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function env(name, fallback = "") {
  return process.env[name] || fallback;
}
