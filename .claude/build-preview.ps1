$ErrorActionPreference = "Stop"
$base = "C:\Users\carlo\OneDrive\Documenti\Github\Growmisito"
$out  = "C:\Users\carlo\AppData\Local\Temp\claude\C--Users-carlo-OneDrive-Desktop-growmi-sito\bcfebf78-23e8-49ab-9bce-0f253238b64b\scratchpad\growmi-preview.html"

$logoBytes = [System.IO.File]::ReadAllBytes("$base\assets\img\logo-growmi.png")
$logoB64 = [System.Convert]::ToBase64String($logoBytes)
$logoDataUri = "data:image/png;base64,$logoB64"

function Get-Body($path){
  $content = Get-Content -Raw -Encoding UTF8 $path
  if($content -match '(?s)<body>(.*)</body>'){
    return $Matches[1]
  }
  throw "no body found in $path"
}

$order = @("home","eventi","evento","artisti","chi-siamo","contatti","loyalty","supporters","past1","past2")
$files = @{
  home = "index.html"
  eventi = "eventi.html"
  evento = "the-miseducation-of-growmi.html"
  artisti = "artisti.html"
  "chi-siamo" = "chi-siamo.html"
  contatti = "contatti.html"
  loyalty = "loyalty-card.html"
  supporters = "financial-supporters.html"
  past1 = "grow-with-us.html"
  past2 = "art-mall-collab.html"
}
# Nota: le 5 pagine team-*.html (sottopagine dei dipartimenti, linkate da chi-siamo.html) non sono
# incluse nel bundle della preview: ogni pagina in più duplica header+footer col logo in base64
# (~345KB x2 per pagina), e con 5 pagine extra si superava il limite di 16MB dell'Artifact. Le
# pagine esistono comunque come file reali nel sito e funzionano in locale/sul sito pubblicato,
# semplicemente il click sulle card "team" non funziona dentro questa preview bundlata.

