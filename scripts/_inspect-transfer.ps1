$ErrorActionPreference = 'Stop'
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
try {
    $path = 'E:\Live\TGPV5\TGP_V5\resources\app\_debug-transfer.xlsx'
    $wb = $excel.Workbooks.Open($path)
    $ws = $wb.Worksheets.Item('Invoice')
    foreach ($addr in @('B16','G16','H16','B17','G17','H17','J39','G5','I1')) {
        $c = $ws.Range($addr)
        Write-Output "$addr Text=$($c.Text) Value=$($c.Value2) Formula=$($c.Formula)"
    }
    $wb.Close($false)
} finally {
    $excel.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
}
