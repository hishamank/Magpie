import { Client, GatewayIntentBits, type Message } from 'discord.js';
import { config } from '../config.js';
import { ingestBookmark } from '../processor/pipeline.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('collector:discord');

export async function startDiscordBot(): Promise<Client> {
  if (!config.discord.botToken) {
    throw new Error('DISCORD_BOT_TOKEN not configured');
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on('ready', () => {
    logger.info({ user: client.user?.tag }, 'Discord bot connected');
  });

  client.on('messageCreate', async (message: Message) => {
    // Only listen to the configured channel
    if (message.channelId !== config.discord.channelId) return;
    if (message.author.bot) return;

    // Extract URLs from message
    const urlRegex = /https?:\/\/[^\s<>]+/g;
    const urls = message.content.match(urlRegex);
    if (!urls || urls.length === 0) return;

    // Parse optional tags and notes: <url> #tag1 #tag2 | note
    const tagRegex = /#([\w-]+)/g;
    const tags: string[] = [];
    let match;
    while ((match = tagRegex.exec(message.content)) !== null) {
      tags.push(match[1]);
    }

    const noteMatch = message.content.match(/\|\s*(.+)/);
    const note = noteMatch?.[1]?.trim();

    for (const url of urls) {
      try {
        const id = await ingestBookmark({
          url,
          source: 'discord',
          sourceMetadata: {
            discordUser: message.author.username,
            tags,
            note,
            messageId: message.id,
          },
        });

        if (id) {
          await message.react('✅');
          logger.info({ url, id }, 'Bookmark ingested from Discord');
        } else {
          await message.react('🔄'); // duplicate
        }
      } catch (err) {
        await message.react('❌');
        logger.error({ url, err }, 'Failed to ingest from Discord');
      }
    }
  });

  await client.login(config.discord.botToken);
  return client;
}
