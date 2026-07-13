param([string]$DistDir = (Join-Path $PSScriptRoot '..\dist'))

$executables = Get-ChildItem -LiteralPath $DistDir -File -Filter 'Agent-Fleet-*.exe'
if ($executables.Count -lt 2) { throw 'Expected signed Setup and Portable executables.' }

foreach ($file in $executables) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($signature.Status -ne 'Valid') {
    throw "$($file.Name) does not have a valid Authenticode signature: $($signature.Status)"
  }
  Write-Output "$($file.Name): $($signature.SignerCertificate.Subject)"
}