function Embed-Assets($html, $base){
  $pattern = 'src="(assets/img/[^"]+\.(?:jpg|jpeg|png|webp))"'
  $evaluator = [System.Text.RegularExpressions.MatchEvaluator]{
    param($m)
    $relPath = $m.Groups[1].Value
    $fullPath = Join-Path $base ($relPath -replace '/', '\')
    if(-not (Test-Path $fullPath)){ return $m.Value }
    $bytes = [System.IO.File]::ReadAllBytes($fullPath)
    $b64 = [System.Convert]::ToBase64String($bytes)
    $ext = [System.IO.Path]::GetExtension($fullPath).ToLower()
    $mime = switch($ext){
      '.jpg' {'image/jpeg'} '.jpeg' {'image/jpeg'} '.png' {'image/png'}
      '.mp4' {'video/mp4'} '.webp' {'image/webp'} default {'application/octet-stream'}
    }
    return 'src="data:' + $mime + ';base64,' + $b64 + '"'
  }
  return [regex]::Replace($html, $pattern, $evaluator)
}

$popupBlock = $null
$pageBlocks = @()

foreach($key in $order){
  $body = Get-Body "$base\$($files[$key])"

  if($null -eq $popupBlock -and $body -match '(?s)(<div class="nl-popup".*?id="nl-tab"[^>]*>Newsletter</button>)'){
    $popupBlock = $Matches[1]
  }
  $body = $body -replace '(?s)<div class="nl-popup".*?id="nl-tab"[^>]*>Newsletter</button>\r?\n?', ''

  $body = $body -replace '<script src="assets/i18n\.js"></script>\r?\n?', ''
  $body = $body -replace '<script src="assets/newsletter\.js"></script>\r?\n?', ''
  $body = $body -replace '<script src="assets/events-data\.js"></script>\r?\n?', ''
  $body = $body -replace '<script src="assets/events-render\.js"></script>\r?\n?', ''
  $body = $body -replace '<script src="assets/interactive\.js"></script>\r?\n?', ''

  $body = $body -replace 'href="index\.html"', 'href="#/home"'
  $body = $body -replace 'href="eventi\.html"', 'href="#/eventi"'
  $body = $body -replace 'href="artisti\.html"', 'href="#/artisti"'
  $body = $body -replace 'href="chi-siamo\.html"', 'href="#/chi-siamo"'
  $body = $body -replace 'href="contatti\.html"', 'href="#/contatti"'
  $body = $body -replace 'href="the-miseducation-of-growmi\.html"', 'href="#/evento"'
  $body = $body -replace 'href="loyalty-card\.html"', 'href="#/loyalty"'
  $body = $body -replace 'href="financial-supporters\.html"', 'href="#/supporters"'
  $body = $body -replace 'href="grow-with-us\.html"', 'href="#/past1"'
  $body = $body -replace 'href="art-mall-collab\.html"', 'href="#/past2"'

  $body = $body -replace 'src="assets/img/logo-growmi\.png"', ('src="' + $logoDataUri + '"')
  $body = Embed-Assets $body $base

  $hiddenAttr = ""
  if($key -ne "home"){ $hiddenAttr = " hidden" }
  $pageBlocks += "<div class=`"page`" data-page=`"$key`"$hiddenAttr>`n$body`n</div>"
}

if($null -eq $popupBlock){ throw "popup block not captured" }

$stylecss = Get-Content -Raw -Encoding UTF8 "$base\assets\style.css"
$eventcss = Get-Content -Raw -Encoding UTF8 "$base\assets\event-miseducation.css"
$mailerlitecss = Get-Content -Raw -Encoding UTF8 "$base\assets\mailerlite-form.css"
$redesigncss = Get-Content -Raw -Encoding UTF8 "$base\assets\redesign.css"
$interactivecss = Get-Content -Raw -Encoding UTF8 "$base\assets\interactive.css"
$i18njs = Get-Content -Raw -Encoding UTF8 "$base\assets\i18n.js"
$newsletterjs = Get-Content -Raw -Encoding UTF8 "$base\assets\newsletter.js"
$eventsdatajs = Get-Content -Raw -Encoding UTF8 "$base\assets\events-data.js"
$eventsrenderjs = Get-Content -Raw -Encoding UTF8 "$base\assets\events-render.js"
$interactivejs = Get-Content -Raw -Encoding UTF8 "$base\assets\interactive.js"

$routerjs = @'
function growmiRoute(){
  var h = location.hash;
  var m = h.match(/^#\/([\w-]+)/);
  var routes = ["home","eventi","evento","artisti","chi-siamo","contatti","loyalty","supporters","past1","past2"];
  if(!m || routes.indexOf(m[1]) === -1) return;
  document.querySelectorAll(".page").forEach(function(p){
    p.hidden = p.getAttribute("data-page") !== m[1];
  });
  window.scrollTo(0,0);
}
window.addEventListener("hashchange", growmiRoute);
if(!location.hash || !/^#\//.test(location.hash)){ location.hash = "#/home"; }
growmiRoute();
'@

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('<meta charset="UTF-8">')
[void]$sb.AppendLine('<title>GrowMi Preview</title>')
[void]$sb.AppendLine('<meta name="viewport" content="width=device-width, initial-scale=1.0">')
[void]$sb.AppendLine('<link rel="preconnect" href="https://fonts.googleapis.com">')
[void]$sb.AppendLine('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>')
[void]$sb.AppendLine('<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">')
[void]$sb.AppendLine('<style>')
[void]$sb.AppendLine($stylecss)
[void]$sb.AppendLine($eventcss)
[void]$sb.AppendLine($mailerlitecss)
[void]$sb.AppendLine($redesigncss)
[void]$sb.AppendLine($interactivecss)
[void]$sb.AppendLine('.page[hidden]{display:none !important;}')
[void]$sb.AppendLine('.preview-banner{position:fixed; bottom:0; left:0; right:0; z-index:300; background:#1E0C2C; color:#FBF6F0; font-family:"Space Grotesk",sans-serif; font-weight:700; font-size:12px; letter-spacing:.04em; text-align:center; padding:8px 12px;}')
[void]$sb.AppendLine('</style>')
foreach($block in $pageBlocks){
  [void]$sb.AppendLine($block)
}
[void]$sb.AppendLine($popupBlock)
[void]$sb.AppendLine('<div class="preview-banner">ANTEPRIMA GROWMI &mdash; non e il sito pubblicato, i form non inviano dati reali</div>')
[void]$sb.AppendLine('<script>')
[void]$sb.AppendLine($eventsdatajs)
[void]$sb.AppendLine($eventsrenderjs)
[void]$sb.AppendLine($i18njs)
[void]$sb.AppendLine($newsletterjs)
[void]$sb.AppendLine($interactivejs)
[void]$sb.AppendLine($routerjs)
[void]$sb.AppendLine('</script>')

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($out, $sb.ToString(), $utf8NoBom)
Write-Output "written: $out"
Write-Output ("size bytes: " + (Get-Item $out).Length)
