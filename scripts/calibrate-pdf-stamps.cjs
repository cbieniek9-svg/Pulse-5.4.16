'use strict';

/**
 * Build upright page JPEGs + overlay current stamp positions (red) and
 * auto-detected checkbox centers (lime) so we can recalibrate the map.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { extractEmbeddedJpegs, pageImageNeeds180 } = require('../src/lib/incident-investigation-pdf.cjs');
const map = require('../src/lib/incident-investigation-pdf-map.cjs');
const { jpegSize, pdfToPix, pixToPdf } = require('./lib/calib-crop.cjs');

const root = path.join(__dirname, '..');
const outDir = path.join(root, '_calib');
fs.mkdirSync(outDir, { recursive: true });
const pageDims = [];

// 1) Extract + upright pages via GDI+
const jpegs = extractEmbeddedJpegs(fs.readFileSync(path.join(root, 'assets/safety/tgp-incident-investigation-appendix-b.pdf')));
const pagePaths = [];
for (let i = 0; i < 5; i += 1) {
    const raw = path.join(outDir, `raw-${i}.jpg`);
    const upright = path.join(outDir, `page-${i}.jpg`);
    fs.writeFileSync(raw, jpegs[i]);
    const ps = [
        "Add-Type -AssemblyName System.Drawing",
        `$img = [System.Drawing.Image]::FromFile('${raw.replace(/'/g, "''")}')`,
        pageImageNeeds180(i) ? '$img.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone)' : '',
        `$img.Save('${upright.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Jpeg)`,
        '$img.Dispose()',
        "Write-Output 'ok'",
    ].filter(Boolean).join('\r\n');
    const psPath = path.join(os.tmpdir(), `tgp-upright-${i}.ps1`);
    fs.writeFileSync(psPath, ps);
    execFileSync('powershell', ['-NoProfile', '-File', psPath], { encoding: 'utf8' });
    pagePaths.push(upright);
    pageDims.push(jpegSize(upright));
}

// 2) Detect checkboxes on a page (hollow-ish dark squares ~10-22px)
function detectCheckboxes(pageIndex) {
    const imgPath = pagePaths[pageIndex].replace(/\\/g, '/');
    const psPath = path.join(os.tmpdir(), `tgp-detect-cb-${pageIndex}.ps1`);
    const outJson = path.join(outDir, `boxes-${pageIndex}.json`).replace(/\\/g, '/');
    fs.writeFileSync(psPath, `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${imgPath}'
$w=$bmp.Width; $h=$bmp.Height
$visited = New-Object 'bool[,]' $w,$h
$boxes = New-Object System.Collections.Generic.List[string]
for ($y=60; $y -lt ($h-40); $y+=3) {
  for ($x=40; $x -lt ($w-40); $x+=3) {
    if ($visited[$x,$y]) { continue }
    if ($bmp.GetPixel($x,$y).R -gt 75) { continue }
    $minX=$x; $maxX=$x; $minY=$y; $maxY=$y; $count=0
    $qx = New-Object System.Collections.Generic.Queue[object]
    $qx.Enqueue(@($x,$y))
    while ($qx.Count -gt 0 -and $count -lt 180) {
      $p=$qx.Dequeue(); $px=$p[0]; $py=$p[1]
      if ($px -lt 0 -or $py -lt 0 -or $px -ge $w -or $py -ge $h) { continue }
      if ($visited[$px,$py]) { continue }
      if ($bmp.GetPixel($px,$py).R -gt 95) { continue }
      $visited[$px,$py]=$true; $count++
      if ($px -lt $minX) {$minX=$px}; if ($px -gt $maxX) {$maxX=$px}
      if ($py -lt $minY) {$minY=$py}; if ($py -gt $maxY) {$maxY=$py}
      $qx.Enqueue(@(($px+1),$py)); $qx.Enqueue(@(($px-1),$py))
      $qx.Enqueue(@($px,($py+1))); $qx.Enqueue(@($px,($py-1)))
    }
    $bw=$maxX-$minX+1; $bh=$maxY-$minY+1
    if ($bw -ge 9 -and $bw -le 26 -and $bh -ge 9 -and $bh -le 26 -and $count -ge 18 -and $count -le 140) {
      $aspect = [math]::Abs($bw - $bh)
      if ($aspect -le 8) {
        $cx=[math]::Round(($minX+$maxX)/2.0)
        $cy=[math]::Round(($minY+$maxY)/2.0)
        $boxes.Add("$cx,$cy,$bw,$bh")
      }
    }
  }
}
$bmp.Dispose()
$boxes | Set-Content -Encoding utf8 '${outJson}'
Write-Output ("count=" + $boxes.Count)
`);
    const summary = execFileSync('powershell', ['-NoProfile', '-File', psPath], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
    }).trim();
    const lines = fs.readFileSync(path.join(outDir, `boxes-${pageIndex}.json`), 'utf8')
        .split(/\r?\n/).filter(Boolean);
    const { width: W, height: H } = pageDims[pageIndex];
    const boxes = lines.map((line) => {
        const [cx, cy, bw, bh] = line.split(',').map(Number);
        const pdf = pixToPdf(W, H, cx, cy);
        return { cx, cy, bw, bh, pdfX: pdf.x, pdfY: pdf.y };
    });
    // de-dupe near-duplicates
    const deduped = [];
    for (const b of boxes.sort((a, b) => a.cy - b.cy || a.cx - b.cx)) {
        if (deduped.some((d) => Math.abs(d.cx - b.cx) < 12 && Math.abs(d.cy - b.cy) < 12)) continue;
        deduped.push(b);
    }
    console.log(`page ${pageIndex}: ${summary}, deduped ${deduped.length}`);
    fs.writeFileSync(path.join(outDir, `boxes-${pageIndex}-dedup.json`), JSON.stringify(deduped, null, 2));
    return deduped;
}

// 3) Overlay map checks (red) + detected (lime) + map texts (blue dots)
function overlay(pageIndex, boxes) {
    const { width: W, height: H } = pageDims[pageIndex];
    const imgPath = pagePaths[pageIndex].replace(/\\/g, '/');
    const outPath = path.join(outDir, `overlay-${pageIndex}.jpg`).replace(/\\/g, '/');
    const marks = [];
    for (const field of map.checks.filter((c) => c.page === pageIndex)) {
        const p = pdfToPix(W, H, field.x, field.y);
        marks.push(`check,${p.x},${p.y}`);
    }
    for (const field of map.texts.filter((t) => t.page === pageIndex)) {
        const p = pdfToPix(W, H, field.x, field.y);
        marks.push(`text,${p.x},${p.y}`);
    }
    for (const b of boxes) marks.push(`box,${b.cx},${b.cy}`);
    const marksFile = path.join(outDir, `marks-${pageIndex}.txt`).replace(/\\/g, '/');
    fs.writeFileSync(marksFile, marks.join('\n'));
    const psPath = path.join(os.tmpdir(), `tgp-overlay-${pageIndex}.ps1`);
    fs.writeFileSync(psPath, `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${imgPath}'
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$penRed = New-Object System.Drawing.Pen ([System.Drawing.Color]::Red), 2
$penLime = New-Object System.Drawing.Pen ([System.Drawing.Color]::Lime), 2
$penBlue = New-Object System.Drawing.Pen ([System.Drawing.Color]::DeepSkyBlue), 2
$brushRed = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Red)
$brushBlue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::DeepSkyBlue)
foreach ($line in Get-Content '${marksFile}') {
  $p = $line.Split(',')
  $kind=$p[0]; $x=[int]$p[1]; $y=[int]$p[2]
  if ($kind -eq 'check') {
    $g.DrawLine($penRed, $x-8, $y-8, $x+8, $y+8)
    $g.DrawLine($penRed, $x-8, $y+8, $x+8, $y-8)
  } elseif ($kind -eq 'text') {
    $g.FillEllipse($brushBlue, $x-4, $y-4, 8, 8)
  } else {
    $g.DrawRectangle($penLime, $x-7, $y-7, 14, 14)
  }
}
$g.Dispose()
$bmp.Save('${outPath}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
Write-Output 'overlay ok'
`);
    console.log(execFileSync('powershell', ['-NoProfile', '-File', psPath], { encoding: 'utf8' }).trim(), outPath);
}

const all = [];
for (let i = 0; i < 5; i += 1) {
    const boxes = detectCheckboxes(i);
    overlay(i, boxes);
    all.push(boxes);
}
fs.writeFileSync(path.join(outDir, 'all-boxes.json'), JSON.stringify(all, null, 2));
console.log('Wrote overlays to', outDir);
