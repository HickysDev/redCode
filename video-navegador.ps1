$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Espera($op, [Type]$tipo) { $t = $asTask.MakeGenericMethod($tipo).Invoke($null, @($op)); if (-not $t.Wait(5000)) { throw 'sem-resposta' }; $t.Result }
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null

$NAVEGADORES = @('chrome', 'msedge', 'brave', 'opera', 'vivaldi', 'firefox', 'arc', 'yandex', 'chromium', 'zen', 'librewolf', 'waterfox', 'floorp')
$AUMID_ESPECIAL = @{ firefox = '(?i)firefox|308046B0AF4A39CB'; arc = '(?i)TheBrowserCompany|(^|[.!])arc([.!_]|$)' }
$ID_YOUTUBE = '(?i)(?:^|[/.])youtube(?:-nocookie)?\.com/(?:watch\?(?:[^#]*&)?v=|shorts/|embed/|live/)([\w-]{11})|youtu\.be/([\w-]{11})'
$Automacao = [Windows.Automation.AutomationElement]
$Tipo = [Windows.Automation.ControlType]
$caminhante = [Windows.Automation.TreeWalker]::ControlViewWalker
$condJanelas = New-Object Windows.Automation.OrCondition(
    (New-Object Windows.Automation.PropertyCondition($Automacao::ClassNameProperty, 'Chrome_WidgetWin_1')),
    (New-Object Windows.Automation.PropertyCondition($Automacao::ClassNameProperty, 'MozillaWindowClass')))
$nomeProcesso = @{}
$enderecos = @{}

function EhNavegador($processoId) {
    if (-not $nomeProcesso.ContainsKey($processoId)) {
        $nomeProcesso[$processoId] = try { (Get-Process -Id $processoId).ProcessName.ToLowerInvariant() } catch { '' }
    }
    $NAVEGADORES -contains $nomeProcesso[$processoId]
}

function SessaoEhDoNavegador($s, [string]$processo) {
    $padrao = if ($AUMID_ESPECIAL.ContainsKey($processo)) { $AUMID_ESPECIAL[$processo] } else { '(?i)(^|[\.])' + [regex]::Escape($processo) + '([\.]|$)' }
    $s.aumid -match $padrao
}

function Normaliza([string]$texto) { ($texto -replace '^\(\d+\)\s*', '').Trim().ToLowerInvariant() }

