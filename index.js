const express = require('express');
const axios = require('axios');
const app = express();

// Armazenamento em memória (lista de pedidos PIX pendentes)
let pendingPixOrders = new Map();

// Sistema de logs das últimas 1 hora
let systemLogs = [];
const LOG_RETENTION_TIME = 60 * 60 * 1000; // 1 hora em millisegundos

// Configurações
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/f23c49cb-b6ed-4eea-84d8-3fe25753d9a5';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos em millisegundos

app.use(express.json());

// Função para adicionar logs com timestamp
function addLog(type, message, data = null) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        type: type, // 'info', 'success', 'error', 'webhook_received', 'webhook_sent', 'timeout'
        message: message,
        data: data
    };
    
    systemLogs.push(logEntry);
    console.log(`[${logEntry.timestamp}] ${type.toUpperCase()}: ${message}`);
    
    // Remove logs mais antigos que 1 hora
    const oneHourAgo = Date.now() - LOG_RETENTION_TIME;
    systemLogs = systemLogs.filter(log => new Date(log.timestamp).getTime() > oneHourAgo);
}

// Endpoint principal que recebe webhooks da Perfect
app.post('/webhook/perfect', async (req, res) => {
    try {
        const data = req.body;
        const orderCode = data.code;
        const status = data.sale_status_enum_key;
        const customerName = data.customer?.full_name || 'N/A';
        const amount = data.sale_amount || 0;
        
        addLog('webhook_received', `Webhook recebido - Pedido: ${orderCode} | Status: ${status} | Cliente: ${customerName} | Valor: R$ ${amount}`, {
            order_code: orderCode,
            status: status,
            customer: customerName,
            amount: amount,
            full_data: data
        });
        
        if (status === 'approved') {
            // VENDA APROVADA - Envia direto pro N8N (IMEDIATO)
            addLog('info', `✅ VENDA APROVADA - Processando pedido: ${orderCode}`);
            
            // Remove da lista de PIX pendentes se existir
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
                pendingPixOrders.delete(orderCode);
                addLog('info', `🗑️ Removido da lista PIX pendente: ${orderCode}`);
            }
            
            // Envia webhook completo para N8N
            const sendResult = await sendToN8N(data, 'approved');
            
            if (sendResult.success) {
                addLog('success', `✅ VENDA APROVADA enviada com sucesso para N8N: ${orderCode}`);
            } else {
                addLog('error', `❌ ERRO ao enviar VENDA APROVADA para N8N: ${orderCode} - ${sendResult.error}`);
            }
            
        } else if (status === 'pending') {
            // PIX GERADO - Armazena e agenda timeout
            addLog('info', `⏳ PIX GERADO - Aguardando pagamento: ${orderCode} | Timeout: 7 minutos`);
            
            // Se já existe, cancela o timeout anterior
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
                addLog('info', `🔄 Timeout anterior cancelado para: ${orderCode}`);
            }
            
            // Cria timeout de 7 minutos
            const timeout = setTimeout(async () => {
                addLog('timeout', `⏰ TIMEOUT de 7 minutos atingido para: ${orderCode} - Enviando PIX não pago`);
                
                // Remove da lista
                pendingPixOrders.delete(orderCode);
                
                // Envia webhook completo PIX não pago para N8N
                const sendResult = await sendToN8N(data, 'pix_timeout');
                
                if (sendResult.success) {
                    addLog('success', `✅ PIX TIMEOUT enviado com sucesso para N8N: ${orderCode}`);
                } else {
                    addLog('error', `❌ ERRO ao enviar PIX TIMEOUT para N8N: ${orderCode} - ${sendResult.error}`);
                }
                
            }, PIX_TIMEOUT);
            
            // Armazena na lista
            pendingPixOrders.set(orderCode, {
                data: data,
                timeout: timeout,
                timestamp: new Date(),
                customer_name: customerName,
                amount: amount
            });
            
            addLog('info', `📝 Pedido PIX armazenado: ${orderCode} | Cliente: ${customerName} | Valor: R$ ${amount}`);
            
        } else {
            // Status desconhecido
            addLog('info', `❓ Status desconhecido recebido: ${status} para pedido: ${orderCode}`);
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook processado com sucesso',
            order_code: orderCode,
            status: status,
            processed_at: new Date().toISOString()
        });
        
    } catch (error) {
        addLog('error', `❌ ERRO ao processar webhook: ${error.message}`, { error: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função para enviar dados para N8N
async function sendToN8N(data, eventType) {
    try {
        // Envia o webhook COMPLETO da Perfect + nosso event_type
        const payload = {
            ...data, // WEBHOOK COMPLETO DA PERFECT
            event_type: eventType, // 'approved' ou 'pix_timeout'
            processed_at: new Date().toISOString(),
            system_info: {
                source: 'perfect-webhook-system',
                version: '2.0'
            }
        };
        
        addLog('info', `🚀 Tentando enviar para N8N - Pedido: ${data.code} | Tipo: ${eventType} | URL: ${N8N_WEBHOOK_URL}`);
        
        const response = await axios.post(N8N_WEBHOOK_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Perfect-Webhook-System/2.0'
            },
            timeout: 15000 // 15 segundos de timeout
        });
        
        addLog('webhook_sent', `✅ Webhook enviado com SUCESSO para N8N - Pedido: ${data.code} | Tipo: ${eventType} | Status HTTP: ${response.status}`, {
            order_code: data.code,
            event_type: eventType,
            http_status: response.status,
            response_data: response.data
        });
        
        return { success: true, status: response.status, data: response.data };
        
    } catch (error) {
        const errorMessage = error.response ? 
            `HTTP ${error.response.status}: ${error.response.statusText}` : 
            error.message;
            
        addLog('error', `❌ ERRO ao enviar para N8N - Pedido: ${data.code} | Erro: ${errorMessage}`, {
            order_code: data.code,
            event_type: eventType,
            error: errorMessage,
            error_details: error.response?.data
        });
        
        return { success: false, error: errorMessage };
    }
}

// Endpoint para monitoramento completo
app.get('/status', (req, res) => {
    const pendingList = Array.from(pendingPixOrders.entries()).map(([code, order]) => ({
        code: code,
        customer_name: order.customer_name,
        amount: order.amount,
        created_at: order.timestamp,
        remaining_time: Math.max(0, PIX_TIMEOUT - (new Date() - order.timestamp))
    }));
    
    // Estatísticas dos logs da última hora
    const stats = {
        total_webhooks_received: systemLogs.filter(log => log.type === 'webhook_received').length,
        approved_received: systemLogs.filter(log => log.type === 'webhook_received' && log.data?.status === 'approved').length,
        pix_generated: systemLogs.filter(log => log.type === 'webhook_received' && log.data?.status === 'pending').length,
        webhooks_sent: systemLogs.filter(log => log.type === 'webhook_sent').length,
        timeouts_triggered: systemLogs.filter(log => log.type === 'timeout').length,
        errors: systemLogs.filter(log => log.type === 'error').length
    };
    
    res.json({
        system_status: 'online',
        timestamp: new Date().toISOString(),
        pending_pix_orders: pendingPixOrders.size,
        orders: pendingList,
        logs_last_hour: systemLogs,
        statistics: stats,
        n8n_webhook_url: N8N_WEBHOOK_URL
    });
});

// Endpoint para configurar URL do N8N
app.post('/config/n8n-url', (req, res) => {
    const { url } = req.body;
    if (url) {
        process.env.N8N_WEBHOOK_URL = url;
        addLog('info', `⚙️ URL do N8N atualizada para: ${url}`);
        res.json({ success: true, message: 'URL do N8N configurada' });
    } else {
        res.status(400).json({ success: false, message: 'URL não fornecida' });
    }
});

// Endpoint de health check
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        pending_orders: pendingPixOrders.size,
        logs_count: systemLogs.length,
        uptime: process.uptime()
    });
});

