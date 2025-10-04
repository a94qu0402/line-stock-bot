const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

// 延遲啟動函數，增加重試機制
async function startBot() 
{
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
    
    throw new Error('無法載入必要的環境變數 CHANNEL_ACCESS_TOKEN 和 CHANNEL_SECRET');
}

async function main() 
{
    try 
    {
        const config = await startBot();
        const app = express();
        const client = new line.Client(config);

        const ALERT_POLL_INTERVAL_MS = 60000; 
        const VOLUME_HISTORY_LIMIT = 20;
        const VOLUME_MIN_SAMPLES = 3;

        const userPriceAlerts = new Map(); // 價格警報
        const userVolumeAlerts = new Map(); // 量能警報
        const userChangeAlerts = new Map(); // 漲跌幅警報
        const volumeHistory = new Map();

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
            const strUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_${strStockCode}.tw`;
            const response = await axios.get(strUrl);

            if (response.data && response.data.msgArray && response.data.msgArray.length > 0)
            {
                return response.data.msgArray[0];
            }
            return null;
        }

        async function getStockInfo(strStockCode) 
        {
            try 
            {
                const stockData = await fetchStockData(strStockCode);

                if (stockData)
                {
                    const strStockName = stockNames[strStockCode] || strStockCode;
                    const fCurrentPrice = parseFloat(stockData.z) || 0;
                    const fPreviousClose = parseFloat(stockData.y) || fCurrentPrice;
                    const fPriceChange = fCurrentPrice - fPreviousClose;
                    const fPercentageChange = fPreviousClose !== 0 ? (fPriceChange / fPreviousClose * 100) : 0;

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

        function describeChangeAlert(alert)
        {
            return `${alert.stockCode} 漲跌幅超過 ${alert.changePercent.toFixed(2)}%`;
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
            for (const alerts of userChangeAlerts.values())
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

                if (!stockData) continue;

                const currentPrice = parseFloat(stockData.z) || 0;
                const previousClose = parseFloat(stockData.y) || currentPrice;
                const priceChange = currentPrice - previousClose;
                const percentageChange = previousClose !== 0 ? (priceChange / previousClose * 100) : 0;
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
                    if (remaining.length > 0) userPriceAlerts.set(userId, remaining);
                    else userPriceAlerts.delete(userId);
                }

                // Change alerts
                for (const [userId, alerts] of userChangeAlerts.entries())
                {
                    const remaining = [];
                    for (const alert of alerts)
                    {
                        if (alert.stockCode !== stockCode)
                        {
                            remaining.push(alert);
                            continue;
                        }

                        let trigger = Math.abs(percentageChange) >= alert.changePercent;
                        if (trigger)
                        {
                            const message = `🚨 漲跌幅警報
${stockName} (${stockCode}) 當日漲跌幅已達 ${percentageChange.toFixed(2)}%`;

                            client.pushMessage(userId, { type: 'text', text: message })
                                .catch(err => console.error('推送漲跌幅警報失敗:', err));
                        }
                        else
                        {
                            remaining.push(alert);
                        }
                    }
                    if (remaining.length > 0) userChangeAlerts.set(userId, remaining);
                    else userChangeAlerts.delete(userId);
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
                    if (remaining.length > 0) userVolumeAlerts.set(userId, remaining);
                    else userVolumeAlerts.delete(userId);
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
            const userId = event.source.userId;

            // 股票查詢
            const stockPattern = /^P(\d{4})$/;
            const match = strUserMessage.match(stockPattern);
            if (match) 
            {
                const strStockCode = match[1];
                const strStockInfo = await getStockInfo(strStockCode);
                return client.replyMessage(event.replyToken, { type: 'text', text: strStockInfo });
            }

            // 價格警報 (原始 ABOVE/BELOW)
            const priceAlertPattern = /^ALERT\s+(\d{4})\s+(ABOVE|BELOW)\s+(\d+(?:\.\d+)?)$/;
            // 簡單警報
            const simplePriceAlertPattern = /^ALERT\s+(\d{4})\s+(\d+(?:\.\d+)?)$/;
            // 漲跌幅警報
            const changeAlertPattern = /^ALERT\s+(\d{4})\s+CHANGE\s+(\d+(?:\.\d+)?)$/;

            const priceListPattern = /^ALERT\s+LIST$/;
            const priceClearPattern = /^ALERT\s+CLEAR$/;
            const volumeAlertPattern = /^VOL\s+(\d{4})\s+(\d+(?:\.\d+)?)$/;
            const volumeListPattern = /^VOL\s+LIST$/;
            const volumeClearPattern = /^VOL\s+CLEAR$/;

            if (priceAlertPattern.test(strUserMessage))
            {
                const [, stockCode, direction, priceText] = strUserMessage.match(priceAlertPattern);
                const targetPrice = parseFloat(priceText);

                const userAlerts = getUserAlertBucket(userPriceAlerts, userId);
                const existingIndex = userAlerts.findIndex(alert => alert.stockCode === stockCode && alert.direction === direction);

                if (existingIndex >= 0) userAlerts[existingIndex].targetPrice = targetPrice;
                else userAlerts.push({ stockCode, direction, targetPrice });

                const stockName = stockNames[stockCode] || stockCode;
                const ack = `✅ 已設定 ${stockName} (${stockCode}) ${direction === 'ABOVE' ? '向上突破' : '向下跌破'} ${targetPrice.toFixed(2)} 的價格警報`;

                return client.replyMessage(event.replyToken, { type: 'text', text: ack });
            }

            // 簡單警報
            if (simplePriceAlertPattern.test(strUserMessage))
            {
                const [, stockCode, priceText] = strUserMessage.match(simplePriceAlertPattern);
                const targetPrice = parseFloat(priceText);
                const stockData = await fetchStockData(stockCode);

                if (!stockData) return client.replyMessage(event.replyToken, { type: 'text', text: `❌ 查無股票代號 ${stockCode} 的資訊` });

                const currentPrice = parseFloat(stockData.z) || 0;
                const direction = currentPrice <= targetPrice ? 'ABOVE' : 'BELOW';

                const userAlerts = getUserAlertBucket(userPriceAlerts, userId);
                const existingIndex = userAlerts.findIndex(alert => alert.stockCode === stockCode && alert.direction === direction);

                if (existingIndex >= 0) userAlerts[existingIndex].targetPrice = targetPrice;
                else userAlerts.push({ stockCode, direction, targetPrice });

                const stockName = stockNames[stockCode] || stockCode;
                const ack = `✅ 已設定 ${stockName} (${stockCode}) ${direction === 'ABOVE' ? '向上突破' : '向下跌破'} ${targetPrice.toFixed(2)} 的價格警報
（目前股價：${currentPrice.toFixed(2)}）`;

                return client.replyMessage(event.replyToken, { type: 'text', text: ack });
            }

            // 漲跌幅警報
            if (changeAlertPattern.test(strUserMessage))
            {
                const [, stockCode, percentText] = strUserMessage.match(changeAlertPattern);
                const changePercent = parseFloat(percentText);

                const alerts = getUserAlertBucket(userChangeAlerts, userId);
                const existingIndex = alerts.findIndex(alert => alert.stockCode === stockCode);

                if (existingIndex >= 0) alerts[existingIndex].changePercent = changePercent;
                else alerts.push({ stockCode, changePercent });

                const stockName = stockNames[stockCode] || stockCode;
                const ack = `✅ 已設定 ${stockName} (${stockCode}) 漲跌幅超過 ${changePercent.toFixed(2)}% 的警報`;

                return client.replyMessage(event.replyToken, { type: 'text', text: ack });
            }

            // 列表 / 清除
            if (priceListPattern.test(strUserMessage))
            {
                const alerts = userPriceAlerts.get(userId) || [];
                const changeAlerts = userChangeAlerts.get(userId) || [];
                if (alerts.length === 0 && changeAlerts.length === 0)
                {
                    return client.replyMessage(event.replyToken, { type: 'text', text: '尚未設定任何價格/漲跌幅警報' });
                }

                const lines = [
                    ...alerts.map(alert => `• ${describePriceAlert(alert)}`),
                    ...changeAlerts.map(alert => `• ${describeChangeAlert(alert)}`)
                ];
                return client.replyMessage(event.replyToken, { type: 'text', text: `📋 警報列表\n${lines.join('\n')}` });
            }

            if (priceClearPattern.test(strUserMessage))
            {
                userPriceAlerts.delete(userId);
                userChangeAlerts.delete(userId);
                return client.replyMessage(event.replyToken, { type: 'text', text: '✅ 已清除所有價格與漲跌幅警報' });
            }

            if (volumeAlertPattern.test(strUserMessage))
            {
                const [, stockCode, multiplierText] = strUserMessage.match(volumeAlertPattern);
                const multiplier = parseFloat(multiplierText);

                if (!Number.isFinite(multiplier) || multiplier <= 1)
                {
                    return client.replyMessage(event.replyToken, { type: 'text', text: '❌ 量能倍數需大於 1，例如 VOL 2330 2' });
                }

                const alerts = getUserAlertBucket(userVolumeAlerts, userId);
                const existingIndex = alerts.findIndex(alert => alert.stockCode === stockCode);

                if (existingIndex >= 0) alerts[existingIndex].multiplier = multiplier;
                else alerts.push({ stockCode, multiplier });

                const stockName = stockNames[stockCode] || stockCode;
                const ack = `✅ 已設定 ${stockName} (${stockCode}) 量能達平均 ${multiplier.toFixed(2)} 倍的警報`;

                return client.replyMessage(event.replyToken, { type: 'text', text: ack });
            }

            if (volumeListPattern.test(strUserMessage))
            {
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
                userVolumeAlerts.delete(userId);
                return client.replyMessage(event.replyToken, { type: 'text', text: '✅ 已清除所有量能警報' });
            }

            if (strUserMessage === 'HELP' || strUserMessage === '幫助') 
            {
                const helpMessage = `📱 股票查詢機器人使用說明

🔍 查詢即時資訊
P + 股票代號
例如：P2330 (查詢台積電)

🚨 價格警報
1. ALERT 股票代號 ABOVE/BELOW 價格
   例如：ALERT 2330 ABOVE 650
2. 簡單版：ALERT 股票代號 價格
   例如：ALERT 2330 650
   → 會自動判斷是突破還是跌破

📊 漲跌幅警報
ALERT 股票代號 CHANGE 百分比
例如：ALERT 2330 CHANGE 5
→ 當日漲跌幅超過 ±5% 通知

📈 量能警報
VOL 股票代號 倍數(>1)
例如：VOL 2330 2.5
其他指令：VOL LIST、VOL CLEAR

📋 查詢或清除警報
ALERT LIST → 查看所有價格與漲跌幅警報
ALERT CLEAR → 清除所有價格與漲跌幅警報
VOL LIST → 查看量能警報
VOL CLEAR → 清除量能警報

💡 輸入 HELP 查看此說明`;

                return client.replyMessage(event.replyToken, { type: 'text', text: helpMessage });
            }

            return Promise.resolve(null);
        }

        app.post('/callback', line.middleware(config), (req, res) => 
        {
            Promise.all(req.body.events.map(handleEvent))
                .then((result) => res.json(result))
                .catch((err) => 
                {
                    console.error(err);
                    res.status(500).end();
                });
        });

        app.get('/health', (req, res) => 
        {
            res.json({ status: 'OK', timestamp: new Date().toISOString() });
        });

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

main().catch(console.error);
