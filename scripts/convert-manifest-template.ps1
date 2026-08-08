$ErrorActionPreference = 'Stop'
$xls = 'E:\Live\TGPV5\TGP_V5\resources\app\store-templates\default\Template-Manifest.xls'
$xlsx = 'E:\Live\TGPV5\TGP_V5\resources\app\store-templates\default\Template-Manifest.xlsx'
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
try {
    $wb = $excel.Workbooks.Open($xls)
    if (Test-Path $xlsx) { Remove-Item $xlsx -Force }
    # 51 = xlOpenXMLWorkbook (.xlsx)
    $wb.SaveAs($xlsx, 51)
    $wb.Close($false)
    Write-Output "Converted OK size=$((Get-Item $xlsx).Length)"
} finally {
    $excel.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
}
