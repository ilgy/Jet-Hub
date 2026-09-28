# 兼容别名脚本：转发调用通用部署脚本 deploy.ps1
[CmdletBinding()]
param(
  [switch]$Rollback,
  [switch]$DryRun,
  [string]$SourceDir = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)

$targetScript = Join-Path $PSScriptRoot 'deploy.ps1'
if (-not (Test-Path $targetScript)) {
  throw "找不到目标部署脚本: $targetScript"
}

$params = @{}
if ($Rollback) { $params['Rollback'] = $true }
if ($DryRun) { $params['DryRun'] = $true }
if ($PSBoundParameters.ContainsKey('SourceDir')) { $params['SourceDir'] = $SourceDir }

& $targetScript @params
