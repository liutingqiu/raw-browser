param(
  [ValidateSet("edge", "chrome", "both")]
  [string]$Browser = "both",
  [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $repo "edge-bridge\extension"
$project = Join-Path $repo "edge-bridge\host\RawEdgeBridge.csproj"
$installRoot = Join-Path $env:USERPROFILE ".raw\edge-bridge"
$publish = Join-Path $installRoot ("host-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$configDir = Join-Path $env:USERPROFILE ".raw"
$expectedExtensionId = "gfpadofoapicldopjkghnfbnbkljihmk"
$hostName = "com.raw.edge_bridge"

function Write-JsonWithoutBom([string]$Path, $Value, [int]$Depth = 8) {
  $json = $Value | ConvertTo-Json -Depth $Depth
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function New-Token {
  $bytes = [byte[]]::new(32)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Ensure-BridgeConfig([string]$Path, [int]$Port) {
  if (Test-Path -LiteralPath $Path) {
    $existing = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($existing.token -and $existing.port) { return $existing }
  }
  $config = [pscustomobject]@{ version = 1; token = (New-Token); port = $Port }
  Write-JsonWithoutBom $Path $config
  return $config
}

function Get-ExtensionId([string]$ManifestPath) {
  $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  if (-not $manifest.key) { throw "extension manifest has no key; the extension id would change on every load" }
  $der = [Convert]::FromBase64String($manifest.key)
  $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($der)
  $hex = (($hash[0..15] | ForEach-Object { $_.ToString("x2") }) -join "")
  return (-join ($hex.ToCharArray() | ForEach-Object { [char](97 + [Convert]::ToInt32([string]$_, 16)) }))
}

$extensionId = Get-ExtensionId (Join-Path $extension "manifest.json")
if ($extensionId -ne $expectedExtensionId) {
  throw "extension id changed: expected $expectedExtensionId, manifest yields $extensionId"
}

New-Item -ItemType Directory -Path $publish -Force | Out-Null
dotnet publish $project -c $Configuration -o $publish --nologo
if ($LASTEXITCODE -ne 0) { throw "browser bridge host build failed" }

$edgeHost = Join-Path $publish "raw-edge-bridge.exe"
if (-not (Test-Path -LiteralPath $edgeHost)) { throw "published host is missing: $edgeHost" }
$chromeHost = Join-Path $publish "raw-chrome-bridge.exe"
Copy-Item -LiteralPath $edgeHost -Destination $chromeHost -Force

New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$edgeConfigPath = Join-Path $configDir "edge-bridge.json"
$chromeConfigPath = Join-Path $configDir "chrome-bridge.json"
$edgeConfig = Ensure-BridgeConfig $edgeConfigPath 9333
$chromeConfig = Ensure-BridgeConfig $chromeConfigPath 9334

$edgeManifestPath = Join-Path $installRoot "$hostName.edge.json"
$chromeManifestPath = Join-Path $installRoot "$hostName.chrome.json"
$allowedOrigin = "chrome-extension://$extensionId/"

Write-JsonWithoutBom $edgeManifestPath ([ordered]@{
  name = $hostName
  description = "Local bridge between Raw and the user's Edge profile"
  path = $edgeHost
  type = "stdio"
  allowed_origins = @($allowedOrigin)
})
Write-JsonWithoutBom $chromeManifestPath ([ordered]@{
  name = $hostName
  description = "Local bridge between Raw and the user's Chrome profile"
  path = $chromeHost
  type = "stdio"
  allowed_origins = @($allowedOrigin)
})

if ($Browser -in @("edge", "both")) {
  $edgeKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
  New-Item -Path $edgeKey -Force | Out-Null
  Set-Item -Path $edgeKey -Value $edgeManifestPath
}
if ($Browser -in @("chrome", "both")) {
  $chromeKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
  New-Item -Path $chromeKey -Force | Out-Null
  Set-Item -Path $chromeKey -Value $chromeManifestPath
}

# The extension reconnects automatically and starts the newly registered host.
Get-Process raw-edge-bridge, raw-chrome-bridge -ErrorAction SilentlyContinue | Stop-Process -Force

# Keep the newest three host builds so a bad upgrade can be rolled back.
# Sort by write time: build directories are named host-<timestamp>, but older
# installs on this machine also used host-vN, and name ordering would delete
# the directory that was just created.
Get-ChildItem -LiteralPath $installRoot -Directory -Filter "host-*" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 3 |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

[pscustomobject]@{
  ExtensionId = $extensionId
  ExtensionPath = $extension
  EdgeHost = $edgeHost
  ChromeHost = $chromeHost
  EdgeConfig = $edgeConfigPath
  ChromeConfig = $chromeConfigPath
  EdgeManifest = $edgeManifestPath
  ChromeManifest = $chromeManifestPath
  EdgePort = $edgeConfig.port
  ChromePort = $chromeConfig.port
} | ConvertTo-Json
