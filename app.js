const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

// 延遲啟動函數，增加重試機制
async function startBot() 
{
    // 最多重試 10 次，每次間隔 2 秒
    for (let iTryCount = 0; iTryCount < 10; iTryCount++) 
    {
        console.log(`嘗試載入環境變數 (第 ${iTryCount + 1} 次)`);
        
        if (process.env.CHANNEL_ACCESS_TOKEN && process.env.CHANNEL_SECRET) 
        {
            console.log('環境變數載入成功');
            return {
                channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
                channelSecret: process.env.CHANNEL_SECRET
            };
        }
        
        console.log('環境變數未載入，等待 2 秒後重試...');
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // 如果重試 10 次都失敗，拋出錯誤
    throw new Error('無法載入必要的環境變數 CHANNEL_ACCESS_TOKEN 和 CHANNEL_SECRET');
}

// 主程式啟動
async function main() 
{
    try 
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
                    
                    // 計算漲跌值和漲跌幅
                    const fCurrentPrice = parseFloat(stockData.z) || 0;
                    const fPreviousClose = parseFloat(stockData.y) || fCurrentPrice;
                    const fPriceChange = fCurrentPrice - fPreviousClose;
                    const fPercentageChange = fPreviousClose !== 0 ? (fPriceChange / fPreviousClose * 100) : 0;
                    
                    // 格式化時間
                    let strFormattedTime = stockData.tlong || 'N/A';
                    if (stockData.tlong && !isNaN(stockData.tlong)) 
                    {
                        const timestamp = parseInt(stockData.tlong);
                        if (timestamp > 1000000000000) 
                        {
                            // Unix timestamp in milliseconds
                            const date = new Date(timestamp);
                            strFormattedTime = date.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
                        }
                        else if (timestamp > 1000000000) 
                        {
                            // Unix timestamp in seconds
                            const date = new Date(timestamp * 1000);
                            strFormattedTime = date.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
                        }
                    }
                    
                    // 格式化回應訊息
                    const strMessage = `📈 ${strStockName} (${strStockCode})
💰 現價: ${fCurrentPrice.toFixed(2)}
📊 漲跌: ${fPriceChange >= 0 ? '+' : ''}${fPriceChange.toFixed(2)}
📈 漲跌幅: ${fPercentageChange >= 0 ? '+' : ''}${fPercentageChange.toFixed(2)}%
🔼 開盤: ${parseFloat(stockData.o || 0).toFixed(2)}
🔽 最高: ${parseFloat(stockData.h || 0).toFixed(2)}
📉 最低: ${parseFloat(stockData.l || 0).toFixed(2)}
📦 成交量: ${stockData.v || 'N/A'}
⏰ 更新時間: ${strFormattedTime}`;
                    
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
        const iPort = process.env.PORT || 3000;
        app.listen(iPort, () => 
        {
            console.log(`LINE BOT 股票查詢機器人已啟動，監聽端口: ${iPort}`);
        });
    }
    catch (error) 
    {
        console.error('啟動失敗:', error.message);
        process.exit(1);
    }
}

// 啟動主程式
main().catch(console.error);