// Interface web melhorada com logs
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Perfect Pay → N8N Monitor v2.0</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: 'Segoe UI', Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
                .container { background: white; padding: 20px; border-radius: 10px; margin: 10px 0; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
                .status { padding: 15px; border-radius: 8px; margin: 10px 0; }
                .online { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
                .pending { background: #fff3cd; color: #856404; border: 1px solid #ffeaa7; }
                .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
                .success { background: #d1ecf1; color: #0c5460; border: 1px solid #bee5eb; }
                button { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin: 5px; }
                button:hover { background: #0056b3; }
                input { padding: 10px; width: 400px; margin: 5px; border: 1px solid #ddd; border-radius: 5px; }
                .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }
                .stat-card { background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center; border-left: 4px solid #007bff; }
                .logs { max-height: 400px; overflow-y: auto; background: #1a1a1a; color: #00ff00; padding: 15px; border-radius: 8px; font-family: 'Courier New', monospace; font-size: 12px; }
                .log-entry { margin: 2px 0; padding: 2px 0; }
                .log-webhook_received { color: #ffeb3b; }
                .log-webhook_sent { color: #4caf50; }
                .log-error { color: #f44336; }
                .log-timeout { color: #ff9800; }
                .log-success { color: #8bc34a; }
                .refresh-btn { background: #28a745; }
                .clear-logs-btn { background: #dc3545; }
                h1 { color: #333; text-align: center; }
                h3 { color: #495057; border-bottom: 2px solid #007bff; padding-bottom: 5px; }
            </style>
        </head>
        <body>
            <h1>🔄 Perfect Pay → N8N Monitor v2.0</h1>
            
            <div class="container">
                <h3>📊 Status do Sistema</h3>
                <div class="status online">
                    <strong>Status:</strong> Online | 
                    <strong>Pedidos PIX Pendentes:</strong> <span id="pending-count">Carregando...</span> | 
                    <strong>Logs última hora:</strong> <span id="logs-count">0</span>
                </div>
                
                <div class="stats">
                    <div class="stat-card">
                        <h4>📨 Webhooks Recebidos</h4>
                        <div id="total-received">0</div>
                    </div>
                    <div class="stat-card">
                        <h4>✅ Vendas Aprovadas</h4>
                        <div id="approved-count">0</div>
                    </div>
                    <div class="stat-card">
                        <h4>💳 PIX Gerados</h4>
                        <div id="pix-count">0</div>
                    </div>
                    <div class="stat-card">
                        <h4>🚀 Enviados N8N</h4>
                        <div id="sent-count">0</div>
                    </div>
                    <div class="stat-card">
                        <h4>⏰ Timeouts</h4>
                        <div id="timeout-count">0</div>
                    </div>
                    <div class="stat-card">
                        <h4>❌ Erros</h4>
                        <div id="error-count">0</div>
                    </div>
                </div>
                
                <button class="refresh-btn" onclick="refreshStatus()">🔄 Atualizar</button>
                <button class="clear-logs-btn" onclick="clearLogs()">🗑️ Limpar Logs</button>
            </div>
            
            <div class="container">
                <h3>⚙️ Configuração N8N</h3>
                <input type="text" id="n8n-url" placeholder="https://n8n.flowzap.fun/webhook/..." value="${N8N_WEBHOOK_URL}" />
                <br>
                <button onclick="saveN8nUrl()">💾 Salvar URL do N8N</button>
            </div>
            
            <div class="container">
                <h3>⏳ Pedidos PIX Pendentes</h3>
                <div id="pending-orders">Carregando...</div>
            </div>
            
            <div class="container">
                <h3>📋 Logs da Última Hora (Tempo Real)</h3>
                <div class="logs" id="logs-container">Carregando logs...</div>
            </div>
            
            <script>
                function refreshStatus() {
                    fetch('/status')
                        .then(r => r.json())
                        .then(data => {
                            // Atualiza contadores
                            document.getElementById('pending-count').textContent = data.pending_pix_orders;
                            document.getElementById('logs-count').textContent = data.logs_last_hour.length;
                            
                            // Atualiza estatísticas
                            document.getElementById('total-received').textContent = data.statistics.total_webhooks_received;
                            document.getElementById('approved-count').textContent = data.statistics.approved_received;
                            document.getElementById('pix-count').textContent = data.statistics.pix_generated;
                            document.getElementById('sent-count').textContent = data.statistics.webhooks_sent;
                            document.getElementById('timeout-count').textContent = data.statistics.timeouts_triggered;
                            document.getElementById('error-count').textContent = data.statistics.errors;
                            
                            // Atualiza pedidos pendentes
                            const ordersDiv = document.getElementById('pending-orders');
                            if (data.orders.length > 0) {
                                ordersDiv.innerHTML = data.orders.map(order => 
                                    '<div class="status pending">' +
                                    '<strong>' + order.code + '</strong> - ' + order.customer_name + 
                                    '<br><strong>Valor:</strong> R$ ' + order.amount + 
                                    '<br><strong>Tempo restante:</strong> ' + Math.floor(order.remaining_time / 1000 / 60) + ' minutos' +
                                    '</div>'
                                ).join('');
                            } else {
                                ordersDiv.innerHTML = '<div class="status success">✅ Nenhum pedido PIX pendente</div>';
                            }
                            
                            // Atualiza logs
                            const logsDiv = document.getElementById('logs-container');
                            if (data.logs_last_hour.length > 0) {
                                logsDiv.innerHTML = data.logs_last_hour
                                    .slice(-50) // Últimos 50 logs
                                    .reverse()
                                    .map(log => 
                                        '<div class="log-entry log-' + log.type + '">' +
                                        '[' + new Date(log.timestamp).toLocaleString() + '] ' +
                                        log.type.toUpperCase() + ': ' + log.message +
                                        '</div>'
                                    ).join('');
                                logsDiv.scrollTop = 0; // Scroll para o topo (logs mais recentes)
                            } else {
                                logsDiv.innerHTML = '<div class="log-entry">Nenhum log registrado na última hora</div>';
                            }
                        })
                        .catch(err => {
                            console.error('Erro ao buscar status:', err);
                        });
                }
                
                function saveN8nUrl() {
                    const url = document.getElementById('n8n-url').value;
                    fetch('/config/n8n-url', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({url: url})
                    })
                    .then(r => r.json())
                    .then(data => {
                        alert(data.message);
                        if (data.success) refreshStatus();
                    });
                }
                
                function clearLogs() {
                    if (confirm('Tem certeza que deseja limpar todos os logs?')) {
                        // Implementar endpoint para limpar logs se necessário
                        alert('Logs serão limpos automaticamente após 1 hora');
                    }
                }
                
                // Atualiza automaticamente a cada 10 segundos
                setInterval(refreshStatus, 10000);
                
                // Carrega dados iniciais
                refreshStatus();
            </script>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    addLog('info', `🚀 Sistema Perfect Webhook v2.0 iniciado na porta ${PORT}`);
    addLog('info', `📡 Webhook Perfect Pay: https://pre-webhook.flowzap.fun/webhook/perfect`);
    addLog('info', `🖥️ Interface Monitor: https://pre-webhook.flowzap.fun`);
    addLog('info', `🎯 N8N Webhook: ${N8N_WEBHOOK_URL}`);
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📡 Webhook URL Perfect: https://pre-webhook.flowzap.fun/webhook/perfect`);
    console.log(`🖥️ Interface Monitor: https://pre-webhook.flowzap.fun`);
    console.log(`🎯 N8N Webhook: ${N8N_WEBHOOK_URL}`);
});
