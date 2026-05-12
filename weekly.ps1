$ErrorActionPreference = "Stop"

$node = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin\node.exe"
$script = Join-Path $PSScriptRoot "src\weekly.js"

if (-not (Test-Path $node)) {
    throw "Could not find Codex's bundled Node at $node. Install Node.js or run this from Codex."
}

& $node $script
