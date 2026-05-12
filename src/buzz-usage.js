#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const sessionPath = resolve(rootDir, ".buzz-session.json");
const outputDir = resolve(rootDir, "output");

const args = new Set(process.argv.slice(2));
const debug = args.has("--debug");
const jsonOnly = args.has("--json");

loadDotEnv(resolve(rootDir, ".env"));

const config = {
  baseUrl: env("BFG_BASE_URL", "https://buzzfantasygolf.com").replace(/\/$/, ""),
  email: env("BFG_EMAIL"),
  password: env("BFG_PASSWORD"),
  leagueId: env("BFG_LEAGUE_ID", "25119"),
  teamName: env("BFG_TEAM_NAME", "Shankhopanonymous"),
};

async function main() {
  if (!config.email || !config.password) {
    throw new Error("Set BFG_EMAIL and BFG_PASSWORD in .env or your environment.");
  }

  const jar = CookieJar.load(sessionPath);
  let reportsHtml = await getReportsHtml(jar);

  if (looksLikeLoginPage(reportsHtml)) {
    await login(jar);
    reportsHtml = await getReportsHtml(jar);
  }

  if (looksLikeLoginPage(reportsHtml)) {
    throw new Error("Login did not stick. Check BFG_EMAIL/BFG_PASSWORD or try without Google-only auth.");
  }

  jar.save(sessionPath);

  if (debug) {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(resolve(outputDir, "reports.html"), reportsHtml, "utf8");
  }

  const tables = parseTables(reportsHtml);
  const usage = extractGolferUsage(tables, config.teamName);
  if (!Object.keys(usage).length && /blazor\.server\.js/i.test(reportsHtml)) {
    throw new Error(
      "Buzz rendered the reports with Blazor, so the plain HTTP scraper could not see report rows. Use tools/buzz-usage-browser.js from the logged-in reports page, then run src/context-from-browser-export.js on the exported JSON."
    );
  }
  const result = {
    generatedAt: new Date().toISOString(),
    leagueId: config.leagueId,
    teamName: config.teamName,
    sourceUrl: `${config.baseUrl}/leagues/${config.leagueId}/reports`,
    usedGolfers: usage,
    remainingStarts: Object.fromEntries(
      Object.entries(usage).map(([golfer, starts]) => [golfer, Math.max(0, 4 - starts)])
    ),
    notes: [
      "League rule assumed: each golfer can be used 4 times per season.",
      "Give usedGolfers and remainingStarts to your pick-selection agent.",
    ],
  };

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(resolve(outputDir, "golfer-usage.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(resolve(outputDir, "agent-context.md"), renderMarkdown(result), "utf8");

  if (jsonOnly) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderMarkdown(result));
    console.log(`\nWrote ${resolve(outputDir, "golfer-usage.json")}`);
    console.log(`Wrote ${resolve(outputDir, "agent-context.md")}`);
  }
}

async function getReportsHtml(jar) {
  const url = `${config.baseUrl}/leagues/${config.leagueId}/reports`;
  const response = await request(url, { jar });
  return response.text;
}

async function login(jar) {
  const loginUrl = `${config.baseUrl}/login`;
  const page = await request(loginUrl, { jar });
  const token = match(page.text, /name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/i)
    ?? match(page.text, /value="([^"]+)"\s+name="__RequestVerificationToken"/i);

  if (!token) {
    throw new Error("Could not find the login anti-forgery token.");
  }

  const body = new URLSearchParams({
    Email: config.email,
    Password: config.password,
    RememberMe: "true",
    __RequestVerificationToken: token,
  });

  const response = await request(loginUrl, {
    jar,
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      referer: loginUrl,
      origin: config.baseUrl,
    },
    redirect: "manual",
  });

  if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
    await request(new URL(response.headers.get("location"), config.baseUrl), { jar });
  }
}

async function request(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("user-agent", "buzz-golf-usage/0.1");
  headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");

  const cookie = options.jar?.header(new URL(url).hostname);
  if (cookie) headers.set("cookie", cookie);

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body,
    redirect: options.redirect ?? "follow",
  });

  options.jar?.store(response.headers.getSetCookie?.() ?? splitCombinedSetCookie(response.headers.get("set-cookie")));
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

