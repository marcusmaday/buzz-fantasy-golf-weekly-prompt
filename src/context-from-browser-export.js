#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const inputArg = process.argv.find((arg) => !arg.startsWith("--") && arg !== process.argv[1] && arg !== process.argv[0]);
const cutoffArg = process.argv.find((arg) => arg.startsWith("--cutoff="))?.split("=")[1];
const inputPath = resolve(inputArg ?? "output/browser-golfer-usage.json");
const outputDir = resolve("output");
const data = JSON.parse(readFileSync(inputPath, "utf8"));
const schedulePath = resolve("output/tournament-schedule.json");

if (existsSync(schedulePath) && data.byTournament?.length) {
  applyScheduleCutoff(data, JSON.parse(readFileSync(schedulePath, "utf8")), cutoffArg ? new Date(cutoffArg) : new Date());
}

const markdown = data.markdown ?? renderMarkdown(data);
mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, "golfer-usage.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
writeFileSync(resolve(outputDir, "agent-context.md"), markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
console.log(markdown);

function renderMarkdown(data) {
  const rows = Object.entries(data.usedGolfers ?? {});
  return [
    "# Buzz Fantasy Golf Usage",
    "",
    `Team: ${data.teamName}`,
    `League: ${data.leagueId}`,
    `Generated: ${data.generatedAt}`,
    data.countedThrough ? `Counted tournaments through: ${data.countedThrough}` : "",
    "",
    "Use this in pick prompts: each golfer can be selected 4 times for the season.",
    "",
    "| Golfer | Starts Used | Starts Remaining |",
    "| --- | ---: | ---: |",
    ...rows.map(([golfer, starts]) => `| ${golfer} | ${starts} | ${Math.max(0, 4 - starts)} |`),
    "",
  ].join("\n");
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

function parseUsDate(value) {
  const [month, day, year] = value.split("/").map(Number);
  return new Date(year, month - 1, day, 23, 59, 59, 999);
}
