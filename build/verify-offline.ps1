param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$ExpectedHash, [string]$Destination)
$ErrorActionPreference = 'Stop'
try {
  function Hash-File([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $stream.Dispose(); $hash.Dispose() }
  }
  $Root = [IO.Path]::GetFullPath($Root)
  $manifestPath = [IO.Path]::Combine($Root,'manifest.json')
  if ((Hash-File $manifestPath) -ne $ExpectedHash) { throw 'The offline payload manifest does not match this installer.' }
  $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
  if ($manifest.version -ne 1 -or -not $manifest.files.Count) { throw 'Invalid offline payload manifest.' }
  $known = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  [long]$total = 0
  foreach ($entry in $manifest.files) {
    $name = [string]$entry.path
    if ([IO.Path]::IsPathRooted($name) -or $name.Contains('\') -or $name.Split('/') -contains '..' -or -not $known.Add($name)) { throw 'Unsafe offline payload entry.' }
    $path = [IO.Path]::GetFullPath([IO.Path]::Combine($Root,$name))
    if (-not $path.StartsWith($Root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Offline payload entry escaped its directory.' }
    $file = [IO.FileInfo]::new($path)
    if (-not $file.Exists -or $file.Length -ne $entry.size -or (Hash-File $path) -ne $entry.sha256) { throw ('Missing or damaged offline dependency: '+$name) }
    $total += $file.Length
  }
  foreach ($file in [IO.Directory]::EnumerateFileSystemEntries($Root,'*',[IO.SearchOption]::AllDirectories)) {
    if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Offline payload may not contain links.' }
    if ([IO.File]::Exists($file)) {
      $name = $file.Substring($Root.Length+1).Replace('\','/')
      if ($name -ne 'manifest.json' -and -not $known.Contains($name)) { throw ('Unlisted offline dependency: '+$name) }
    }
  }
  if ($Destination) {
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Destination)))
    if ($drive.AvailableFreeSpace -lt ($total + 1073741824)) { throw 'Not enough free disk space for offline dependencies (payload plus 1 GiB required).' }
  }
  Write-Output 'Offline dependencies verified.'
  exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
