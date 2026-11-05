# 특수학급 비상호출 중계 서버 (Windows 기본 PowerShell 사용, 별도 설치 없음)
# 학교 내부망(10., 192.168., 172.16~31.)에서 온 요청만 받습니다.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PublicDir = Join-Path $Root 'public'
$DataFile = Join-Path $Root 'schools.json'
$Port = 8080
$TunnelExe = Join-Path $Root 'cloudflared.exe'
$TunnelPidFile = Join-Path $Root 'tunnel.pid'
$TunnelLog = Join-Path $Root 'tunnel.log'
$CallTtlMs = 10 * 60 * 1000

$Sessions = @{}
$Calls = @{}

function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Clean($value, [int]$max) {
    $t = ([string]$value).Trim()
    if ($t.Length -gt $max) { $t = $t.Substring(0, $max) }
    return $t
}

function Get-Schools {
    if (-not (Test-Path $DataFile)) { return @() }
    $raw = Get-Content -Path $DataFile -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
    $obj = $raw | ConvertFrom-Json
    return @($obj.schools)
}

function Is-Private([string]$ip) {
    if ($ip -eq '127.0.0.1' -or $ip -eq '::1') { return $true }
    if ($ip -match '^10\.') { return $true }
    if ($ip -match '^192\.168\.') { return $true }
    if ($ip -match '^172\.(1[6-9]|2\d|3[01])\.') { return $true }
    return $false
}

function Send-Bytes($res, [int]$status, [byte[]]$bytes, [string]$type) {
    $res.StatusCode = $status
    $res.ContentType = $type
    $res.Headers['Cache-Control'] = 'no-cache'
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    $res.OutputStream.Close()
}

function Send-Json($res, [int]$status, $obj) {
    $json = $obj | ConvertTo-Json -Depth 6 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    Send-Bytes $res $status $bytes 'application/json; charset=utf-8'
}

function Read-Body($req) {
    $reader = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
    $text = $reader.ReadToEnd()
    $reader.Close()
    if ([string]::IsNullOrWhiteSpace($text)) { return New-Object psobject }
    return ($text | ConvertFrom-Json)
}

function Get-Session([string]$token) {
    if (-not $token) { return $null }
    if ($Sessions.ContainsKey($token)) { return $Sessions[$token] }
    return $null
}

function Public-Call($c) {
    return @{ id = $c.id; room = $c.room; by = $c.by; role = $c.role; at = $c.at; drill = $c.drill; ackedCount = $c.acked.Count }
}

