Add-Type -AssemblyName System.Drawing

function Resize-Photo($srcPath, $destPath, $maxWidth, $quality) {
  $img = [System.Drawing.Image]::FromFile($srcPath)
  $ratio = $maxWidth / $img.Width
  $newW = $maxWidth
  $newH = [int]($img.Height * $ratio)
  $bmp = New-Object System.Drawing.Bitmap($newW, $newH)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $newW, $newH)
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [int64]$quality)
  $bmp.Save($destPath, $codec, $params)
  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
}

# Esempio d'uso: ridimensiona una foto originale (3-8MB) a 1400px di larghezza, JPEG qualita 78
# (produce file da 60-190KB, adatti al sito). Modifica $src/$dest per ogni nuova foto da aggiungere.
#
# Resize-Photo "C:\percorso\foto-originale.jpg" "C:\...\Growmisito\assets\img\eventi\<evento>\NN.jpg" 1400 78
