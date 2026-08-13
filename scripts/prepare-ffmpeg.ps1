$ErrorActionPreference = 'Stop'

$releaseTag = 'autobuild-2026-06-30-13-34'
$archiveName = 'ffmpeg-N-125365-g9a01c1cb6a-win64-lgpl-shared.zip'
$expectedSha256 = '52d25fc4711078112ba622d07601f183371af43e2d93cbb6e5eab3e1c05387cb'
$downloadUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$releaseTag/$archiveName"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$targetDirectory = Join-Path $repositoryRoot 'assets\ffmpeg'
$existingFfmpeg = Join-Path $targetDirectory 'ffmpeg.exe'
$versionFile = Join-Path $targetDirectory 'VERSION.txt'

if ((Test-Path -LiteralPath $existingFfmpeg) -and (Test-Path -LiteralPath $versionFile)) {
  $installedVersion = Get-Content -LiteralPath $versionFile -Raw
  if ($installedVersion.Trim() -eq "$releaseTag/$archiveName") {
    exit 0
  }
}

$workDirectory = Join-Path ([System.IO.Path]::GetTempPath()) 'michikusa45-ffmpeg-prepare'
$archivePath = Join-Path $workDirectory $archiveName
$extractDirectory = Join-Path $workDirectory 'extracted'

if (Test-Path -LiteralPath $workDirectory) {
  Remove-Item -LiteralPath $workDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $workDirectory | Out-Null

try {
  Write-Host 'Downloading the pinned LGPL FFmpeg build...'
  Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath
  $actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) {
    throw "FFmpeg archive checksum mismatch. Expected $expectedSha256 but got $actualSha256."
  }

  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDirectory
  $distributionRoot = Get-ChildItem -LiteralPath $extractDirectory -Directory | Select-Object -First 1
  if (-not $distributionRoot) {
    throw 'The FFmpeg archive did not contain a distribution directory.'
  }

  $binaryDirectory = Join-Path $distributionRoot.FullName 'bin'
  $ffmpegSource = Join-Path $binaryDirectory 'ffmpeg.exe'
  if (-not (Test-Path -LiteralPath $ffmpegSource)) {
    throw 'ffmpeg.exe was not found in the downloaded archive.'
  }

  New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
  Copy-Item -LiteralPath $ffmpegSource -Destination $targetDirectory -Force
  Get-ChildItem -LiteralPath $binaryDirectory -Filter '*.dll' -File |
    Copy-Item -Destination $targetDirectory -Force
  Copy-Item -LiteralPath (Join-Path $distributionRoot.FullName 'LICENSE.txt') -Destination $targetDirectory -Force
  Set-Content -LiteralPath $versionFile -Value "$releaseTag/$archiveName" -Encoding utf8
} finally {
  if (Test-Path -LiteralPath $workDirectory) {
    Remove-Item -LiteralPath $workDirectory -Recurse -Force
  }
}
