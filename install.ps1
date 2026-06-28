$ErrorActionPreference = "Stop"

$BaseUrl = if ($env:ANYENV_CLI_BASE_URL) { $env:ANYENV_CLI_BASE_URL.TrimEnd('/') } else { "https://api.anyenv.cn/api/v1/cli" }
$Version = if ($env:ANYENV_VERSION) { $env:ANYENV_VERSION } else { "latest" }
$InstallDir = if ($env:ANYENV_INSTALL_DIR) { $env:ANYENV_INSTALL_DIR } else { Join-Path $HOME ".anyenv\bin" }

$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
switch ($Arch) {
  "x64" { $Asset = "anyenv-windows-x64.zip" }
  default { throw "Unsupported Windows architecture: $Arch" }
}

$Url = "$BaseUrl/releases/$Version/download/$Asset"
$ChecksumsUrl = "$BaseUrl/releases/$Version/download/SHA256SUMS"
$ApiBase = $BaseUrl.TrimEnd("/")
if ($ApiBase.EndsWith("/cli")) {
  $ApiBase = $ApiBase.Substring(0, $ApiBase.Length - 4)
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("anyenv-" + [System.Guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

function Configure-AnyenvApiBase {
  if ($env:ANYENV_SKIP_CONFIG -eq "1" -or $ApiBase -eq $BaseUrl.TrimEnd("/")) { return }
  $ConfigPath = if ($env:ANYENV_CONFIG) { $env:ANYENV_CONFIG } else { Join-Path $HOME ".anyenv\config.json" }
  $ConfigDir = Split-Path -Parent $ConfigPath
  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

  if (-not (Test-Path $ConfigPath)) {
    @{ apiBase = $ApiBase } | ConvertTo-Json | Set-Content -Encoding UTF8 -Path $ConfigPath
    Write-Host "Configured AnyEnv API base: $ApiBase"
    return
  }

  try {
    $Config = Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json
  } catch {
    Write-Host "Existing AnyEnv config is not valid JSON; preserved: $ConfigPath"
    return
  }

  $DefaultApi = "https://api.anyenv.cn/api/v1"
  $StoredApi = if ($Config.apiBase) { ([string]$Config.apiBase).TrimEnd("/") } else { "" }
  $HasAuth = [bool]($Config.projectToken -or $Config.accessToken)
  if ($HasAuth -or ($StoredApi -and $StoredApi -ne $DefaultApi)) {
    Write-Host "Existing AnyEnv config preserved: $ConfigPath"
    return
  }

  $Config | Add-Member -NotePropertyName apiBase -NotePropertyValue $ApiBase -Force
  $Config | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 -Path $ConfigPath
  Write-Host "Configured AnyEnv API base: $ApiBase"
}

try {
  $Archive = Join-Path $TempDir $Asset
  $Checksums = Join-Path $TempDir "SHA256SUMS"
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Archive
  Write-Host "Downloading $ChecksumsUrl"
  Invoke-WebRequest -Uri $ChecksumsUrl -OutFile $Checksums
  $Expected = $null
  foreach ($Line in Get-Content $Checksums) {
    $Parts = $Line.Trim() -split "\s+"
    if ($Parts.Length -ge 2 -and $Parts[1] -eq $Asset) {
      $Expected = $Parts[0].ToLowerInvariant()
      break
    }
  }
  if (-not $Expected) { throw "Checksum for $Asset not found in SHA256SUMS" }
  $Actual = (Get-FileHash -Path $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) {
    throw "Checksum mismatch for $Asset. Expected $Expected, got $Actual"
  }
  Expand-Archive -Path $Archive -DestinationPath $TempDir -Force
  $Binary = Get-ChildItem -Path $TempDir -Filter "anyenv.exe" -Recurse | Select-Object -First 1
  if (-not $Binary) { throw "AnyEnv CLI binary not found in archive" }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item -Path $Binary.FullName -Destination (Join-Path $InstallDir "anyenv.exe") -Force
  $PathParts = @($env:Path -split ";" | Where-Object { $_ })
  if ($PathParts -notcontains $InstallDir) {
    $env:Path = "$InstallDir;$env:Path"
  }
  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $UserPathParts = @($UserPath -split ";" | Where-Object { $_ })
  if ($UserPathParts -notcontains $InstallDir) {
    $NextUserPath = if ($UserPath) { "$UserPath;$InstallDir" } else { $InstallDir }
    [Environment]::SetEnvironmentVariable("Path", $NextUserPath, "User")
    Write-Host "Added $InstallDir to user PATH."
  } else {
    Write-Host "AnyEnv CLI is already on user PATH."
  }
  Configure-AnyenvApiBase
  Write-Host "Installed AnyEnv CLI to $(Join-Path $InstallDir "anyenv.exe")"
  Write-Host "Run: anyenv --version"
} finally {
  Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
}