function Serve-Static($res, [string]$urlPath) {
    $rel = if ($urlPath -eq '/') { 'index.html' } else { [Uri]::UnescapeDataString($urlPath.TrimStart('/')) }
    $full = [IO.Path]::GetFullPath((Join-Path $PublicDir $rel))
    $base = (Resolve-Path $PublicDir).Path.TrimEnd('\') + '\'
    if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { Send-Json $res 400 @{ error = '잘못된 요청입니다.' }; return }
    if (-not (Test-Path $full -PathType Leaf)) { Send-Json $res 404 @{ error = '없는 파일입니다.' }; return }
    $ext = [IO.Path]::GetExtension($full).ToLower()
    $types = @{
        '.html' = 'text/html; charset=utf-8'; '.js' = 'application/javascript; charset=utf-8';
        '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
    }
    $type = $types[$ext]
    if (-not $type) { $type = 'application/octet-stream' }
    Send-Bytes $res 200 ([IO.File]::ReadAllBytes($full)) $type
}

function Handle($ctx) {
    $req = $ctx.Request
    $res = $ctx.Response
    $ip = ([string]$req.RemoteEndPoint.Address.IPAddressToString) -replace '^::ffff:', ''
    $viaTunnel = [bool]$req.Headers['CF-Connecting-IP']
    if (-not $viaTunnel -and -not (Is-Private $ip)) {
        Send-Json $res 403 @{ error = '학교 내부망에서만 접속할 수 있습니다.' }
        return
    }
    $method = $req.HttpMethod
    $path = $req.Url.AbsolutePath

    if ($method -eq 'GET' -and -not $path.StartsWith('/api/')) {
        Serve-Static $res $path
        return
    }

    if ($method -eq 'POST' -and $path -eq '/api/join') {
        $b = Read-Body $req
        $code = (Clean $b.schoolCode 12).ToUpper()
        $school = Get-Schools | Where-Object { $_.code -eq $code } | Select-Object -First 1
        if (-not $school) { Send-Json $res 403 @{ error = '학교 코드가 맞지 않습니다.' }; return }
        $name = Clean $b.name 20
        $room = Clean $b.room 30
        $role = Clean $b.role 20
        if (-not $name -or -not $room) { Send-Json $res 400 @{ error = '이름과 교실을 입력하세요.' }; return }
        $token = [guid]::NewGuid().ToString('N')
        $s = @{ token = $token; schoolCode = $code; schoolName = [string]$school.name; name = $name; role = $role; room = $room }
        $Sessions[$token] = $s
        Send-Json $res 200 $s
        return
    }

    if ($method -eq 'GET' -and $path -eq '/api/state') {
        $s = Get-Session $req.QueryString['token']
        if (-not $s) { Send-Json $res 401 @{ error = '다시 입장해 주세요.' }; return }
        $call = $Calls[$s.schoolCode]
        if ($call -and ((Now-Ms) - [long]$call.at) -gt $CallTtlMs) { $Calls.Remove($s.schoolCode); $call = $null }
        $out = @{ call = $null }
        if ($call) { $out.call = Public-Call $call }
        Send-Json $res 200 $out
        return
    }

    if ($method -eq 'POST' -and $path -eq '/api/call') {
        $b = Read-Body $req
        $s = Get-Session ([string]$b.token)
        if (-not $s) { Send-Json $res 401 @{ error = '다시 입장해 주세요.' }; return }
        $call = @{
            id = [guid]::NewGuid().ToString('N').Substring(0, 12); room = $s.room; by = $s.name;
            role = $s.role; at = Now-Ms; drill = [bool]$b.drill; acked = @{}
        }
        $Calls[$s.schoolCode] = $call
        Send-Json $res 200 @{ ok = $true; id = $call.id }
        return
    }

    if ($method -eq 'POST' -and $path -eq '/api/ack') {
        $b = Read-Body $req
        $s = Get-Session ([string]$b.token)
        if (-not $s) { Send-Json $res 401 @{ error = '다시 입장해 주세요.' }; return }
        $call = $Calls[$s.schoolCode]
        if (-not $call -or $call.id -ne (Clean $b.callId 20)) { Send-Json $res 404 @{ error = '이미 끝난 호출입니다.' }; return }
        $call.acked[$s.name + ' / ' + $s.room] = Now-Ms
        Send-Json $res 200 @{ ok = $true; ackedCount = $call.acked.Count }
        return
    }

    Send-Json $res 404 @{ error = '없는 주소입니다.' }
}

# 외부 접속용 터널 (cloudflared, 없으면 건너뜀)
function Start-Tunnel {
    if (-not (Test-Path $TunnelExe)) { return $null }
    if (Test-Path $TunnelPidFile) {
        $old = Get-Content $TunnelPidFile -ErrorAction SilentlyContinue
        if ($old) { Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue }
        Remove-Item $TunnelPidFile -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $TunnelLog) { Remove-Item $TunnelLog -Force -ErrorAction SilentlyContinue }
    $p = Start-Process -FilePath $TunnelExe -ArgumentList @('tunnel', '--url', "http://localhost:$Port", '--no-autoupdate') -WindowStyle Hidden -RedirectStandardError $TunnelLog -PassThru
    Set-Content -Path $TunnelPidFile -Value $p.Id
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            if (Test-Path $TunnelLog) {
                $m = Select-String -Path $TunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction Stop | Select-Object -First 1
                if ($m) { return $m.Matches[0].Value }
            }
        } catch {}
        if ($p.HasExited) { break }
    }
    return $null
}

# ---------- 시작 ----------
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://+:$Port/")
try {
    $listener.Start()
} catch {
    Write-Host ''
    Write-Host '서버를 시작하지 못했습니다. 바탕화면의 [설치하기.bat]을 한 번 실행한 뒤 다시 시도하세요.'
    Write-Host ('오류: ' + $_.Exception.Message)
    Read-Host 'Enter를 누르면 닫힙니다'
    exit 1
}

$TunnelUrl = Start-Tunnel
$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' } |
    ForEach-Object { $_.IPAddress })
$schools = Get-Schools

Write-Host ''
Write-Host '=== 비상호출 중계 서버가 시작되었습니다 ==='
Write-Host '이 창을 닫으면 서버가 꺼집니다. 수업이 있는 동안 열어 두십시오.'
Write-Host ''
if ($schools.Count -eq 0) {
    Write-Host '등록된 학교가 없습니다. 바탕화면의 [설치하기.bat]을 실행해 학교를 등록하세요.'
} elseif ($ips.Count -eq 0) {
    Write-Host '학교 내부망 IP를 찾지 못했습니다. 와이파이 연결을 확인하세요.'
} else {
    foreach ($s in $schools) {
        foreach ($ip in $ips) {
            Write-Host ('[' + $s.name + '] 선생님 접속 링크: http://' + $ip + ':' + $Port + '/?code=' + $s.code)
        }
    }
}
Write-Host ''
Write-Host ''
if ($TunnelUrl) {
    Write-Host '[다른 와이파이, 5G에서 접속하는 링크]'
    foreach ($s in $schools) { Write-Host ($TunnelUrl + '/?code=' + $s.code) }
} elseif (-not (Test-Path $TunnelExe)) {
    Write-Host '외부 접속 도구가 없어 학교 안에서만 접속됩니다. 설치하기.bat을 다시 실행하면 외부 접속 링크가 만들어집니다.'
} else {
    Write-Host '외부 접속 링크를 만들지 못했습니다. 인터넷 연결을 확인한 뒤 서버를 다시 시작하세요.'
}
Write-Host ''
Write-Host '학교 안 링크는 학교 와이파이에서만 열립니다. 외부 링크는 어디서나 열립니다.'
Write-Host ''

while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()
        Handle $ctx
    } catch {
        Write-Host ('요청 처리 중 오류: ' + $_.Exception.Message)
        try { Send-Json $ctx.Response 500 @{ error = '서버 오류가 났습니다.' } } catch {}
    }
}
