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
        
        bot.command('start', (ctx) => {
            ctx.reply('Welcome to Log-Rider Bot! Use /link <token> to connect your account. Type /help for all commands.');
        });
        
        bot.command('help', (ctx) => {
            ctx.reply(`Commands:
/start - Welcome message
/help - Show all commands
/link <token> - Connect your web account
/subscribe - Start receiving notifications
/unsubscribe - Stop receiving notifications
/status - Show current subscription status
/mute <minutes> - Temporarily mute notifications

Admin commands:
/listusers - Show all linked users
/revoke <telegram_id> - Unlink a user
/broadcast <message> - Send announcement to all subscribers`);
        });

        // Helper to check if user is admin
        const checkIsAdmin = async (chatId) => {
            const userInfoStr = await redisClient.get(`user:${chatId}`);
            if (!userInfoStr) return false;
            return JSON.parse(userInfoStr).role === 'admin';
        };

        const subscribeUser = async (chatId, userInfo) => {
            if (userInfo.role === 'admin') {
                await redisClient.sAdd('users:admins', chatId.toString());
            } else {
                for (const app of userInfo.app_ids) {
                    await redisClient.sAdd(`app:${app}:subscribers`, chatId.toString());
                }
            }
        };

        const unsubscribeUser = async (chatId, userInfo) => {
            if (userInfo.role === 'admin') {
                await redisClient.sRem('users:admins', chatId.toString());
            } else {
                for (const app of userInfo.app_ids) {
                    await redisClient.sRem(`app:${app}:subscribers`, chatId.toString());
                }
            }
        };
        
        bot.command('link', async (ctx) => {
            const parts = ctx.message.text.split(' ');
            if (parts.length < 2) return ctx.reply('Please provide a token. Example: /link a1b2c3d4...');
            const token = parts[1];
            
            const linkDataStr = await redisClient.get(`link_token:${token}`);
            if (!linkDataStr) return ctx.reply('Invalid or expired token.');
            
            const linkData = JSON.parse(linkDataStr);
            const chatId = ctx.chat.id;
            
            // Link user
            await redisClient.set(`user:${chatId}`, JSON.stringify(linkData));
            await subscribeUser(chatId, linkData);
            await redisClient.del(`link_token:${token}`);
            
            ctx.reply(`Successfully linked as ${linkData.role} for apps: ${linkData.app_ids.join(', ') || 'ALL'}. You will now receive notifications. Use /unsubscribe to pause.`);
        });

        bot.command('subscribe', async (ctx) => {
            const chatId = ctx.chat.id;
            const userInfoStr = await redisClient.get(`user:${chatId}`);
            if (!userInfoStr) return ctx.reply('You need to /link your account first.');
            
            await subscribeUser(chatId, JSON.parse(userInfoStr));
            ctx.reply('You are now subscribed to notifications.');
        });
        
        bot.command('unsubscribe', async (ctx) => {
            const chatId = ctx.chat.id;
            const userInfoStr = await redisClient.get(`user:${chatId}`);
            if (!userInfoStr) return ctx.reply('You are not linked.');
            
            await unsubscribeUser(chatId, JSON.parse(userInfoStr));
            ctx.reply('You have been unsubscribed. Your account remains linked, use /subscribe to resume.');
        });

        bot.command('status', async (ctx) => {
            const chatId = ctx.chat.id;
            const userInfoStr = await redisClient.get(`user:${chatId}`);
            if (!userInfoStr) return ctx.reply('Account not linked.');
            
            const userInfo = JSON.parse(userInfoStr);
            let isSubscribed = false;
            
            if (userInfo.role === 'admin') {
                isSubscribed = await redisClient.sIsMember('users:admins', chatId.toString());
            } else if (userInfo.app_ids && userInfo.app_ids.length > 0) {
                isSubscribed = await redisClient.sIsMember(`app:${userInfo.app_ids[0]}:subscribers`, chatId.toString());
            }

            const muteTtl = await redisClient.ttl(`mute:${chatId}`);
            const muteText = muteTtl > 0 ? `Yes (for next ${Math.ceil(muteTtl/60)} minutes)` : 'No';

            ctx.reply(`Status:
Role: ${userInfo.role}
Web Username: ${userInfo.user_id}
Apps: ${(userInfo.app_ids || []).join(', ') || 'ALL'}
Receiving Notifications: ${isSubscribed ? 'Yes' : 'No'}
Muted: ${muteText}`);
        });

        bot.command('mute', async (ctx) => {
            const chatId = ctx.chat.id;
            const parts = ctx.message.text.split(' ');
            if (parts.length < 2) return ctx.reply('Please specify minutes. Example: /mute 15');
            const minutes = parseInt(parts[1], 10);
            if (isNaN(minutes) || minutes <= 0) return ctx.reply('Minutes must be a positive number.');
            
            await redisClient.setEx(`mute:${chatId}`, minutes * 60, '1');
            ctx.reply(`Notifications muted for ${minutes} minutes.`);
        });

        // Admin commands
        bot.command('listusers', async (ctx) => {
            const chatId = ctx.chat.id;
            if (!(await checkIsAdmin(chatId))) return ctx.reply('Forbidden. Admins only.');
            
            const keys = await redisClient.keys('user:*');
            if (keys.length === 0) return ctx.reply('No linked users found.');
            
            let msg = 'Linked Users:\n';
            for (const key of keys) {
                const tgId = key.split(':')[1];
                const infoStr = await redisClient.get(key);
                if (infoStr) {
                    const info = JSON.parse(infoStr);
                    msg += `- ID: ${tgId} | ${info.user_id} | ${info.role}\n`;
                }
            }
            ctx.reply(msg);
        });

        bot.command('revoke', async (ctx) => {
            const chatId = ctx.chat.id;
            if (!(await checkIsAdmin(chatId))) return ctx.reply('Forbidden. Admins only.');
            
            const parts = ctx.message.text.split(' ');
            if (parts.length < 2) return ctx.reply('Usage: /revoke <telegram_id>');
            const targetId = parts[1];
            
            const infoStr = await redisClient.get(`user:${targetId}`);
            if (!infoStr) return ctx.reply('User not found.');
            
            await unsubscribeUser(targetId, JSON.parse(infoStr));
            await redisClient.del(`user:${targetId}`);
            ctx.reply(`Revoked access for Telegram ID ${targetId}.`);
        });

        bot.command('broadcast', async (ctx) => {
            const chatId = ctx.chat.id;
            if (!(await checkIsAdmin(chatId))) return ctx.reply('Forbidden. Admins only.');
            
            const text = ctx.message.text.replace('/broadcast ', '').trim();
            if (!text || text === '/broadcast') return ctx.reply('Usage: /broadcast <message>');
            
            const keys = await redisClient.keys('user:*');
            let count = 0;
            for (const key of keys) {
                const tgId = key.split(':')[1];
                try {
                    await bot.telegram.sendMessage(tgId, `📢 <b>ADMIN BROADCAST</b>\n\n${text}`, { parse_mode: 'HTML' });
                    count++;
                } catch (e) {
                    // Ignore errors for blocked bots etc
                }
            }
            ctx.reply(`Broadcast sent to ${count} users.`);
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
                        await redisClient.rPush('telegram_outbound', JSON.stringify(task));
                        continue;
                    }

                    // Check if muted
                    const isMuted = await redisClient.exists(`mute:${task.chatId}`);
                    if (isMuted) {
                        continue; // Drop the message for this chat
                    }
                    
                    const lastSend = lastChatSend[task.chatId] || 0;
                    if (now - lastSend < 1000) { 
                        await redisClient.lPush('telegram_outbound', JSON.stringify(task));
                        continue;
                    }
                    
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
        
        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));

    } catch (e) {
        console.error('Initialization error:', e);
    }
})();
