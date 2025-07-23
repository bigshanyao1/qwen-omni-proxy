// server.js - 改进版 Qwen Omni Realtime 代理服务器
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// 配置 CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// 健康检查端点
app.get('/', (req, res) => {
    res.json({
        status: 'Qwen Omni Realtime Proxy Server',
        version: '1.1.0',
        timestamp: new Date().toISOString(),
        endpoints: {
            websocket: '/api/qwen-realtime',
            health: '/health'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// WebSocket 服务器
const wss = new WebSocket.Server({ 
    server, 
    path: '/api/qwen-realtime',
    perMessageDeflate: false,
    clientTracking: true
});

// API Key
const QWEN_API_KEY = process.env.QWEN_API_KEY || 'sk-1c91f0e955a94c688c7992a724ceea18';
const QWEN_API_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';

console.log('🔑 API Key configured:', QWEN_API_KEY ? 'Yes' : 'No');

wss.on('connection', (clientWs, request) => {
    console.log('🔗 客户端连接:', request.connection.remoteAddress);
    
    // 获取查询参数
    const url = new URL(request.url, `http://${request.headers.host}`);
    const model = url.searchParams.get('model') || 'qwen-omni-turbo-realtime';
    
    console.log('📝 连接参数:', { model });
    
    // 连接状态
    let qwenWs = null;
    let isQwenConnected = false;
    let sessionConfigured = false;
    let lastActivity = Date.now();
    let messageBuffer = [];
    
    // 创建到 Qwen API 的连接
    function connectToQwen() {
        const qwenUrl = `${QWEN_API_URL}?model=${model}`;
        console.log('🌐 连接到 Qwen API:', qwenUrl);
        
        qwenWs = new WebSocket(qwenUrl, {
            headers: {
                'Authorization': `Bearer ${QWEN_API_KEY}`,
                'User-Agent': 'QwenProxy/1.1',
                'Origin': 'https://qwen-omni-proxy-production.up.railway.app'
            }
        });
        
        // Qwen 连接成功
        qwenWs.on('open', () => {
            console.log('✅ Qwen API 连接成功');
            isQwenConnected = true;
            
            // 通知客户端代理连接成功
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                    type: 'proxy.connected',
                    message: '代理连接成功',
                    timestamp: new Date().toISOString()
                }));
            }
            
            // 等待一下再配置会话，确保连接完全建立
            setTimeout(() => {
                if (qwenWs && qwenWs.readyState === WebSocket.OPEN && !sessionConfigured) {
                    configureSession();
                }
            }, 500);
            
            // 处理缓冲的消息
            processBufferedMessages();
        });
        
        // 收到 Qwen 的消息
        qwenWs.on('message', (data) => {
            lastActivity = Date.now();
            
            try {
                const message = JSON.parse(data.toString());
                console.log('📨 Qwen -> Client:', message.type || 'unknown');
                
                // 标记会话已配置
                if (message.type === 'session.updated') {
                    sessionConfigured = true;
                    console.log('✅ 会话配置完成');
                }
                
                // 转发给客户端
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(data);
                }
            } catch (error) {
                console.error('消息解析错误:', error);
                // 即使解析失败，也转发原始数据
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(data);
                }
            }
        });
        
        // Qwen 连接错误
        qwenWs.on('error', (error) => {
            console.error('❌ Qwen WebSocket 错误:', error.message);
            isQwenConnected = false;
            
            if (clientWs.readyState === WebSocket.OPEN) {
                let errorMessage = '连接到AI服务时出现错误';
                
                if (error.message.includes('401') || error.message.includes('Unauthorized')) {
                    errorMessage = 'API密钥无效，请检查配置';
                } else if (error.message.includes('403')) {
                    errorMessage = 'API访问被拒绝，请检查权限';
                } else if (error.message.includes('timeout')) {
                    errorMessage = '连接超时，请稍后重试';
                }
                
                clientWs.send(JSON.stringify({
                    type: 'error',
                    error: { 
                        message: errorMessage,
                        code: 'QWEN_ERROR'
                    }
                }));
            }
        });
        
        // Qwen 连接关闭
        qwenWs.on('close', (code, reason) => {
            console.log('🔌 Qwen 连接关闭:', code, reason.toString());
            isQwenConnected = false;
            sessionConfigured = false;
        });
    }
    
    // 配置会话
    function configureSession() {
        if (!qwenWs || qwenWs.readyState !== WebSocket.OPEN) {
            console.log('⚠️ 无法配置会话，Qwen未连接');
            return;
        }
        
        const sessionConfig = {
            type: "session.update",
            event_id: "event_" + Date.now(),
            session: {
                modalities: ["text", "audio"],
                voice: "Ethan",
                input_audio_format: "pcm16",
                output_audio_format: "pcm16",
                input_audio_transcription: {
                    model: "gummy-realtime-v1"
                },
                turn_detection: null
            }
        };
        
        console.log('📝 发送会话配置');
        qwenWs.send(JSON.stringify(sessionConfig));
    }
    
    // 处理缓冲的消息
    function processBufferedMessages() {
        if (messageBuffer.length > 0 && qwenWs && qwenWs.readyState === WebSocket.OPEN) {
            console.log(`📤 处理 ${messageBuffer.length} 条缓冲消息`);
            
            while (messageBuffer.length > 0) {
                const bufferedMessage = messageBuffer.shift();
                qwenWs.send(bufferedMessage);
            }
        }
    }
    
    // 客户端消息处理
    clientWs.on('message', (data) => {
        lastActivity = Date.now();
        
        try {
            const message = JSON.parse(data.toString());
            console.log('📤 Client -> Qwen:', message.type || 'unknown');
            
            // 检查 Qwen 连接状态
            if (!qwenWs || qwenWs.readyState !== WebSocket.OPEN) {
                if (!isQwenConnected) {
                    // 如果从未连接过，先连接
                    console.log('🔄 首次连接到 Qwen API');
                    connectToQwen();
                }
                
                // 将消息加入缓冲区
                console.log('📥 消息加入缓冲区');
                messageBuffer.push(data.toString());
                
                // 通知客户端正在处理
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        type: 'system.info',
                        message: '正在建立AI连接，请稍候...'
                    }));
                }
                return;
            }
            
            // 如果会话还未配置完成，稍等一下
            if (!sessionConfigured && message.type !== 'session.update') {
                console.log('⏳ 等待会话配置完成');
                setTimeout(() => {
                    if (qwenWs && qwenWs.readyState === WebSocket.OPEN) {
                        qwenWs.send(data);
                    }
                }, 1000);
                return;
            }
            
            // 直接转发消息
            qwenWs.send(data);
            
        } catch (error) {
            console.error('客户端消息解析错误:', error);
        }
    });
    
    // 客户端断开
    clientWs.on('close', (code, reason) => {
        console.log('👋 客户端断开:', code, reason);
        
        if (qwenWs && qwenWs.readyState === WebSocket.OPEN) {
            qwenWs.close();
        }
        
        // 清理
        messageBuffer = [];
    });
    
    // 客户端错误
    clientWs.on('error', (error) => {
        console.error('❌ 客户端错误:', error.message);
        
        if (qwenWs && qwenWs.readyState === WebSocket.OPEN) {
            qwenWs.close();
        }
    });
    
    // 初始连接到 Qwen
    connectToQwen();
    
    // 心跳检测
    const heartbeat = setInterval(() => {
        const now = Date.now();
        
        // 检查活动状态
        if (now - lastActivity > 300000) { // 5分钟无活动
            console.log('💔 连接超时，关闭连接');
            clearInterval(heartbeat);
            
            if (qwenWs && qwenWs.readyState === WebSocket.OPEN) {
                qwenWs.close();
            }
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.close();
            }
            return;
        }
        
        // 检查 Qwen 连接状态，如果断开则重连
        if (clientWs.readyState === WebSocket.OPEN && 
            (!qwenWs || qwenWs.readyState === WebSocket.CLOSED)) {
            console.log('🔄 检测到 Qwen 连接断开，尝试重连');
            connectToQwen();
        }
        
    }, 30000); // 每30秒检查一次
});

