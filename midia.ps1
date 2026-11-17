# Player do Red Code: lê a mídia que está tocando no Windows (os mesmos controles do painel de volume)
# e recebe comandos pela entrada padrão ("alternar", "proxima", "anterior"). Escreve uma linha JSON
# a cada mudança; a capa (base64) só vai quando a música muda. Termina quando a entrada fecha.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$metodos = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTask = ($metodos | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
# Toda chamada ao Windows tem limite: o serviço de mídia às vezes emperra (Explorer ligado há dias) e nunca responde
function Espera($op, [Type]$tipo) { $t = $asTask.MakeGenericMethod($tipo).Invoke($null, @($op)); if (-not $t.Wait(5000)) { throw 'sem-resposta' }; $t.Result }
function EscreveJson($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
$paraStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))

function LeCapa($propriedades) {
    if (-not $propriedades.Thumbnail) { return $null }
    $fluxo = Espera ($propriedades.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $net = $paraStream.Invoke($null, @($fluxo))
    $memoria = New-Object System.IO.MemoryStream
    $net.CopyTo($memoria)
    $net.Dispose()
    if ($memoria.Length -gt 2MB) { return $null }
    [Convert]::ToBase64String($memoria.ToArray())
}

# A entrada é lida em paralelo (no PowerShell 5.1 o ReadLineAsync do console bloqueia) e cai numa fila
$fila = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
$leitor = [powershell]::Create()
$leitor.AddScript({ param($f) $in = [Console]::In; while ($true) { $l = $in.ReadLine(); if ($null -eq $l) { $f.Enqueue('__fim__'); break }; $f.Enqueue($l) } }).AddArgument($fila) | Out-Null
$leitor.BeginInvoke() | Out-Null
# Pede o gerente de mídia ao Windows; sem resposta, avisa e tenta de novo a cada 15 s (a tela mostra o aviso)
$gerente = $null
while (-not $gerente) {
    try { $gerente = Espera ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) }
    catch {
        EscreveJson @{ erro = 'servico'; detalhe = "$($_.Exception.Message)" }
        $comando = $null
        for ($i = 0; $i -lt 15; $i++) { if ($fila.TryDequeue([ref]$comando) -and $comando -eq '__fim__') { exit }; Start-Sleep -Seconds 1 }
    }
}
$ultimoJson = ''
$musicaDaCapa = ''
# Leitura rápida a cada ~120 ms (só o app e o tocar/pausar, que é barato); mudou -> lê tudo na hora. A completa
# (título, capa, posição) também roda a cada 900 ms
$ultimoRapido = ''
$proximaCompleta = [DateTime]::MinValue
while ($true) {
    # Comando da tela (não bloqueia: a leitura da entrada corre por fora)
    $comando = $null
    if ($fila.TryDequeue([ref]$comando)) {
        if ($comando -eq '__fim__') { break }
        try {
            $sessao = $gerente.GetCurrentSession()
            if ($sessao) {
                switch ($comando.Trim()) {
                    'alternar' { Espera ($sessao.TryTogglePlayPauseAsync()) ([bool]) | Out-Null }
                    'proxima' { Espera ($sessao.TrySkipNextAsync()) ([bool]) | Out-Null }
                    'anterior' { Espera ($sessao.TrySkipPreviousAsync()) ([bool]) | Out-Null }
                    { $_ -like 'posicao *' } {
                        $segundos = [double]::Parse($_.Substring(8), [Globalization.CultureInfo]::InvariantCulture)
                        $inicio = $sessao.GetTimelineProperties().StartTime.Ticks
                        Espera ($sessao.TryChangePlaybackPositionAsync([long]($inicio + $segundos * 10000000))) ([bool]) | Out-Null
                    }
                }
            }
        } catch { }
        Start-Sleep -Milliseconds 100
        $proximaCompleta = [DateTime]::MinValue
    }
    $rapido = ''
    try { $s = $gerente.GetCurrentSession(); if ($s) { $rapido = "$($s.SourceAppUserModelId)|$($s.GetPlaybackInfo().PlaybackStatus)" } } catch { }
    if ($rapido -eq $ultimoRapido -and [DateTime]::UtcNow -lt $proximaCompleta) { Start-Sleep -Milliseconds 120; continue }
    $ultimoRapido = $rapido
    $proximaCompleta = [DateTime]::UtcNow.AddMilliseconds(900)
    try {
        $sessao = $gerente.GetCurrentSession()
        if (-not $sessao) { $estado = [ordered]@{ nada = $true }; $musicaDaCapa = '' }
        else {
            $p = Espera ($sessao.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            $info = $sessao.GetPlaybackInfo()
            $linhaTempo = $sessao.GetTimelineProperties()
            $estado = [ordered]@{
                app = $sessao.SourceAppUserModelId; titulo = $p.Title; artista = $p.Artist; album = $p.AlbumTitle
                estado = "$($info.PlaybackStatus)"; podeAlternar = $info.Controls.IsPlayPauseToggleEnabled; podeProxima = $info.Controls.IsNextEnabled; podeBuscar = $info.Controls.IsPlaybackPositionEnabled
                posicao = [math]::Round($linhaTempo.Position.TotalSeconds, 1); duracao = [math]::Round(($linhaTempo.EndTime - $linhaTempo.StartTime).TotalSeconds, 1)
                atualizadoEm = $linhaTempo.LastUpdatedTime.ToUnixTimeMilliseconds()
            }
            $musica = "$($p.Title)|$($p.Artist)|$($p.AlbumTitle)"
            if ($musica -ne $musicaDaCapa) {
                try { $capa = LeCapa $p } catch { $capa = $null }
                $estado.capa = if ($capa) { $capa } else { '' }
                $musicaDaCapa = $musica
            }
        }
        $json = $estado | ConvertTo-Json -Compress
        if ($json -ne $ultimoJson) { [Console]::Out.WriteLine($json); [Console]::Out.Flush(); $ultimoJson = $json }
    } catch {
        $msg = "$($_.Exception.Message)"
        $json = (@{ erro = $(if ($msg -match 'sem-resposta') { 'servico' } else { $msg }) } | ConvertTo-Json -Compress)
        if ($json -ne $ultimoJson) { [Console]::Out.WriteLine($json); [Console]::Out.Flush(); $ultimoJson = $json }
    }
    Start-Sleep -Milliseconds 120
}
