param(
    [ValidateSet('Inspect','OpenFirewall','StopEntry','CheckLauncher')][string]$Action = 'Inspect',
    [string]$ProjectDirectory,
    [string]$HostAddress,
    [ValidateSet('gateway','admin')][string]$Entry,
    [int]$TargetProcessId
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$platformRoot = [System.IO.Path]::GetFullPath($ProjectDirectory)
if (-not (Test-Path -LiteralPath (Join-Path $platformRoot 'traffic-sandbox\server.mjs'))) { throw '项目目录无效。' }
if ($HostAddress) {
    $platformIp = $null
    if (-not [System.Net.IPAddress]::TryParse($HostAddress,[ref]$platformIp) -or $platformIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or $platformIp.GetAddressBytes()[0] -ne 10) { throw '只能使用校园网 10.x IPv4 地址。' }
}
function Get-PlatformListeners {
    $platformExpected = @{4173='traffic-sandbox\server.mjs';4183='dify-integration-lab\server.mjs';4174='admin-access\server.mjs';4190='admin-access\server.mjs';4180='campus-access\server.mjs'}
    $platformConnections = @(Get-NetTCPConnection -State Listen -LocalPort 4173,4183,4174,4180,4190 -ErrorAction SilentlyContinue)
    foreach ($platformConnection in $platformConnections) {
        $platformProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $platformConnection.OwningProcess)
        $platformScript = Join-Path $platformRoot $platformExpected[[int]$platformConnection.LocalPort]
        $platformCommand = [string]$platformProcess.CommandLine
        $platformNormalized = $platformCommand.Replace('/','\')
        $platformOwned = $platformProcess.Name -eq 'node.exe' -and $platformNormalized -match ('(?i)(?:^|["\s])' + [regex]::Escape($platformScript) + '(?=["\s]|$)')
        [pscustomobject]@{port=[int]$platformConnection.LocalPort;address=$platformConnection.LocalAddress;pid=[int]$platformConnection.OwningProcess;owned=[bool]$platformOwned}
    }
}
function Test-PlatformFirewall {
    if (-not $HostAddress) { return $false }
    foreach ($platformRuleSpec in @(@{name='ZjuTrafficCampusDemo-4180';port='4180'},@{name='ZjuTrafficAdmin-4190';port='4190'})) {
        $platformRule = Get-NetFirewallRule -Name $platformRuleSpec.name -ErrorAction SilentlyContinue
        if (-not $platformRule -or $platformRule.Enabled -ne 'True' -or $platformRule.Action -ne 'Allow' -or $platformRule.Direction -ne 'Inbound') { return $false }
        $platformAddressFilter = $platformRule | Get-NetFirewallAddressFilter
        $platformPortFilter = $platformRule | Get-NetFirewallPortFilter
        if (@($platformAddressFilter.LocalAddress).Count -ne 1 -or $platformAddressFilter.LocalAddress -notcontains $HostAddress) { return $false }
        $platformRemoteAddresses = @($platformAddressFilter.RemoteAddress)
        if ($platformRemoteAddresses.Count -ne 1 -or $platformRemoteAddresses[0] -notin @('10.0.0.0/8','10.0.0.0/255.0.0.0')) { return $false }
        if ($platformPortFilter.Protocol -notin @('TCP','6') -or [string]$platformPortFilter.LocalPort -ne $platformRuleSpec.port) { return $false }
    }
    return $true
}
if ($Action -eq 'CheckLauncher') {
    $platformProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $TargetProcessId)
    $platformExpectedFile = Join-Path $platformRoot 'platform-launcher\launch.mjs'
    $platformMatches = $platformProcess -and $platformProcess.Name -eq 'node.exe' -and ([string]$platformProcess.CommandLine).Replace('/','\') -match ('(?i)(?:^|["\s])' + [regex]::Escape($platformExpectedFile) + '(?=["\s]|$)')
    @{owned=[bool]$platformMatches} | ConvertTo-Json -Compress
    exit 0
}
if ($Action -eq 'StopEntry') {
    $platformExpectedFile = Join-Path $platformRoot $(if ($Entry -eq 'gateway') {'campus-access\server.mjs'} else {'admin-access\server.mjs'})
    $platformProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $TargetProcessId)
    if ($platformProcess) {
        if ($platformProcess.Name -ne 'node.exe' -or ([string]$platformProcess.CommandLine).Replace('/','\') -notmatch ('(?i)(?:^|["\s])' + [regex]::Escape($platformExpectedFile) + '(?=["\s]|$)')) { throw '进程身份不匹配，未停止任何程序。' }
        Stop-Process -Id $TargetProcessId -ErrorAction Stop
    }
    @{stopped=$TargetProcessId;entry=$Entry} | ConvertTo-Json -Compress
    exit 0
}
if ($Action -eq 'OpenFirewall') {
    if (-not $HostAddress) { throw '缺少校园网地址。' }
    if (Test-PlatformFirewall) { @{ready=$true;changed=$false} | ConvertTo-Json -Compress; exit 0 }
    $platformPrincipal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $platformPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        $platformElevationArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Action OpenFirewall -ProjectDirectory "' + $platformRoot + '" -HostAddress ' + $HostAddress
        try {
            $platformElevation = Start-Process -FilePath 'powershell.exe' -ArgumentList $platformElevationArgs -Verb RunAs -WindowStyle Hidden -Wait -PassThru
            if ($platformElevation.ExitCode -ne 0) { throw '防火墙配置未完成。' }
        } catch { @{ready=$false;changed=$false;message='未完成 Windows 管理员授权，校园网防火墙尚未确认放行。'} | ConvertTo-Json -Compress; exit 0 }
        @{ready=[bool](Test-PlatformFirewall);changed=$true} | ConvertTo-Json -Compress
        exit 0
    }
    foreach ($platformRuleSpec in @(@{name='ZjuTrafficCampusDemo-4180';port=4180},@{name='ZjuTrafficAdmin-4190';port=4190})) {
        $platformRule = Get-NetFirewallRule -Name $platformRuleSpec.name -ErrorAction SilentlyContinue
        if ($platformRule) { Remove-NetFirewallRule -Name $platformRuleSpec.name }
        New-NetFirewallRule -Name $platformRuleSpec.name -DisplayName ('校园交通平台 TCP ' + $platformRuleSpec.port + '（仅校园网）') -Direction Inbound -Action Allow -Protocol TCP -LocalPort $platformRuleSpec.port -LocalAddress $HostAddress -RemoteAddress '10.0.0.0/8' -Profile Any | Out-Null
    }
    if (-not (Test-PlatformFirewall)) { throw '防火墙规则验证失败。' }
    @{ready=$true;changed=$true} | ConvertTo-Json -Compress
    exit 0
}
$platformPreferredAddress = $null
try {
    $platformRoutes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric)
    foreach ($platformRoute in $platformRoutes) {
        $platformCandidate = Get-NetIPAddress -InterfaceIndex $platformRoute.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like '10.*' } | Select-Object -First 1
        if ($platformCandidate) { $platformPreferredAddress = $platformCandidate.IPAddress; break }
    }
} catch {}
@{listeners=@(Get-PlatformListeners);firewallReady=[bool](Test-PlatformFirewall);preferredAddress=$platformPreferredAddress} | ConvertTo-Json -Depth 5 -Compress