// 定期清理断开的连接
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        } else {
            ws.terminate();
        }
    });
}, 30000);

// 获取端口
const PORT = process.env.PORT || 3000;

// 启动服务器
server.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Qwen Omni Realtime 代理服务器启动成功!');
    console.log(`📍 服务器地址: http://0.0.0.0:${PORT}`);
    console.log(`🔗 WebSocket 端点: ws://0.0.0.0:${PORT}/api/qwen-realtime`);
    console.log(`🏥 健康检查: http://0.0.0.0:${PORT}/health`);
    console.log('⏰ 启动时间:', new Date().toISOString());
});

// 错误处理
process.on('uncaughtException', (error) => {
    console.error('💥 未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 未处理的 Promise 拒绝:', reason);
});

// 优雅关闭
process.on('SIGTERM', () => {
    console.log('📴 收到 SIGTERM 信号，正在关闭服务器...');
    
    wss.clients.forEach((ws) => {
        ws.close(1001, '服务器关闭');
    });
    
    server.close(() => {
        console.log('✅ 服务器已关闭');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('📴 收到 SIGINT 信号，正在关闭服务器...');
    
    wss.clients.forEach((ws) => {
        ws.close(1001, '服务器关闭');
    });
    
    server.close(() => {
        console.log('✅ 服务器已关闭');
        process.exit(0);
    });
});
