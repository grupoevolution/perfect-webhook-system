const express = require('express');
const axios = require('axios');
const app = express();

// Armazenamento em memória (lista de pedidos PIX pendentes)
let pendingPixOrders = new Map();

// Configurações
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook-test/f23c49cb-b6ed-4eea-84d8-3fe25753d9a5';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos em millisegundos

app.use(express.json());

// Endpoint principal que recebe webhooks da Perfect
app.post('/webhook/perfect', async (req, res) => {
    try {
        const data = req.body;
        const orderCode = data.code;
        const status = data.sale_status_enum_key;
        
        console.log(`📧 Webhook recebido - Pedido: ${orderCode} | Status: ${status}`);
        
        if (status === 'approved') {
            // VENDA APROVADA - Envia direto pro N8N (IMEDIATO)
            console.log(`✅ Venda aprovada - Enviando IMEDIATAMENTE para N8N: ${orderCode}`);
            
            // Remove da lista de PIX pendentes se existir
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
                pendingPixOrders.delete(orderCode);
                console.log(`🗑️ Removido da lista PIX pendente: ${orderCode}`);
            }
            
            // Envia webhook completo para N8N
            await sendToN8N(data, 'approved');
            
        } else if (status === 'pending') {
            // PIX GERADO - Armazena e agenda timeout
            console.log(`⏳ PIX gerado - Aguardando pagamento: ${orderCode}`);
            
            // Se já existe, cancela o timeout anterior
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
            }
            
            // Cria timeout de 7 minutos
            const timeout = setTimeout(async () => {
                console.log(`⏰ Timeout de 7 minutos atingido para: ${orderCode}`);
                
                // Remove da lista
                pendingPixOrders.delete(orderCode);
                
                // Envia webhook completo PIX não pago para N8N
                await sendToN8N(data, 'pix_timeout');
                
            }, PIX_TIMEOUT);
            
            // Armazena na lista
            pendingPixOrders.set(orderCode, {
                data: data,
                timeout: timeout,
                timestamp: new Date()
            });
            
            console.log(`📝 Pedido PIX armazenado: ${orderCode} (Timeout em 7min)`);
        }
        
        res.status(200).json({ success: true, message: 'Webhook processado' });
        
    } catch (error) {
        console.error('❌ Erro ao processar webhook:', error);
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
            processed_at: new Date().toISOString()
        };
        
        const response = await axios.post(N8N_WEBHOOK_URL, payload, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 10000 // 10 segundos de timeout
        });
        
        console.log(`🚀 Webhook COMPLETO enviado para N8N - Pedido: ${data.code} | Tipo: ${eventType} | Status: ${response.status}`);
        
    } catch (error) {
        console.error(`❌ Erro ao enviar webhook completo para N8N - Pedido: ${data.code}:`, error.message);
        
        // Aqui você pode implementar retry ou logs mais detalhados
    }
}

// Endpoint para monitoramento (ver pedidos pendentes)
app.get('/status', (req, res) => {
    const pendingList = Array.from(pendingPixOrders.entries()).map(([code, order]) => ({
        code: code,
        customer_name: order.data.customer.full_name,
        amount: order.data.sale_amount,
        created_at: order.timestamp,
        remaining_time: Math.max(0, PIX_TIMEOUT - (new Date() - order.timestamp))
    }));
    
    res.json({
        total_pending: pendingPixOrders.size,
        orders: pendingList
    });
});

// Endpoint para configurar URL do N8N
app.post('/config/n8n-url', (req, res) => {
    const { url } = req.body;
    if (url) {
        // Em produção, salve isso em variável de ambiente ou banco
        process.env.N8N_WEBHOOK_URL = url;
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
        pending_orders: pendingPixOrders.size
    });
});

// Interface web simples para monitoramento
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Perfect Pay → N8N Monitor</title>
            <meta charset="utf-8">
            <style>
                body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
                .status { background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 10px 0; }
                .pending { background: #fff3cd; }
                .approved { background: #d4edda; }
                button { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; }
                input { padding: 8px; width: 300px; margin: 5px; }
            </style>
        </head>
        <body>
            <h1>🔄 Perfect Pay → N8N Monitor</h1>
            
            <div class="status">
                <h3>📊 Status do Sistema</h3>
                <p>Status: <strong>Online</strong></p>
                <p>Pedidos PIX Pendentes: <span id="pending-count">Carregando...</span></p>
                <button onclick="refreshStatus()">Atualizar</button>
            </div>
            
            <div class="status">
                <h3>⚙️ Configuração</h3>
                <input type="text" id="n8n-url" placeholder="https://sua-url-n8n.com/webhook/perfect" />
                <br>
                <button onclick="saveN8nUrl()">Salvar URL do N8N</button>
            </div>
            
            <div id="pending-orders"></div>
            
            <script>
                function refreshStatus() {
                    fetch('/status')
                        .then(r => r.json())
                        .then(data => {
                            document.getElementById('pending-count').textContent = data.total_pending;
                            
                            const ordersDiv = document.getElementById('pending-orders');
                            if (data.orders.length > 0) {
                                ordersDiv.innerHTML = '<h3>⏳ Pedidos PIX Pendentes</h3>' + 
                                data.orders.map(order => 
                                    '<div class="status pending">' +
                                    '<strong>' + order.code + '</strong> - ' + order.customer_name + 
                                    '<br>Valor: R$ ' + order.amount + 
                                    '<br>Tempo restante: ' + Math.floor(order.remaining_time / 1000 / 60) + ' minutos' +
                                    '</div>'
                                ).join('');
                            } else {
                                ordersDiv.innerHTML = '<p>✅ Nenhum pedido PIX pendente</p>';
                            }
                        });
                }
                
                function saveN8nUrl() {
                    const url = document.getElementById('n8n-url').value;
                    fetch('/config/n8n-url', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({url: url})
                    }).then(() => alert('URL salva!'));
                }
                
                // Atualiza a cada 30 segundos
                setInterval(refreshStatus, 30000);
                refreshStatus();
            </script>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📡 Webhook URL Perfect: https://pre-webhook.flowzap.fun/webhook/perfect`);
    console.log(`🖥️ Interface Monitor: https://pre-webhook.flowzap.fun`);
    console.log(`🎯 N8N Webhook: ${N8N_WEBHOOK_URL}`);
});
