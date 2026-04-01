export interface DiscordNotifier {
  /** Fire-and-forget Discord message. Never rejects. */
  send(content: string): void;
}

/** Noop notifier used when no webhook URL is configured. */
const noopNotifier: DiscordNotifier = { send: () => {} };

/**
 * Creates a Discord notifier that prepends [profileId | MODE] to every
 * message so you can tell which bot instance sent the alert.
 * If webhookUrl is falsy, returns a silent noop — never crashes the bot.
 */
export function createDiscordNotifier(
  webhookUrl: string | undefined,
  profileId: string,
  mode: string
): DiscordNotifier {
  if (!webhookUrl) return noopNotifier;

  const tag = `[**${profileId}** | ${mode}]`;

  return {
    send(content: string): void {
      const body = JSON.stringify({ content: `${tag} ${content}` });
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      }).catch(() => {
        // silently ignore — Discord being down/rate-limited must never crash the bot
      });
    }
  };
}
