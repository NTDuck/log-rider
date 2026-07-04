import { Telegraf } from 'telegraf';
import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN is missing!");
    process.exit(1);
}

const redisClient = createClient({ url: REDIS_URL });
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

redisClient.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
    try {
        await redisClient.connect();
        console.log('Connected to Redis');
        
        // Setup bot commands
        bot.command('start', (ctx) => {
            ctx.reply('Welcome to Log-Rider Bot! Use /link <token> to connect your account.');
        });
        
        bot.command('help', (ctx) => {
            ctx.reply('Commands:\n/start - Welcome message\n/link <token> - Connect your account\n/unsubscribe - Stop receiving notifications');
        });
        
        bot.command('unsubscribe', async (ctx) => {
            const chatId = ctx.chat.id;
            
            // Get user info to remove from app lists
            const userInfoStr = await redisClient.get(`user:${chatId}`);
            if (userInfoStr) {
                const userInfo = JSON.parse(userInfoStr);
                if (userInfo.role === 'admin') {
                    await redisClient.sRem('users:admins', chatId.toString());
                } else {
                    for (const app of userInfo.app_ids) {
                        await redisClient.sRem(`app:${app}:subscribers`, chatId.toString());
                    }
                }
                await redisClient.del(`user:${chatId}`);
            }
            
            ctx.reply('You have been unsubscribed from all notifications.');
        });
        
        bot.command('link', async (ctx) => {
            const token = ctx.message.text.split(' ')[1];
            if (!token) {
                return ctx.reply('Please provide a token. Example: /link a1b2c3d4...');
            }
            
            const linkDataStr = await redisClient.get(`link_token:${token}`);
            if (!linkDataStr) {
                return ctx.reply('Invalid or expired token.');
            }
            
            const linkData = JSON.parse(linkDataStr);
            const chatId = ctx.chat.id;
            
            // Link user
            await redisClient.set(`user:${chatId}`, JSON.stringify(linkData));
            
            if (linkData.role === 'admin') {
                await redisClient.sAdd('users:admins', chatId.toString());
            } else {
                for (const app of linkData.app_ids) {
                    await redisClient.sAdd(`app:${app}:subscribers`, chatId.toString());
                }
            }
            
            // Delete token
            await redisClient.del(`link_token:${token}`);
            
            ctx.reply(`Successfully linked as ${linkData.role} for apps: ${linkData.app_ids.join(', ') || 'ALL'}. You will now receive notifications.`);
        });
        
        bot.launch();
        console.log('Telegram Bot started.');

        // Debounce / send loop
        const lastChatSend = {};
        
        setInterval(async () => {
            try {
                // Fetch up to 20 messages
                const len = await redisClient.lLen('telegram_outbound');
                if (len === 0) return;
                
                const countToFetch = Math.min(len, 20);
                
                const tasksRaw = [];
                for (let i = 0; i < countToFetch; i++) {
                    const taskStr = await redisClient.rPop('telegram_outbound');
                    if (taskStr) {
                        tasksRaw.push(JSON.parse(taskStr));
                    }
                }
                
                const now = Date.now();
                let sentThisTick = 0;
                
                for (const task of tasksRaw) {
                    if (sentThisTick >= 20) {
                        // Push back
                        await redisClient.rPush('telegram_outbound', JSON.stringify(task));
                        continue;
                    }
                    
                    const lastSend = lastChatSend[task.chatId] || 0;
                    if (now - lastSend < 1000) { // Limit 1 msg/sec/chat
                        // Push back to try later (using lPush so it gets processed again next tick)
                        await redisClient.lPush('telegram_outbound', JSON.stringify(task));
                        continue;
                    }
                    
                    // Send
                    lastChatSend[task.chatId] = now;
                    sentThisTick++;
                    
                    const msg = `🚨 <b>${task.action === 'new' ? 'NEW' : 'ESCALATED'} ERROR</b>\nApp: ${task.appId}\nCount: ${task.count}\n\n<code>${task.log.Message || task.log.message}</code>`;
                    
                    try {
                        await bot.telegram.sendMessage(task.chatId, msg, { parse_mode: 'HTML' });
                    } catch (e) {
                        console.error(`Error sending to ${task.chatId}:`, e.message);
                    }
                }
            } catch (err) {
                console.error("Error in debounce loop:", err);
            }
        }, 1000);
        
        // Enable graceful stop
        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));

    } catch (e) {
        console.error('Initialization error:', e);
    }
})();
