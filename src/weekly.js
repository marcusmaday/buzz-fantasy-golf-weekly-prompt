#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const outputDir = resolve(rootDir, "output");
const promptTemplatePath = resolve(rootDir, "prompts", "weekly-pick-agent.md");
const profileDir = resolve(outputDir, "browser-profile");
const usagePath = resolve(outputDir, "golfer-usage.json");
const schedulePath = resolve(outputDir, "tournament-schedule.json");
const weeklyPromptPath = resolve(outputDir, "weekly-agent-prompt.md");

loadDotEnv(resolve(rootDir, ".env"));

const config = {
  baseUrl: env("BFG_BASE_URL", "https://buzzfantasygolf.com").replace(/\/$/, ""),
  email: env("BFG_EMAIL"),
  password: env("BFG_PASSWORD"),
  leagueId: env("BFG_LEAGUE_ID", "25119"),
  teamName: env("BFG_TEAM_NAME", "Shankhopanonymous"),
  startsLimit: Number(env("BFG_STARTS_LIMIT", "4")),
};

main().catch((error) => {
  console.error(`Weekly prompt failed: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  console.log("Refreshing Buzz usage and weekly prompt...");
  if (!config.email || !config.password) {
    throw new Error("Set BFG_EMAIL and BFG_PASSWORD in .env or your environment.");
  }

  mkdirSync(outputDir, { recursive: true });
  const browserPath = findBrowserPath();
  const port = await findFreePort();
  const browser = launchBrowser(browserPath, port);
  let page;

  try {
    const cdp = await connectToBrowser(port);
    page = await cdp.newPage(`${config.baseUrl}/login`);

    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.waitFor("document.readyState !== 'loading'");
    await page.waitFor("document.querySelector('input[name=\"Password\"]') || document.body.innerText.includes('Dashboard')", 30000);

    const loggedIn = await page.evaluate("!document.querySelector('input[name=\"Password\"]')");
    if (!loggedIn) {
      await login(page);
    }

    await page.navigate(`${config.baseUrl}/leagues/${config.leagueId}/reports`);
    await page.waitFor("document.readyState !== 'loading'");
    await page.waitFor("document.querySelectorAll('select').length > 0 && document.body.innerText.includes('League Reports')", 60000);

    const result = await page.evaluate(`(${extractUsageInBrowser.toString()})(${JSON.stringify({
      leagueId: config.leagueId,
      teamName: config.teamName,
      startsLimit: config.startsLimit,
    })})`, { awaitPromise: true, timeoutMs: 120000 });

    const prompt = buildWeeklyPrompt(result);
    writeFileSync(schedulePath, `${JSON.stringify(result.schedule, null, 2)}\n`, "utf8");
    writeFileSync(usagePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    writeFileSync(resolve(outputDir, "agent-context.md"), `${result.markdown}\n`, "utf8");
    writeFileSync(weeklyPromptPath, prompt, "utf8");

    console.log(`Wrote ${weeklyPromptPath}`);
    console.log(`Inferred tournament: ${result.currentTournament.tournament} (${result.currentTournament.date})`);
    console.log(`Counted through: ${result.countedThrough}`);
  } catch (error) {
    if (page) await saveBrowserDebug(page);
    throw error;
  } finally {
    browser.kill();
  }
}

async function saveBrowserDebug(page) {
  try {
    const state = await page.evaluate(`({
      url: location.href,
      title: document.title,
      text: document.body?.innerText?.slice(0, 4000) ?? "",
      html: document.documentElement?.outerHTML ?? ""
    })`, { timeoutMs: 5000 });
    writeFileSync(resolve(outputDir, "weekly-debug.json"), `${JSON.stringify({
      url: state.url,
      title: state.title,
      text: state.text,
    }, null, 2)}\n`, "utf8");
    writeFileSync(resolve(outputDir, "weekly-debug.html"), state.html, "utf8");
    console.error(`Saved debug page state to ${resolve(outputDir, "weekly-debug.json")}`);
  } catch {
    // Diagnostics should not mask the original failure.
  }
}

async function login(page) {
  await page.waitFor("document.querySelector('input[name=\"Email\"]') && document.querySelector('input[name=\"Password\"]')");
  const loginResult = await page.evaluate(`(async () => {
    const email = ${JSON.stringify(config.email)};
    const password = ${JSON.stringify(config.password)};
    const form = document.querySelector('form');
    const body = new URLSearchParams(new FormData(form));
    body.set('Email', email);
    body.set('Password', password);
    body.set('RememberMe', 'true');
    const response = await fetch(location.href, {
      method: 'POST',
      body,
      credentials: 'include',
      redirect: 'follow',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    const html = await response.text();
    return {
      ok: response.ok,
      url: response.url,
      loginPage: /name=["']Password["']/i.test(html),
      validation: /validation-message[\\s\\S]{0,500}/i.exec(html)?.[0] ?? ''
    };
  })()`, { awaitPromise: true, timeoutMs: 30000 });

  if (!loginResult?.ok || loginResult.loginPage) {
    throw new Error("Buzz login did not complete. Check the credentials in .env.");
  }
  console.log(`Buzz login response accepted: ${loginResult.url}`);
}

function buildWeeklyPrompt(result) {
  const agentInstructions = readFileSync(promptTemplatePath, "utf8").trim();
  return [
    "# Weekly Fantasy Golf Pick Request",
    "",
    "Paste everything below into the pick agent.",
    "",
    "## My Current Usage Context",
    "",
    result.markdown.trim(),
    "",
    "# Current Week Inputs",
    "",
    `Tournament: ${result.currentTournament.tournament}`,
    `Tournament date/week: ${result.currentTournament.date}`,
    `Schedule inference: ${result.currentTournament.reason}`,
    "",
    "Current field:",
    "[tell the agent to verify the current-year field before recommending picks]",
    "",
    "Odds / weather / injury / withdrawal / ownership notes:",
    "[leave blank unless you have current notes; require the agent to verify current data]",
    "",
    "## Agent Instructions",
    "",
    agentInstructions,
    "",
  ].join("\n");
}

function launchBrowser(browserPath, port) {
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });

  const child = spawn(browserPath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child;
}

async function connectToBrowser(port) {
  const version = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!response.ok) throw new Error(`DevTools not ready: ${response.status}`);
    return response.json();
  }, 10000);

  return {
    async newPage(url) {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
      if (!response.ok) throw new Error(`Could not open browser tab: ${response.status}`);
      const target = await response.json();
      return new CdpPage(target.webSocketDebuggerUrl ?? version.webSocketDebuggerUrl);
    },
  };
}

class CdpPage {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.socket = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (message) => {
      const payload = JSON.parse(message.data);
      if (payload.id && this.pending.has(payload.id)) {
        const { resolve: ok, reject } = this.pending.get(payload.id);
        this.pending.delete(payload.id);
        payload.error ? reject(new Error(payload.error.message)) : ok(payload.result);
      } else {
        this.events.push(payload);
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState !== 'loading'", 30000);
  }

  async evaluate(expression, options = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: options.awaitPromise ?? false,
      returnByValue: true,
      timeout: options.timeoutMs ?? 30000,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Browser evaluation failed.");
    }
    return result.result?.value;
  }

  async waitFor(expression, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        if (await this.evaluate(`Boolean(${expression})`, { timeoutMs: 5000 })) return true;
      } catch {
        // Keep polling while the page is changing.
      }
      await sleep(250);
    }
    throw new Error(`Timed out waiting for browser condition: ${expression}`);
  }
}

async function extractUsageInBrowser(config) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const parseDateEnd = (value) => {
    const [month, day, year] = value.split("/").map(Number);
    return new Date(year, month - 1, day, 23, 59, 59, 999);
  };
  const parseDateStart = (value) => {
    const [month, day, year] = value.split("/").map(Number);
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  };
  const startOfDay = (value) => {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date;
  };
  const waitFor = async (predicate, label, timeoutMs = 30000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = predicate();
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${label}.`);
  };
  const choose = (select, label) => {
    const option = [...select.options].find((item) => item.text.trim() === label);
    if (!option) throw new Error(`Could not find option: ${label}`);
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };

  async function getSchedule() {
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;left:-9999px;width:1200px;height:900px;";
    frame.src = `/leagues/${config.leagueId}/tournaments`;
    document.body.appendChild(frame);
    await waitFor(() => frame.contentDocument?.querySelector("table tbody tr"), "schedule rows");

    const rows = [...frame.contentDocument.querySelectorAll("table tbody tr")];
    const schedule = rows.map((row) => {
      const cells = [...row.cells].map(text);
      return cells.length >= 2 ? { date: cells[0], tournament: cells[1] } : null;
    }).filter(Boolean);

    frame.remove();
    return schedule;
  }

  function inferTournament(schedule) {
    const dated = schedule
      .map((event) => ({ ...event, parsedDate: parseDateEnd(event.date), startDate: parseDateStart(event.date) }))
      .sort((a, b) => a.parsedDate - b.parsedDate);
    const todayStart = startOfDay(new Date());
    const upcoming = dated.find((event) => event.startDate >= todayStart);
    if (upcoming) {
      const daysUntil = Math.round((upcoming.startDate - todayStart) / 86400000);
      return {
        tournament: upcoming.tournament,
        date: upcoming.date,
        reason: daysUntil === 0
          ? "selected because it starts today according to the Buzz schedule"
          : "selected as the next upcoming tournament on the Buzz schedule",
      };
    }
    const last = dated.at(-1);
    return {
      tournament: last.tournament,
      date: last.date,
      reason: "selected as the final tournament on the Buzz schedule because no future tournament remains",
    };
  }

  const schedule = await getSchedule();
  const currentTournament = inferTournament(schedule);
  const currentStart = parseDateStart(currentTournament.date);
  const countable = schedule.filter((event) => parseDateStart(event.date) < currentStart);

  await waitFor(() => document.querySelectorAll("select").length >= 1, "report selector");
  choose(document.querySelectorAll("select")[0], "My Golfers Usage");
  await waitFor(() => [...document.querySelectorAll("select")].some((select) => [...select.options].some((option) => option.text.trim() === config.teamName)), "team selector");

  const teamSelect = [...document.querySelectorAll("select")].find((select) => [...select.options].some((option) => option.text.trim() === config.teamName));
  choose(teamSelect, config.teamName);

  const tournamentSelect = [...document.querySelectorAll("select")].find((select) => {
    const labels = [...select.options].map((option) => option.text.trim());
    return schedule.some((event) => labels.includes(event.tournament));
  });
  if (!tournamentSelect) throw new Error("Could not find tournament selector.");

  const counts = new Map();
  const byTournament = [];
  for (const event of countable) {
    choose(tournamentSelect, event.tournament);
    await sleep(800);
    const golfers = [...document.querySelectorAll("table tbody tr")].map((row) => {
      const cells = [...row.cells].map(text);
      return cells[0] || "";
    }).filter(Boolean);

    byTournament.push({ ...event, golfers });
    for (const golfer of golfers) counts.set(golfer, (counts.get(golfer) ?? 0) + 1);
  }

  const usedGolfers = Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  const remainingStarts = Object.fromEntries(
    Object.entries(usedGolfers).map(([golfer, starts]) => [golfer, Math.max(0, config.startsLimit - starts)])
  );
  const countedThrough = byTournament.at(-1)?.tournament ?? "none";
  const generatedAt = new Date().toISOString();
  const markdown = [
    "# Buzz Fantasy Golf Usage",
    "",
    `Team: ${config.teamName}`,
    `League: ${config.leagueId}`,
    `Generated: ${generatedAt}`,
    `Counted tournaments through: ${countedThrough}`,
    "",
    `Use this in pick prompts: each golfer can be selected ${config.startsLimit} times for the season.`,
    "",
    "| Golfer | Starts Used | Starts Remaining |",
    "| --- | ---: | ---: |",
    ...Object.entries(usedGolfers).map(([golfer, starts]) => `| ${golfer} | ${starts} | ${Math.max(0, config.startsLimit - starts)} |`),
  ].join("\n");

  return {
    generatedAt,
    leagueId: config.leagueId,
    teamName: config.teamName,
    sourceUrl: location.href,
    currentTournament,
    countedThrough,
    schedule,
    usedGolfers,
    remainingStarts,
    byTournament,
    markdown,
  };
}

function findBrowserPath() {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error("Could not find Edge or Chrome.");
  return found;
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function retry(fn, timeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw lastError ?? new Error("Timed out.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
