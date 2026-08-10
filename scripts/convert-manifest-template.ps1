$ErrorActionPreference = 'Stop'
$xls = 'E:\Live\TGPV5\TGP_V5\resources\app\store-templates\default\Template-Manifest.xls'
$xlsx = 'E:\Live\TGPV5\TGP_V5\resources\app\store-templates\default\Template-Manifest.xlsx'
$xlsxDir = Split-Path -Parent $xlsx
$tempXlsx = Join-Path $xlsxDir ("Template-Manifest." + [guid]::NewGuid().ToString('N') + ".tmp.xlsx")
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
try {
    $wb = $excel.Workbooks.Open($xls)
    # 51 = xlOpenXMLWorkbook (.xlsx) — SaveAs same-dir temp first, then atomic replace
    $wb.SaveAs($tempXlsx, 51)
    $wb.Close($false)
    if (Test-Path -LiteralPath $xlsx) {
        [System.IO.File]::Replace($tempXlsx, $xlsx, $null)
    } else {
        Move-Item -LiteralPath $tempXlsx -Destination $xlsx
    }
    Write-Output "Converted OK size=$((Get-Item $xlsx).Length)"
} finally {
    if (Test-Path -LiteralPath $tempXlsx) { Remove-Item -LiteralPath $tempXlsx -Force -ErrorAction SilentlyContinue }
    $excel.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
}
