param(
  [ValidateSet("edge", "chrome", "both")]
  [string]$Browser = "both",
  [string]$Configuration = "Release",
  # Use an already-published raw-edge-bridge.exe instead of building/downloading.
  [string]$HostPath,
  # Download the release asset even when a .NET SDK is installed.
  [switch]$PreferPrebuilt,
  # Always build from the checkout, even when no .NET SDK is detected.
  [switch]$BuildFromSource,
  # Remove host-* directories left by installers before the stable-path layout.
  # Run this only after the browser has been restarted.
  [switch]$CleanLegacyHosts
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $repo "edge-bridge\extension"
$project = Join-Path $repo "edge-bridge\host\RawEdgeBridge.csproj"
$installRoot = Join-Path $env:USERPROFILE ".raw\edge-bridge"
$staging = Join-Path $installRoot ("build-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$current = Join-Path $installRoot "current"
$previous = Join-Path $installRoot "previous"
$configDir = Join-Path $env:USERPROFILE ".raw"
$expectedExtensionId = "gfpadofoapicldopjkghnfbnbkljihmk"
$hostName = "com.raw.edge_bridge"
$releaseRepo = "https://github.com/liutingqiu/raw-browser/releases/download"

if ($PreferPrebuilt -and $BuildFromSource) {
  throw "use either -PreferPrebuilt or -BuildFromSource, not both"
}
if ($HostPath -and ($PreferPrebuilt -or $BuildFromSource)) {
  throw "-HostPath cannot be combined with a build/download switch"
}

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

function Get-ManifestVersion([string]$ManifestPath) {
  return (Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json).version
}

function Get-PrebuiltHost([string]$Version, [string]$Destination) {
  $asset = "raw-bridge-host-win-x64.zip"
  $url = "$releaseRepo/v$Version/$asset"
  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("raw-bridge-" + [Guid]::NewGuid().ToString("n"))
  $zip = Join-Path $temp $asset
  New-Item -ItemType Directory -Path $temp -Force | Out-Null

  Write-Host "downloading prebuilt bridge host: $url"
  try {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  } catch {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    throw "could not download the prebuilt bridge host ($url). Install the .NET 9 SDK and rerun, pass -HostPath with a local raw-edge-bridge.exe, or publish the release asset. $($_.Exception.Message)"
  }

  # Verify the archive when the release publishes checksums. A missing sums
  # file is a warning; a mismatch is fatal.
  try {
    $sumsUrl = "$releaseRepo/v$Version/SHA256SUMS.txt"
    $sums = (Invoke-WebRequest -Uri $sumsUrl -UseBasicParsing).Content
    $line = ($sums -split "`n") | Where-Object { $_ -match [regex]::Escape($asset) } | Select-Object -First 1
    if ($line) {
      $expected = ($line.Trim() -split '\s+')[0].ToLowerInvariant()
      $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($expected -ne $actual) { throw "checksum mismatch for $asset" }
    }
  } catch {
    if ($_.Exception.Message -like "*checksum mismatch*") {
      Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
      throw
    }
    Write-Warning "could not verify $asset against SHA256SUMS.txt: $($_.Exception.Message)"
  }

  $extract = Join-Path $temp "extract"
  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
  $found = Get-ChildItem -LiteralPath $extract -Filter "raw-edge-bridge.exe" -Recurse | Select-Object -First 1
  if (-not $found) {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    throw "the downloaded archive does not contain raw-edge-bridge.exe"
  }
  Copy-Item -LiteralPath $found.FullName -Destination $Destination -Force
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

$version = Get-ManifestVersion (Join-Path $extension "manifest.json")
$stagedEdge = Join-Path $staging "raw-edge-bridge.exe"
$stagedChrome = Join-Path $staging "raw-chrome-bridge.exe"
New-Item -ItemType Directory -Path $staging -Force | Out-Null

if ($HostPath) {
  if (-not (Test-Path -LiteralPath $HostPath)) { throw "-HostPath does not exist: $HostPath" }
  Copy-Item -LiteralPath $HostPath -Destination $stagedEdge -Force
} else {
  $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
  $build = $BuildFromSource -or ($dotnet -and -not $PreferPrebuilt)
  if ($build) {
    if (-not $dotnet) { throw "-BuildFromSource needs the .NET 9 SDK on PATH" }
    Write-Host "building the bridge host from source"
    dotnet publish $project -c $Configuration -r win-x64 --self-contained true `
      -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
      -p:EnableCompressionInSingleFile=true -o $staging --nologo
    if ($LASTEXITCODE -ne 0) {
      if ($BuildFromSource) { throw "browser bridge host build failed" }
      Write-Warning "source build failed; falling back to the prebuilt host"
      Get-PrebuiltHost $version $stagedEdge
    }
  } else {
    Get-PrebuiltHost $version $stagedEdge
  }
}

if (-not (Test-Path -LiteralPath $stagedEdge)) { throw "the bridge host is missing: $stagedEdge" }
Copy-Item -LiteralPath $stagedEdge -Destination $stagedChrome -Force

# Native messaging manifests must keep pointing at one stable path. Edge and
# Chrome cache the resolved host path for the life of the browser process, so
# moving the host to a new directory on every upgrade can leave reconnects
# pointing at a deleted binary until the browser restarts.
Get-Process raw-edge-bridge, raw-chrome-bridge -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

$edgeHost = Join-Path $current "raw-edge-bridge.exe"
$chromeHost = Join-Path $current "raw-chrome-bridge.exe"
$previousEdge = Join-Path $previous "raw-edge-bridge.exe"
$previousChrome = Join-Path $previous "raw-chrome-bridge.exe"

New-Item -ItemType Directory -Path $current -Force | Out-Null
if (Test-Path -LiteralPath $previous) {
  Remove-Item -LiteralPath $previous -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $previous -Force | Out-Null

try {
  # Rename old and new files in place: same-volume moves are atomic and avoid
  # copying 94 MB. The old pair stays in previous/ for rollback.
  if (Test-Path -LiteralPath $edgeHost) { Move-Item -LiteralPath $edgeHost -Destination $previousEdge -Force }
  if (Test-Path -LiteralPath $chromeHost) { Move-Item -LiteralPath $chromeHost -Destination $previousChrome -Force }
  Move-Item -LiteralPath $stagedEdge -Destination $edgeHost -Force
  Move-Item -LiteralPath $stagedChrome -Destination $chromeHost -Force
} catch {
  # Put the previous build back rather than leaving the bridge with no host.
  Remove-Item -LiteralPath $edgeHost, $chromeHost -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $previousEdge) { Move-Item -LiteralPath $previousEdge -Destination $edgeHost -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $previousChrome) { Move-Item -LiteralPath $previousChrome -Destination $chromeHost -Force -ErrorAction SilentlyContinue }
  throw
} finally {
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}

$legacy = @(Get-ChildItem -LiteralPath $installRoot -Directory -Filter "host-*" -ErrorAction SilentlyContinue)
if ($legacy.Count) {
  if ($CleanLegacyHosts) {
    $legacy | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "removed legacy host directories"
  } else {
    Write-Warning "legacy host directories remain: $($legacy.Name -join ', '). A running Edge or Chrome may still use one until it restarts; rerun with -CleanLegacyHosts after the restart to reclaim the disk space."
  }
}

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
