$ErrorActionPreference = 'Stop'
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
try {
    $path = 'E:\Live\TGPV5\TGP_V5\resources\app\_ext-check.xlsx'
    $wb = $excel.Workbooks.Open($path)
    $ws = $wb.Worksheets.Item('Invoice')
    foreach ($addr in @('G16','H16','I16','J16','J39')) {
        $c = $ws.Range($addr)
        Write-Output "$addr Text=$($c.Text) Value=$($c.Value2) Formula=$($c.Formula)"
    }
    $wb.Close($false)
} finally {
    $excel.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
}
