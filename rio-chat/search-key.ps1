param([switch]$Read, [switch]$Status, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
# Resolve the Windows module explicitly even when launched under PowerShell 7.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$configPath = Join-Path $PSScriptRoot 'search.local.json'
if ($SelfTest) { $configPath = Join-Path $env:TEMP 'takase-search-setup-fixture.json' }
if ($Read) {
    try {
        $readStage = 'config'
        $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $readStage = 'decrypt'
        $secure = ConvertTo-SecureString $config.apiKeyProtected
        $readStage = 'marshal'
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $readStage = 'pipe'; [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    } catch { [Console]::Error.Write('Search key read failed: ' + $readStage + ' ' + $_.Exception.GetType().Name); exit 1 }
    exit
}
# Status query for the local console. Answers "is search configured" only.
# Keep this whole file ASCII-only: PowerShell 5.1 reads BOM-less .ps1 files as
# the system ANSI codepage, so non-ASCII comments here corrupt the parser.
# Prints exactly one line, SEARCH_STATUS:<none|disabled|broken|ok>, never the key.
if ($Status) {
    if (-not (Test-Path -LiteralPath $configPath)) { [Console]::WriteLine('SEARCH_STATUS:none'); exit 0 }
    try {
        $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $config.enabled) { [Console]::WriteLine('SEARCH_STATUS:disabled'); exit 0 }
        if ([string]::IsNullOrWhiteSpace($config.apiKeyProtected)) { [Console]::WriteLine('SEARCH_STATUS:broken'); exit 0 }
        $secure = ConvertTo-SecureString $config.apiKeyProtected
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $length = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Length }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        if ($length -ge 10) { [Console]::WriteLine('SEARCH_STATUS:ok') } else { [Console]::WriteLine('SEARCH_STATUS:broken') }
    } catch { [Console]::WriteLine('SEARCH_STATUS:broken') }
    exit 0
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Takase Bot - Kimi Search Setup'
$form.Size = New-Object System.Drawing.Size(590,280)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.Add_Shown({ $form.Activate(); $box.Focus() })
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Paste your Kimi API key below. It stays on this PC (Windows encrypted).'
$label.Location = New-Object System.Drawing.Point(20,20)
$label.Size = New-Object System.Drawing.Size(540,40)
$box = New-Object System.Windows.Forms.TextBox
$box.Location = New-Object System.Drawing.Point(20,65)
$box.Size = New-Object System.Drawing.Size(530,28)
$box.UseSystemPasswordChar = $true
$note = New-Object System.Windows.Forms.Label
$note.Text = 'Search is billed by Kimi. Max 2 web calls per reply; cache: 1-24 hours. Chat continues to use DeepSeek. Save, then restart the bot.'
$note.Location = New-Object System.Drawing.Point(20,105)
$note.Size = New-Object System.Drawing.Size(530,50)
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Save and enable search'
$button.Location = New-Object System.Drawing.Point(20,170)
$button.Size = New-Object System.Drawing.Size(220,34)
$button.Add_Click({
    if ($box.Text.Trim().Length -lt 10) { [System.Windows.Forms.MessageBox]::Show('Please enter an API key.'); return }
    try {
        $stage = 'encrypt'
        $encrypted = ConvertTo-SecureString $box.Text.Trim() -AsPlainText -Force | ConvertFrom-SecureString
        $stage = 'serialize'
        $data = @{ schemaVersion=1; enabled=$true; apiKeyProtected=$encrypted } | ConvertTo-Json
        $stage = 'write'
        [IO.File]::WriteAllText($configPath, $data, (New-Object Text.UTF8Encoding($false)))
        $stage = 'close'
        $box.Clear()
        $form.Close()
    } catch {
        $safeError = 'Save failed at ' + $stage + ': ' + $_.Exception.GetType().Name + ' (' + $_.Exception.HResult + ')'
        if ($SelfTest) { [Console]::WriteLine($safeError); $form.Close() }
        else { [System.Windows.Forms.MessageBox]::Show($safeError) }
    }
})
$form.Controls.AddRange(@($label,$box,$note,$button))
if ($SelfTest) { $form.Add_Shown({ $box.Text='test-fixture-not-a-key'; $button.PerformClick() }) }
[void]$form.ShowDialog()
if ($SelfTest -and (Test-Path -LiteralPath $configPath)) { [Console]::WriteLine('SETUP_WRITE_OK'); Remove-Item -LiteralPath $configPath }