# NAO DESCE NO DOCUMENT: LER A PAGINA LIGA A ACESSIBILIDADE DO SITE E PESA NO NAVEGADOR
function AchaEndereco($elemento, [int]$nivel) {
    if ($nivel -gt 18) { return $null }
    $filho = $caminhante.GetFirstChild($elemento)
    while ($filho) {
        $tipo = $filho.Current.ControlType
        $valor = if ($tipo -eq $Tipo::Edit) { try { $filho.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { '' } } else { '' }
        if ($valor -match '^(?:[a-z]+://)?[\w.-]+\.[a-z]{2,}(?:[/?#:]|$)') { return $valor }
        # NO OPERA O CAMPO COM O ENDERECO FICA DENTRO DE OUTRO EDIT VAZIO
        if ($tipo -ne $Tipo::Document) {
            $achou = AchaEndereco $filho ($nivel + 1)
            if ($achou) { return $achou }
        }
        $filho = $caminhante.GetNextSibling($filho)
    }
    $null
}

function EnderecoDaJanela($janela, [int]$hwnd, [string]$titulo) {
    $cache = $enderecos[$hwnd]
    if ($cache -and $cache.titulo -eq $titulo -and [DateTime]::UtcNow -lt $cache.validoAte) { return $cache.endereco }
    $endereco = try { AchaEndereco $janela 0 } catch { $null }
    $enderecos[$hwnd] = @{ titulo = $titulo; endereco = $endereco; validoAte = [DateTime]::UtcNow.AddSeconds(10) }
    $endereco
}

function SessoesDeNavegador($gerente) {
    $lista = @()
    foreach ($sessao in $gerente.GetSessions()) {
        try {
            $p = Espera ($sessao.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            $lista += [pscustomobject]@{ sessao = $sessao; titulo = "$($p.Title)"; artista = "$($p.Artist)"; chave = (Normaliza $p.Title); aumid = "$($sessao.SourceAppUserModelId)" }
        } catch { }
    }
    $lista
}

function SessaoDaJanela($sessoes, [string]$tituloJanela, [string]$processo, [int]$janelasYoutube) {
    $chaveJanela = Normaliza $tituloJanela
    $porTitulo = @($sessoes | Where-Object { $_.chave -and $chaveJanela.Contains($_.chave) })
    $doMesmo = $porTitulo | Where-Object { SessaoEhDoNavegador $_ $processo } | Select-Object -First 1
    if ($doMesmo) { return $doMesmo }
    if ($porTitulo.Count) { return $porTitulo[0] }
    # TITULO DA ABA DIFERENTE DO DA MUSICA (EX. YOUTUBE MUSIC): SO COM UMA SESSAO E UMA JANELA DO YOUTUBE NESTE NAVEGADOR
    $doNavegador = @($sessoes | Where-Object { SessaoEhDoNavegador $_ $processo })
    if ($doNavegador.Count -eq 1 -and $janelasYoutube -eq 1 -and $chaveJanela -match 'youtube') { return $doNavegador[0] }
    $null
}

function VideoDaJanela($janela, $sessoes, $janelasYoutube) {
    $hwnd = [int]$janela.Current.NativeWindowHandle
    $titulo = "$($janela.Current.Name)"
    if (-not $titulo -or -not (EhNavegador $janela.Current.ProcessId)) { return $null }
    $processo = $nomeProcesso[$janela.Current.ProcessId]
    $s = SessaoDaJanela $sessoes $titulo $processo ([int]$janelasYoutube[$processo])
    if (-not $s) { return $null }
    $endereco = EnderecoDaJanela $janela $hwnd $titulo
    if (-not $endereco -or $endereco -notmatch $ID_YOUTUBE) { return $null }
    $id = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
    $info = $s.sessao.GetPlaybackInfo()
    $linha = $s.sessao.GetTimelineProperties()
    $tocando = "$($info.PlaybackStatus)" -eq 'Playing'
    $taxa = if ($info.PlaybackRate) { [double]$info.PlaybackRate } else { 1.0 }
    $tempo = $linha.Position.TotalSeconds
    if ($tocando) { $tempo += ([DateTimeOffset]::UtcNow - $linha.LastUpdatedTime).TotalSeconds * $taxa }
    [ordered]@{
        aba = $hwnd; id = $id; tempo = [math]::Round([math]::Max(0.0, $tempo), 2); duracao = [math]::Round(($linha.EndTime - $linha.StartTime).TotalSeconds, 1)
        pausado = -not $tocando; taxa = $taxa; titulo = (@($s.titulo, $s.artista) | Where-Object { $_ }) -join ' - '
        site = $(if ($endereco -match '(?i)music\.youtube\.com') { 'YouTube Music' } else { 'YouTube' })
        quando = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        marca = "$id|$tocando|$taxa|$($linha.Position.TotalSeconds)|$($linha.LastUpdatedTime.Ticks)"
    }
}

$fila = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
$leitor = [powershell]::Create()
$leitor.AddScript({ param($f) $in = [Console]::In; while ($true) { $l = $in.ReadLine(); if ($null -eq $l) { $f.Enqueue('__fim__'); break } } }).AddArgument($fila) | Out-Null
$leitor.BeginInvoke() | Out-Null

$gerente = $null
$ultimaMarca = ''
$proximoEnvio = [DateTime]::MinValue
while ($true) {
    $comando = $null
    if ($fila.TryDequeue([ref]$comando) -and $comando -eq '__fim__') { break }
    $videos = @()
    try {
        if (-not $gerente) { $gerente = Espera ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) }
        $sessoes = @(SessoesDeNavegador $gerente)
        if ($sessoes.Count) {
            $janelas = @($Automacao::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $condJanelas))
            $janelasYoutube = @{}
            foreach ($janela in $janelas) {
                try { if ((EhNavegador $janela.Current.ProcessId) -and "$($janela.Current.Name)" -match '(?i)youtube') { $janelasYoutube[$nomeProcesso[$janela.Current.ProcessId]]++ } } catch { }
            }
            foreach ($janela in $janelas) {
                try { $v = VideoDaJanela $janela $sessoes $janelasYoutube; if ($v) { $videos += $v } } catch { }
            }
        }
    } catch { $gerente = $null }
    $marca = ($videos | ForEach-Object { "$($_.aba)|$($_.marca)" }) -join ';'
    if ($marca -ne $ultimaMarca -or [DateTime]::UtcNow -ge $proximoEnvio) {
        foreach ($v in $videos) { $v.Remove('marca') }
        [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 3 @{ videos = @($videos) }))
        [Console]::Out.Flush()
        $ultimaMarca = $marca
        $proximoEnvio = [DateTime]::UtcNow.AddSeconds(2)
    }
    Start-Sleep -Milliseconds 400
}
