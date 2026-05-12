#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

loadDotEnv(resolve(".env"));

const token = process.env.GITHUB_TOKEN;
const repoName = process.env.GITHUB_REPO || "buzz-fantasy-golf-weekly-prompt";
const privateRepo = String(process.env.GITHUB_PRIVATE ?? "true").toLowerCase() !== "false";
const description = process.env.GITHUB_DESCRIPTION || "Weekly Buzz Fantasy Golf usage extractor and pick-agent prompt builder.";

const files = [
  ".env.example",
  ".gitignore",
  "README.md",
  "package.json",
  "weekly.cmd",
  "weekly.ps1",
  "prompts/weekly-pick-agent.md",
  "src/build-weekly-prompt.js",
  "src/buzz-usage.js",
  "src/context-from-browser-export.js",
  "src/publish-github.js",
  "src/weekly.js",
  "tools/buzz-usage-browser.js",
];

main().catch((error) => {
  console.error(`GitHub publish failed: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  if (!token) {
    throw new Error("Set GITHUB_TOKEN in .env before publishing.");
  }

  const user = await github("/user");
  const owner = process.env.GITHUB_OWNER || user.login;
  const repo = await ensureRepo(owner, repoName);

  for (const file of files) {
    if (!existsSync(resolve(file))) continue;
    await uploadFile(owner, repo.name, file);
    console.log(`Uploaded ${file}`);
  }

  console.log(`\nRepository ready: ${repo.html_url}`);
}

async function ensureRepo(owner, name) {
  const existing = await github(`/repos/${owner}/${name}`, { tolerate404: true });
  if (existing) {
    console.log(`Using existing repository: ${existing.html_url}`);
    return existing;
  }

  console.log(`Creating ${privateRepo ? "private" : "public"} repository: ${name}`);
  return github("/user/repos", {
    method: "POST",
    body: {
      name,
      private: privateRepo,
      description,
      auto_init: false,
    },
  });
}

async function uploadFile(owner, repo, file) {
  const path = file.replace(/\\/g, "/");
  const existing = await github(`/repos/${owner}/${repo}/contents/${encodeURIComponentPath(path)}`, { tolerate404: true });
  const content = readFileSync(resolve(file)).toString("base64");
  await github(`/repos/${owner}/${repo}/contents/${encodeURIComponentPath(path)}`, {
    method: "PUT",
    body: {
      message: existing ? `Update ${path}` : `Add ${path}`,
      content,
      ...(existing?.sha ? { sha: existing.sha } : {}),
    },
  });
}

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method: options.method || "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "buzz-fantasy-golf-publisher",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (options.tolerate404 && response.status === 404) return null;

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${data?.message || text}`);
  }
  return data;
}

function encodeURIComponentPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
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
