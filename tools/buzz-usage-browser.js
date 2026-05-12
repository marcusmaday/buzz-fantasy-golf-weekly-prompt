// Buzz Fantasy Golf browser extractor.
// Run this from the browser console while logged in on:
// https://buzzfantasygolf.com/leagues/25119/reports

(async () => {
  const config = {
    teamName: "Shankhopanonymous",
    startsLimit: 4,
    cutoffDate: new Date(),
  };

  const leagueId = location.pathname.match(/\/leagues\/(\d+)/)?.[1];
  if (!leagueId) throw new Error("Open a Buzz league page before running this script.");
  if (!location.pathname.endsWith("/reports")) {
    location.href = `/leagues/${leagueId}/reports`;
    throw new Error("Navigated to reports. Run the extractor again after the page loads.");
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const parseDate = (value) => {
    const [month, day, year] = value.split("/").map(Number);
    return new Date(year, month - 1, day, 23, 59, 59, 999);
  };

  async function waitFor(predicate, label, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = predicate();
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${label}.`);
  }

  function choose(select, label) {
    const option = [...select.options].find((item) => item.text.trim() === label);
    if (!option) throw new Error(`Could not find option: ${label}`);
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function getSchedule() {
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;left:-9999px;width:1200px;height:900px;";
    frame.src = `/leagues/${leagueId}/tournaments`;
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

  const schedule = await getSchedule();
  const selects = await waitFor(() => document.querySelectorAll("select").length >= 1 && document.querySelectorAll("select"), "report controls");
  choose(selects[0], "My Golfers Usage");
  await waitFor(() => [...document.querySelectorAll("select")].some((select) => [...select.options].some((option) => option.text.trim() === config.teamName)), "team selector");

  const usageSelects = document.querySelectorAll("select");
  const teamSelect = [...usageSelects].find((select) => [...select.options].some((option) => option.text.trim() === config.teamName));
  choose(teamSelect, config.teamName);

  const tournamentSelect = [...document.querySelectorAll("select")].find((select) => {
    const labels = [...select.options].map((option) => option.text.trim());
    return schedule.some((event) => labels.includes(event.tournament));
  });
  if (!tournamentSelect) throw new Error("Could not find tournament selector.");

  const cutoff = new Date(config.cutoffDate);
  cutoff.setHours(23, 59, 59, 999);
  const available = new Set([...tournamentSelect.options].map((option) => option.text.trim()));
  const eligible = schedule.filter((event) => available.has(event.tournament) && parseDate(event.date) <= cutoff);

  const counts = new Map();
  const byTournament = [];
  for (const event of eligible) {
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
  const result = {
    generatedAt: new Date().toISOString(),
    leagueId,
    teamName: config.teamName,
    cutoffDate: cutoff.toISOString(),
    sourceUrl: location.href,
    usedGolfers,
    remainingStarts,
    byTournament,
  };

  const markdown = [
    "# Buzz Fantasy Golf Usage",
    "",
    `Team: ${result.teamName}`,
    `League: ${result.leagueId}`,
    `Generated: ${result.generatedAt}`,
    `Counted tournaments through: ${eligible.at(-1)?.tournament ?? "none"}`,
    "",
    "Use this in pick prompts: each golfer can be selected 4 times for the season.",
    "",
    "| Golfer | Starts Used | Starts Remaining |",
    "| --- | ---: | ---: |",
    ...Object.entries(usedGolfers).map(([golfer, starts]) => `| ${golfer} | ${starts} | ${Math.max(0, config.startsLimit - starts)} |`),
    "",
  ].join("\n");

  const bundle = { ...result, markdown };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), {
    href: url,
    download: `buzz-golfer-usage-${new Date().toISOString().slice(0, 10)}.json`,
  });
  link.click();
  URL.revokeObjectURL(url);

  console.table(usedGolfers);
  console.log(markdown);
})();