function parseTables(html) {
  const tables = [];
  for (const tableHtml of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const rows = [];
    for (const rowHtml of tableHtml[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
      const cells = [];
      for (const cellHtml of rowHtml[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        cells.push(cleanText(cellHtml[1]));
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function extractGolferUsage(tables, teamName) {
  const counts = new Map();
  const normalizedTeam = normalize(teamName);

  for (const table of tables) {
    const headers = table[0]?.map(normalize) ?? [];
    const golferColumns = headers
      .map((header, index) => ({ header, index }))
      .filter(({ header }) => /golfer|player|pick|selection|entrant/.test(header));

    for (const row of table.slice(1)) {
      if (!row.some((cell) => normalize(cell).includes(normalizedTeam))) continue;

      const candidateCells = golferColumns.length
        ? golferColumns.map(({ index }) => row[index]).filter(Boolean)
        : row.filter((cell) => normalize(cell) !== normalizedTeam);

      for (const cell of candidateCells) {
        for (const golfer of splitGolfers(cell)) {
          if (isLikelyGolferName(golfer, teamName)) {
            counts.set(golfer, (counts.get(golfer) ?? 0) + 1);
          }
        }
      }
    }
  }

  return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function splitGolfers(text) {
  return cleanText(text)
    .split(/\s*(?:,|;|\||\/|\n|\r| {2,})\s*/g)
    .map((part) => part.replace(/\s+\$[\d,]+(?:\.\d{2})?$/, "").trim())
    .filter(Boolean);
}

function isLikelyGolferName(value, teamName) {
  if (!value || normalize(value).includes(normalize(teamName))) return false;
  if (/^\$?[\d,.%+-]+$/.test(value)) return false;
  if (/^(total|rank|place|points|earnings|week|event|tournament|team|owner)$/i.test(value)) return false;
  return /\b[A-Z][a-z'.-]+\b\s+\b[A-Z][a-z'.-]+\b/.test(value);
}

function renderMarkdown(result) {
  const rows = Object.entries(result.usedGolfers);
  const lines = [
    `# Buzz Fantasy Golf Usage`,
    ``,
    `Team: ${result.teamName}`,
    `League: ${result.leagueId}`,
    `Generated: ${result.generatedAt}`,
    ``,
    `Use this in pick prompts: each golfer can be selected 4 times for the season.`,
    ``,
    `| Golfer | Starts Used | Starts Remaining |`,
    `| --- | ---: | ---: |`,
  ];

  if (!rows.length) {
    lines.push(`| No golfers detected | 0 | 4 |`);
  } else {
    for (const [golfer, starts] of rows) {
      lines.push(`| ${golfer} | ${starts} | ${Math.max(0, 4 - starts)} |`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function looksLikeLoginPage(html) {
  return /<form[^>]+id="account"/i.test(html) || /name="Password"/i.test(html);
}

function cleanText(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value) {
  return cleanText(String(value)).toLowerCase();
}

function match(text, regex) {
  return regex.exec(text)?.[1] ?? null;
}

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function splitCombinedSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,]+=)/g);
}

class CookieJar {
  constructor(cookies = {}) {
    this.cookies = cookies;
  }

  static load(path) {
    if (!existsSync(path)) return new CookieJar();
    try {
      return new CookieJar(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return new CookieJar();
    }
  }

  store(setCookies) {
    for (const setCookie of setCookies) {
      const [pair] = setCookie.split(";");
      const index = pair.indexOf("=");
      if (index === -1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (name) this.cookies[name] = value;
    }
  }

  header() {
    return Object.entries(this.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  save(path) {
    writeFileSync(path, `${JSON.stringify(this.cookies, null, 2)}\n`, "utf8");
  }
}

main().catch((error) => {
  console.error(`Buzz usage failed: ${error.message}`);
  if (debug && error.stack) console.error(error.stack);
  process.exitCode = 1;
});
