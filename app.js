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

        const ALERT_POLL_INTERVAL_MS = 60000; // 1 minute interval for background checks
        const VOLUME_HISTORY_LIMIT = 20;
        const VOLUME_MIN_SAMPLES = 3;

        // Alert stores keyed by userId
        const userPriceAlerts = new Map(); // Map<string, Array<{ stockCode, direction, targetPrice }>>
        const userVolumeAlerts = new Map(); // Map<string, Array<{ stockCode, multiplier }>>
        const volumeHistory = new Map(); // Map<string, Array<number>> for rolling averages

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

        async function fetchStockData(strStockCode)
        {
            // 使用台灣證券交易所API
            const strUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_${strStockCode}.tw`;
            const response = await axios.get(strUrl);

            if (response.data && response.data.msgArray && response.data.msgArray.length > 0)
            {
                return response.data.msgArray[0];
            }

            return null;
        }

        // 股票資訊查詢函數
        async function getStockInfo(strStockCode) 
        {
            try 
            {
                const stockData = await fetchStockData(strStockCode);

                if (stockData)
                {
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
                            const date = new Date(timestamp);
                            strFormattedTime = date.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
                        }
                        else if (timestamp > 1000000000) 
                        {
                            const date = new Date(timestamp * 1000);
                            strFormattedTime = date.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
                        }
                    }
                    
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

        function getUserAlertBucket(map, userId)
        {
            if (!map.has(userId))
            {
                map.set(userId, []);
            }

            return map.get(userId);
        }

        function describePriceAlert(alert)
        {
            return `${alert.stockCode} ${alert.direction === 'ABOVE' ? '突破' : '跌破'} ${alert.targetPrice.toFixed(2)}`;
        }

        function describeVolumeAlert(alert)
        {
            return `${alert.stockCode} 交易量達平均的 ${alert.multiplier.toFixed(2)} 倍`;
        }

        async function checkAlerts()
        {
            const stockCodes = new Set();

            for (const alerts of userPriceAlerts.values())
            {
                alerts.forEach(alert => stockCodes.add(alert.stockCode));
            }

            for (const alerts of userVolumeAlerts.values())
            {
                alerts.forEach(alert => stockCodes.add(alert.stockCode));
            }

            for (const stockCode of stockCodes)
            {
                let stockData;

                try
                {
                    stockData = await fetchStockData(stockCode);
                }
                catch (err)
                {
                    console.error(`取得股票 ${stockCode} 資料失敗:`, err.message);
                    continue;
                }

                if (!stockData)
                {
                    continue;
                }

                const currentPrice = parseFloat(stockData.z) || 0;
                const currentVolume = parseFloat(stockData.v) || 0;
                const stockName = stockNames[stockCode] || stockCode;

                // Price alerts
                for (const [userId, alerts] of userPriceAlerts.entries())
                {
                    const remaining = [];

                    for (const alert of alerts)
                    {
                        if (alert.stockCode !== stockCode)
                        {
                            remaining.push(alert);
                            continue;
                        }

                        const trigger = (alert.direction === 'ABOVE' && currentPrice >= alert.targetPrice) ||
                            (alert.direction === 'BELOW' && currentPrice <= alert.targetPrice);

                        if (trigger)
                        {
                            const directionText = alert.direction === 'ABOVE' ? '突破' : '跌破';
                            const message = `🚨 價格警報
${stockName} (${stockCode}) 已${directionText} ${alert.targetPrice.toFixed(2)}
最新成交價：${currentPrice.toFixed(2)}`;

                            client.pushMessage(userId, { type: 'text', text: message })
                                .catch(err => console.error('推送價格警報失敗:', err));
                        }
                        else
                        {
                            remaining.push(alert);
                        }
                    }

                    if (remaining.length > 0)
                    {
                        userPriceAlerts.set(userId, remaining);
                    }
                    else
                    {
                        userPriceAlerts.delete(userId);
                    }
                }

                // Volume alerts
                let history = volumeHistory.get(stockCode) || [];
                const averageVolume = history.length > 0 ? history.reduce((sum, value) => sum + value, 0) / history.length : 0;

                for (const [userId, alerts] of userVolumeAlerts.entries())
                {
                    const remaining = [];

                    for (const alert of alerts)
                    {
                        if (alert.stockCode !== stockCode)
                        {
                            remaining.push(alert);
                            continue;
                        }

                        let trigger = false;

                        if (history.length >= VOLUME_MIN_SAMPLES && averageVolume > 0)
                        {
                            trigger = currentVolume >= averageVolume * alert.multiplier;
                        }

                        if (trigger)
                        {
                            const message = `🚨 量能警報
${stockName} (${stockCode}) 目前成交量 ${currentVolume.toFixed(0)}
已達過去均量的 ${alert.multiplier.toFixed(2)} 倍以上`;

                            client.pushMessage(userId, { type: 'text', text: message })
                                .catch(err => console.error('推送量能警報失敗:', err));
                        }
                        else
                        {
                            remaining.push(alert);
                        }
                    }

                    if (remaining.length > 0)
                    {
                        userVolumeAlerts.set(userId, remaining);
                    }
                    else
                    {
                        userVolumeAlerts.delete(userId);
                    }
                }

                history = [...history, currentVolume];
                if (history.length > VOLUME_HISTORY_LIMIT)
                {
                    history = history.slice(history.length - VOLUME_HISTORY_LIMIT);
                }
                volumeHistory.set(stockCode, history);
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

            const priceAlertPattern = /^ALERT\s+(\d{4})\s+(ABOVE|BELOW)\s+(\d+(?:\.\d+)?)$/;
            const priceListPattern = /^ALERT\s+LIST$/;
            const priceClearPattern = /^ALERT\s+CLEAR$/;
            const volumeAlertPattern = /^VOL\s+(\d{4})\s+(\d+(?:\.\d+)?)$/;
            const volumeListPattern = /^VOL\s+LIST$/;
            const volumeClearPattern = /^VOL\s+CLEAR$/;

            const userId = event.source.userId;

            if (priceAlertPattern.test(strUserMessage))
            {
                const [, stockCode, direction, priceText] = strUserMessage.match(priceAlertPattern);
                const targetPrice = parseFloat(priceText);

                if (!userId)
                {
                    return client.replyMessage(event.replyToken, { type: 'text', text: '❌ 僅支援對好友的價格警報' });
                }

                const userAlerts = getUserAlertBucket(userPriceAlerts, userId);
                const existingIndex = userAlerts.findIndex(alert => alert.stockCode === stockCode && alert.direction === direction);

                if (existingIndex >= 0)
                {
                    userAlerts[existingIndex].targetPrice = targetPrice;
                }
                else
                {
                    userAlerts.push({ stockCode, direction, targetPrice });
                }

                const stockName = stockNames[stockCode] || stockCode;
                const ack = `✅ 已設定 ${stockName} (${stockCode}) ${direction === 'ABOVE' ? '向上突破' : '向下跌破'} ${targetPrice.toFixed(2)} 的價格警報`;

                return client.replyMessage(event.replyToken, { type: 'text', text: ack });
            }

            if (priceListPattern.test(strUserMessage))
            {
                if (!userId)
                {
                    return client.replyMessage(event.replyToken, { type: 'text', text: '❌ 僅支援好友查詢價格警報列表' });
                }

                const alerts = userPriceAlerts.get(userId) || [];

                if (alerts.length === 0)
                {
                    return client.replyMessage(event.replyToken, { type: 'text', text: '尚未設定任何價格警報' });
                }

                const lines = alerts.map(alert => `• ${describePriceAlert(alert)}`);
                return client.replyMessage(event.replyToken, { type: 'text', text: `📋 價格警報列表\n${lines.join('\n')}` });
            }

            if (priceClearPattern.test(strUserMessage))
            {
                if (userId)
                {
                    userPriceAlerts.delete(userId);
                }

                return client.replyMessage(event.replyToken, { type: 'text', text: '✅ 已清除所有價格警報' });
            }

            if (volumeAlertPattern.test(strUserMessage))
            {
                if (!userId)
                {
                    return client.replyMessage(event.replyToken, { type: 'text', text: '❌ 僅支援好友設定量能警報' });
                }

                const [, stockCode, multiplierText] = strUserMessage.match(volumeAlertPattern);
                const multiplier = parseFloat(multiplierText);

                if (!Number.isFinite(multiplier) || multiplier <= 1)
                {
                    return client.replyMessage(event.replyToken, { type: 'text', text: '❌ 量能倍數需大於 1，例如 VOL 2330 2' });
                }

                const alerts = getUserAlertBucket(userVolumeAlerts, userId);
                const existingIndex = alerts.findIndex(alert => alert.stockCode === stockCode);

                if (existingIndex >= 0)
                {
                    alerts[existingIndex].multiplier = multiplier;
                }
                else
                {
                    alerts.push({ stockCode, multiplier });
                }

                const stockName = stockNames[stockCode] || stockCode;
                const ack = `✅ 已設定 ${stockName} (${stockCode}) 量能達平均 ${multiplier.toFixed(2)} 倍的警報`;

                return client.replyMessage(event.replyToken, { type: 'text', text: ack });
            }

            if (volumeListPattern.test(strUserMessage))
            {
                if (!userId)
                {
                    return client.replyMessage(event.replyToken, { type: 'text', text: '❌ 僅支援好友查詢量能警報列表' });
                }

                const alerts = userVolumeAlerts.get(userId) || [];

                if (alerts.length === 0)
                {
                    return client.replyMessage(event.replyToken, { type: 'text', text: '尚未設定任何量能警報' });
                }

                const lines = alerts.map(alert => `• ${describeVolumeAlert(alert)}`);
                return client.replyMessage(event.replyToken, { type: 'text', text: `📋 量能警報列表\n${lines.join('\n')}` });
            }

            if (volumeClearPattern.test(strUserMessage))
            {
                if (userId)
                {
                    userVolumeAlerts.delete(userId);
                }

                return client.replyMessage(event.replyToken, { type: 'text', text: '✅ 已清除所有量能警報' });
            }
            
            // 如果不是股票查詢指令，回覆使用說明
            if (strUserMessage === 'HELP' || strUserMessage === '幫助') 
            {
                const helpMessage = `📱 股票查詢機器人使用說明

🔍 查詢即時資訊：輸入 P + 股票代號
　　例：P2330 查詢台積電

🚨 價格警報：輸入 ALERT 股票代號 ABOVE/BELOW 價格
　　例：ALERT 2330 ABOVE 650（股價向上突破 650 時提醒）
　　例：ALERT 2317 BELOW 100（股價向下跌破 100 時提醒）
　　ALERT LIST 可查看目前設定；ALERT CLEAR 會清除全部價格警報

📈 量能警報：輸入 VOL 股票代號 倍數 (>1)
　　例：VOL 2330 2.5（成交量達近期期均量 2.5 倍時提醒）
　　VOL LIST 可查看目前設定；VOL CLEAR 會清除全部量能警報

💡 任何時候輸入 HELP 可再次取得此說明`;

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

        setInterval(() => 
        {
            checkAlerts().catch(err => console.error('背景警報檢查失敗:', err.message));
        }, ALERT_POLL_INTERVAL_MS);

        checkAlerts().catch(err => console.error('初始警報檢查失敗:', err.message));
    }
    catch (error) 
    {
        console.error('啟動失敗:', error.message);
        process.exit(1);
    }
}

// 啟動主程式
main().catch(console.error);
