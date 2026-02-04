# Remove all console.log statements from TypeScript/TSX files
# This script removes debug logging while preserving console.error and console.warn

$files = Get-ChildItem -Path "src" -Recurse -Include *.ts,*.tsx

foreach ($file in $files) {
    $content = Get-Content $file.FullName -Raw
    
    # Remove console.log lines (including multi-line)
    $content = $content -replace "console\.log\([^)]*\)\s*\n?", ""
    
    # Remove empty lines that were left behind (max 2 consecutive)
    $content = $content -replace "(\r?\n){3,}", "`r`n`r`n"
    
    Set-Content -Path $file.FullName -Value $content -NoNewline
    Write-Host "Cleaned: $($file.FullName)"
}

Write-Host "`nDone! Removed all console.log statements."
Write-Host "console.error and console.warn were preserved."
