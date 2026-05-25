import type { Telegraf } from "telegraf";

export async function installBotCommands(bot: Telegraf): Promise<void> {
  await bot.telegram.setMyCommands([
    { command: "watch", description: "Discover pools and track a token" },
    { command: "scan", description: "Scan for DEX pools" },
    { command: "pool", description: "Add a pool by address or id" },
    { command: "settings", description: "Open alert settings" },
    { command: "topic", description: "Set this forum topic for buy alerts" },
    { command: "set", description: "Change a setting" },
    { command: "pools", description: "Show tracked pools" },
    { command: "pause", description: "Pause notifications" },
    { command: "resume", description: "Resume notifications" },
    { command: "testbuy", description: "Send a sample buy alert" },
    { command: "chatid", description: "Show this chat's id" },
    { command: "help", description: "Show help" }
  ]);
}
