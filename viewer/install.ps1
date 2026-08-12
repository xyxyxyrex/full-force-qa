$ErrorActionPreference = 'Stop'

$Repository = 'xyxyxyrex/full-force-qa'
$FallbackVersion = '__PARITY_VERSION__'
$ReleaseApi = "https://api.github.com/repos/$Repository/releases/latest"
$Headers = @{
  Accept = 'application/vnd.github+json'
  'User-Agent' = 'Parity-Installer'
  'X-GitHub-Api-Version' = '2022-11-28'
}

if ($env:OS -ne 'Windows_NT') {
  throw 'Parity currently supports Windows only.'
}

Write-Host 'Resolving the latest Parity release...' -ForegroundColor Cyan

try {
  $Release = Invoke-RestMethod -Uri $ReleaseApi -Headers $Headers
  $Version = [string]$Release.tag_name -replace '^v', ''
  $AssetName = "Parity-Setup-$Version.exe"
  $Asset = $Release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
  if (-not $Asset) { throw "Release asset '$AssetName' was not found." }
  $DownloadUrl = [string]$Asset.browser_download_url
  $ExpectedDigest = [string]$Asset.digest
} catch {
  Write-Warning "The GitHub release API was unavailable. Falling back to Parity v$FallbackVersion."
  $Version = $FallbackVersion
  $AssetName = "Parity-Setup-$Version.exe"
  $DownloadUrl = "https://github.com/$Repository/releases/download/v$Version/$AssetName"
  $ExpectedDigest = ''
}

$InstallerPath = Join-Path ([IO.Path]::GetTempPath()) $AssetName

try {
  Write-Host "Downloading Parity v$Version..." -ForegroundColor Cyan
  Invoke-WebRequest -Uri $DownloadUrl -OutFile $InstallerPath -UseBasicParsing

  if ($ExpectedDigest -match '^sha256:([a-fA-F0-9]{64})$') {
    $ActualDigest = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash
    if ($ActualDigest -ne $Matches[1]) {
      throw 'The installer checksum did not match the published GitHub release.'
    }
  }

  Write-Host 'Starting the Parity installer...' -ForegroundColor Green
  Start-Process -FilePath $InstallerPath -Wait
} finally {
  Remove-Item -LiteralPath $InstallerPath -Force -ErrorAction SilentlyContinue
}
