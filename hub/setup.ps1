# 특수학급 비상호출 설치 (처음 한 번만, 관리자 권한 필요)
# 1) 학교 내부망 접속 허용  2) 방화벽 허용(개인·도메인 네트워크)  3) 학교 등록  4) 바탕화면 바로가기
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$SelfPath = $MyInvocation.MyCommand.Path

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host '관리자 권한으로 다시 실행합니다. 나오는 창에서 [예]를 누르세요.'
    Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$SelfPath`"")
    exit
}

Write-Host ''
Write-Host '=== 특수학급 비상호출 설치 ==='
Write-Host ''

Write-Host '[1/4] 학교 내부망 접속 허용 설정 중...'
$out = netsh http add urlacl url=http://+:8080/ sddl="D:(A;;GX;;;S-1-1-0)" 2>&1
if ($LASTEXITCODE -eq 0) { Write-Host '      완료' }
else { Write-Host '      이미 설정되어 있거나 확인이 필요합니다. 계속 진행합니다.' }

Write-Host '[2/4] 방화벽 허용 설정 중...'
Remove-NetFirewallRule -DisplayName '특수학급 비상호출 8080' -ErrorAction SilentlyContinue
try {
    New-NetFirewallRule -DisplayName '특수학급 비상호출 8080' -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private,Domain | Out-Null
    Write-Host '      완료'
} catch {
    Write-Host ('      방화벽 설정 실패: ' + $_.Exception.Message)
}

Write-Host '[3/4] 학교 등록'
$name = (Read-Host '      학교 이름을 입력하고 Enter').Trim()
$code = (Read-Host '      학교 코드를 입력하고 Enter (영문 대문자와 숫자 6~12자)').Trim().ToUpper()
if (-not $name -or $code -notmatch '^[A-Z0-9]{6,12}$') {
    Write-Host ''
    Write-Host '      입력이 올바르지 않습니다. 설치하기.bat을 다시 실행해 주세요.'
    Read-Host 'Enter를 누르면 닫힙니다'
    exit 1
}
$dataFile = Join-Path $Root 'schools.json'
$list = @()
if (Test-Path $dataFile) {
    $raw = Get-Content -Path $dataFile -Raw -Encoding UTF8
    if (-not [string]::IsNullOrWhiteSpace($raw)) { $list = @(($raw | ConvertFrom-Json).schools) }
}
if ($list | Where-Object { $_.code -eq $code }) {
    Write-Host '      이미 등록된 학교 코드입니다.'
} else {
    $list += [pscustomobject]@{ name = $name; code = $code; createdAt = (Get-Date).ToString('s') }
    @{ schools = $list } | ConvertTo-Json -Depth 4 | Set-Content -Path $dataFile -Encoding UTF8
    Write-Host ('      등록 완료: ' + $name + ' (' + $code + ')')
}

Write-Host '[4/4] 바탕화면 바로가기 만드는 중...'
try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut((Join-Path $desktop '비상호출 서버 시작.lnk'))
    $sc.TargetPath = Join-Path $Root '시작하기.bat'
    $sc.WorkingDirectory = $Root
    $sc.Save()
    Write-Host '      완료'
} catch {
    Write-Host ('      바로가기 생성 실패: ' + $_.Exception.Message)
}

Write-Host ''
Write-Host '설치가 끝났습니다.'
Write-Host '다음부터는 바탕화면의 [비상호출 서버 시작]을 더블클릭하면 됩니다.'
Write-Host ''
Read-Host 'Enter를 누르면 닫힙니다'
