// server.js - Qwen Omni Realtime 代理服务器
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
        version: '1.0.0',
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

// API Key - 在生产环境中应该使用环境变量
const QWEN_API_KEY = process.env.QWEN_API_KEY || 'sk-1c91f0e955a94c688c7992a724ceea18';
const QWEN_API_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';

console.log('🔑 API Key configured:', QWEN_API_KEY ? 'Yes' : 'No');

wss.on('connection', (clientWs, request) => {
    console.log('🔗 客户端连接:', request.connection.remoteAddress);
    
    // 获取查询参数
    const url = new URL(request.url, `http://${request.headers.host}`);
    const model = url.searchParams.get('model') || 'qwen-omni-turbo-realtime';
    const token = url.searchParams.get('token');
    
    console.log('📝 连接参数:', { model, token: token ? '***' : 'none' });
    
    // 连接到通义千问 API
    const qwenUrl = `${QWEN_API_URL}?model=${model}`;
    console.log('🌐 连接到 Qwen API:', qwenUrl);
    console.log('🔑 使用 API Key:', QWEN_API_KEY ? `${QWEN_API_KEY.substring(0, 20)}...` : '未设置');
    
    const qwenWs = new WebSocket(qwenUrl, {
        headers: {
            'Authorization': `Bearer ${QWEN_API_KEY}`,
            'User-Agent': 'QwenProxy/1.0',
            'Origin': 'https://qwen-omni-proxy-production.up.railway.app'
        },
        timeout: 10000,
        handshakeTimeout: 10000
    });
    
    // 连接状态跟踪
    let isConnected = false;
    let lastActivity = Date.now();
    let messageQueue = []; // 消息队列
    
    // 通义千问 WebSocket 事件处理
    qwenWs.on('open', () => {
        console.log('✅ Qwen API 连接成功');
        isConnected = true;
        
        // 发送连接成功消息
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
                type: 'proxy.connected',
                message: '代理连接成功',
                timestamp: new Date().toISOString()
            }));
        }
        
        // 处理队列中的消息
        while (messageQueue.length > 0 && qwenWs.readyState === WebSocket.OPEN) {
            const queuedMessage = messageQueue.shift();
            console.log('📤 发送队列消息:', queuedMessage.substring(0, 100) + '...');
            qwenWs.send(queuedMessage);
        }
        
        // 立即发送会话初始化
        setTimeout(() => {
            if (qwenWs.readyState === WebSocket.OPEN) {
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
                qwenWs.send(JSON.stringify(sessionConfig));
                console.log('📝 已发送会话配置');
            }
        }, 100);
    });
    
    qwenWs.on('message', (data) => {
        lastActivity = Date.now();
        console.log('📨 Qwen -> Client:', data.toString().substring(0, 100) + '...');
        
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data);
        }
    });
    
    qwenWs.on('error', (error) => {
        console.error('❌ Qwen WebSocket 错误:', error.message);
        console.error('错误详情:', error);
        console.error('API Key 检查:', QWEN_API_KEY ? `有效 (${QWEN_API_KEY.substring(0, 10)}...)` : '未设置');
        
        if (clientWs.readyState === WebSocket.OPEN) {
            let errorMessage = '代理连接错误: ' + error.message;
            
            // 根据错误类型提供更具体的信息
            if (error.message.includes('401') || error.message.includes('Unauthorized')) {
                errorMessage = 'API Key 无效或已过期，请检查API密钥';
            } else if (error.message.includes('403') || error.message.includes('Forbidden')) {
                errorMessage = 'API访问被拒绝，请检查API权限';
            } else if (error.message.includes('timeout') || error.message.includes('ETIMEDOUT')) {
                errorMessage = '连接超时，请稍后重试';
            }
            
            clientWs.send(JSON.stringify({
                type: 'error',
                error: { 
                    message: errorMessage,
                    code: 'PROXY_ERROR',
                    details: error.message
                }
            }));
        }
    });
    
    qwenWs.on('close', (code, reason) => {
        console.log('🔌 Qwen 连接关闭:', code, reason.toString());
        isConnected = false;
        
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1000, 'Qwen 连接关闭');
        }
    });
    
    // 客户端 WebSocket 事件处理
    clientWs.on('message', (data) => {
        lastActivity = Date.now();
        console.log('📤 Client -> Qwen:', data.toString().substring(0, 100) + '...');
        
        if (qwenWs.readyState === WebSocket.OPEN) {
            qwenWs.send(data);
        } else if (qwenWs.readyState === WebSocket.CONNECTING) {
            // 如果正在连接，加入队列
            console.log('⏳ Qwen 正在连接中，消息加入队列');
            messageQueue.push(data.toString());
        } else {
            console.warn('⚠️ Qwen 连接未就绪, 状态:', qwenWs.readyState);
            clientWs.send(JSON.stringify({
                type: 'error',
                error: { 
                    message: 'Qwen API 连接未就绪，请稍后重试',
                    code: 'NOT_READY',
                    readyState: qwenWs.readyState
                }
            }));
        }
    });
    
    clientWs.on('close', (code, reason) => {
        console.log('👋 客户端断开:', code, reason);
        
        if (qwenWs.readyState === WebSocket.OPEN) {
            qwenWs.close();
        }
    });
    
    clientWs.on('error', (error) => {
        console.error('❌ 客户端 WebSocket 错误:', error.message);
        
        if (qwenWs.readyState === WebSocket.OPEN) {
            qwenWs.close();
        }
    });
    
    // 心跳检测
    const heartbeat = setInterval(() => {
        const now = Date.now();
        if (now - lastActivity > 60000) { // 60秒无活动
            console.log('💔 连接超时，关闭连接');
            clearInterval(heartbeat);
            
            if (qwenWs.readyState === WebSocket.OPEN) qwenWs.close();
            if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
        }
    }, 30000);
    
    // 连接关闭时清理
    const cleanup = () => {
        clearInterval(heartbeat);
        console.log('🧹 连接清理完成');
    };
    
    clientWs.on('close', cleanup);
    qwenWs.on('close', cleanup);
});

// 监听 WebSocket 服务器事件
wss.on('listening', () => {
    console.log('🎯 WebSocket 服务器启动成功');
});

wss.on('error', (error) => {
    console.error('💥 WebSocket 服务器错误:', error);
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
