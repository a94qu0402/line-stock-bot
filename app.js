const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

// 延遲啟動函數
async function startBot() 
{
    // 等待一下讓環境變數載入
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 檢查環境變數
    console.log('CHANNEL_ACCESS_TOKEN exists:', !!process.env.CHANNEL_ACCESS_TOKEN);
    console.log('CHANNEL_SECRET exists:', !!process.env.CHANNEL_SECRET);
    
    const config = 
    {
        channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
        channelSecret: process.env.CHANNEL_SECRET
    };
    
    // 檢查必要的環境變數
    if (!config.channelAccessToken) 
    {
        console.error('錯誤: CHANNEL_ACCESS_TOKEN 環境變數未設定');
        process.exit(1);
    }
    
    if (!config.channelSecret) 
    {
        console.error('錯誤: CHANNEL_SECRET 環境變數未設定');  
        process.exit(1);
    }
    
    console.log('環境變數載入成功');
    return config;
}

// 主程式啟動
async function main() 
{
    const config = await startBot();
    const app = express();
    const client = new line.Client(config);

// 台股代號對照表（部分常見股票）
const stockNames = 
{
    '2330': '台積電',
    '2317': '鴻海',
    '2454': '聯發科',
    '2412': '中華電',
    '1303': '南亞',
    '1301': '台塑',
    '2881': '富邦金',
    '2882': '國泰金',
    '2308': '台達電',
    '3008': '大立光'
};

// 股票資訊查詢函數
async function getStockInfo(strStockCode) 
{
    try 
    {
        // 使用台灣證券交易所API
        const strUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_${strStockCode}.tw`;
        const response = await axios.get(strUrl);
        
        if (response.data && response.data.msgArray && response.data.msgArray.length > 0) 
        {
            const stockData = response.data.msgArray[0];
            const strStockName = stockNames[strStockCode] || strStockCode;
            
            // 格式化回應訊息
            const strMessage = `📈 ${strStockName} (${strStockCode})
💰 現價: ${stockData.z || 'N/A'}
📊 漲跌: ${stockData.c || 'N/A'}
📈 漲跌幅: ${stockData.pz || 'N/A'}%
🔼 開盤: ${stockData.o || 'N/A'}
🔽 最高: ${stockData.h || 'N/A'}
📉 最低: ${stockData.l || 'N/A'}
📦 成交量: ${stockData.v || 'N/A'}
⏰ 更新時間: ${stockData.tlong || 'N/A'}`;
            
            return strMessage;
        }
        else 
        {
            return `❌ 查無股票代號 ${strStockCode} 的資訊`;
        }
    } 
    catch (error) 
    {
        console.error('股票資訊查詢錯誤:', error);
        return '❌ 查詢股票資訊時發生錯誤，請稍後再試';
    }
}

// 處理訊息事件
async function handleEvent(event) 
{
    if (event.type !== 'message' || event.message.type !== 'text') 
    {
        return Promise.resolve(null);
    }

    const strUserMessage = event.message.text.trim().toUpperCase();
    
    // 檢查是否為股票查詢指令 (P + 股票代號)
    const stockPattern = /^P(\d{4})$/;
    const match = strUserMessage.match(stockPattern);
    
    if (match) 
    {
        const strStockCode = match[1];
        const strStockInfo = await getStockInfo(strStockCode);
        
        const echo = 
        {
            type: 'text',
            text: strStockInfo
        };
        
        return client.replyMessage(event.replyToken, echo);
    }
    
    // 如果不是股票查詢指令，回覆使用說明
    if (strUserMessage === 'HELP' || strUserMessage === '幫助') 
    {
        const helpMessage = `📱 股票查詢機器人使用說明

🔍 查詢股票：P + 股票代號
例如：P2330 (查詢台積電)

📋 支援的股票代號：
• 2330 台積電
• 2317 鴻海  
• 2454 聯發科
• 2412 中華電
• 1303 南亞
• 1301 台塑
• 2881 富邦金
• 2882 國泰金
• 2308 台達電
• 3008 大立光

💡 輸入 HELP 查看此說明`;

        const echo = 
        {
            type: 'text',
            text: helpMessage
        };
        
        return client.replyMessage(event.replyToken, echo);
    }
    
    return Promise.resolve(null);
}

    // 設定 webhook
    app.post('/callback', line.middleware(config), (req, res) => 
    {
        Promise
            .all(req.body.events.map(handleEvent))
            .then((result) => res.json(result))
            .catch((err) => 
            {
                console.error(err);
                res.status(500).end();
            });
    });

    // 健康檢查端點
    app.get('/health', (req, res) => 
    {
        res.json({ status: 'OK', timestamp: new Date().toISOString() });
    });

    // 啟動伺服器
    const port = process.env.PORT || 3000;
    app.listen(port, () => 
    {
        console.log(`LINE BOT 股票查詢機器人已啟動，監聽端口: ${port}`);
    });
}

// 啟動主程式
main().catch(console.error);