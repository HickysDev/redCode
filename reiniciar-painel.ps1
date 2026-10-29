# Reinicia o servidor do Painel Claude SÓ quando é seguro: nenhum processo do Claude aberto
# pelo painel pode morrer junto (resposta em andamento, processo parado esperando mensagem,
# agente em segundo plano). Pergunta ao próprio painel, não adivinha pela lista de processos.
# Uso: .\reiniciar-painel.ps1            -> recusa se houver algo vivo
#      .\reiniciar-painel.ps1 -Esperar   -> fecha os parados sem agente, espera o resto e reinicia
param([switch]$Esperar, [int]$Porta = 4317)

$pasta = $PSScriptRoot
$andamento = Join-Path $pasta 'ANDAMENTO-reinicio.txt'
$base = "http://127.0.0.1:$Porta"
function Anota($texto) {
    $linha = "$(Get-Date -Format 'HH:mm:ss') $texto"
    Add-Content -Path $andamento -Value $linha -Encoding UTF8
    Write-Output $linha
}

function ConversasVivas {
    # Devolve a lista dentro de um objeto: lista vazia no PowerShell vira "nada" e se confundiria com erro
    try {
        $estado = Invoke-RestMethod "$base/api/chat/estado" -TimeoutSec 10
        return [pscustomobject]@{ ok = $true; vivas = @($estado | Where-Object { $_.vivo -or $_.status -eq 'rodando' -or $_.status -eq 'parando' }) }
    } catch {
        return [pscustomobject]@{ ok = $false; vivas = @() }
    }
}

Set-Content -Path $andamento -Value '' -Encoding UTF8
Anota "[1/2] Perguntando ao painel (porta $Porta) se há processo do Claude vivo"
while ($true) {
    $consulta = ConversasVivas
    if (-not $consulta.ok) { Anota 'O painel não respondeu; não vou reiniciar às cegas.'; Anota 'FIM'; exit 1 }
    $vivas = $consulta.vivas
    if (-not $vivas.Count) { break }
    if (-not $Esperar) {
        Anota "Há $($vivas.Count) conversa(s) com processo vivo no painel. NÃO reiniciei."
        Anota 'FIM'
        exit 1
    }
    # Fecha na hora só as paradas e sem agente; as outras ficam até terminar
    try {
        $r = Invoke-RestMethod -Method Post "$base/api/chat/fechar-ociosas" -Headers @{ 'X-Painel' = '1' } -ContentType 'application/json' -Body '{"minutos":0}'
        if ($r.fechadas.Count) { Anota "Fechei $($r.fechadas.Count) conversa(s) parada(s) e sem agente." }
    } catch {}
    $resumo = ($vivas | ForEach-Object { "$($_.status): $([string]$_.texto | ForEach-Object { $_.Substring(0, [math]::Min(40, $_.Length)) })" }) -join ' | '
    Anota "Esperando $($vivas.Count) conversa(s): $resumo"
    Start-Sleep -Seconds 15
}

Anota '[2/2] Nada vivo no painel. Reiniciando o servidor'
$conexao = Get-NetTCPConnection -LocalPort $Porta -State Listen -ErrorAction SilentlyContinue
if ($conexao) { Stop-Process -Id ($conexao | Select-Object -First 1).OwningProcess -Force; Start-Sleep -Milliseconds 500 }
$env:PAINEL_PORTA = "$Porta"
Start-Process node -ArgumentList "`"$(Join-Path $pasta 'lancador.js')`"" -WorkingDirectory $pasta -WindowStyle Hidden
Start-Sleep -Seconds 3
Anota "Servidor reiniciado em http://localhost:$Porta"
Anota 'FIM'
