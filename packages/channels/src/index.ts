/**
 * Channel boundary. Business services create one canonical message; adapters
 * decide how that message is represented on Web, WhatsApp or WeChat.
 * MVP v1.1 uses the same numbered text interaction on every fleet channel.
 */
export interface ChannelAdapter {
  channel: "WEB" | "WHATSAPP" | "WECHAT";
  normalizeInbound(raw: unknown): {
    externalMessageId: string;
    text: string;
    actionId?: string | null;
    inReplyToExternalMessageId?: string | null;
  };
}

export interface CanonicalAction {
  id: string;
  label: string;
}

export interface CanonicalOutboundMessage {
  text: string;
  /** Helps single-thread channels distinguish concurrent order conversations. */
  threadReference?: string | null;
  actions?: CanonicalAction[];
}

export const webChannel: ChannelAdapter = {
  channel: "WEB",
  normalizeInbound(raw) {
    const r = raw as { clientMessageId: string; text: string; replyToMessageId?: string | null; actionId?: string | null };
    return {
      externalMessageId: r.clientMessageId,
      text: r.text,
      actionId: r.actionId ?? null,
      inReplyToExternalMessageId: r.replyToMessageId ?? null,
    };
  },
};

export function channelText(message: CanonicalOutboundMessage): string {
  return message.threadReference ? `【${message.threadReference}】\n${message.text}` : message.text;
}

export function numberedTextFallback(message: CanonicalOutboundMessage): string {
  const actions = message.actions ?? [];
  const body = channelText(message);
  if (!actions.length) return body;
  return [
    body,
    "",
    "请回复序号或直接回复选项文字：",
    ...actions.map((action, index) => `${index + 1}. ${action.label}`),
  ].join("\n");
}

export type WhatsAppRenderable =
  | { type: "text"; text: { body: string } }
  | {
      type: "interactive";
      interactive:
        | {
            type: "button";
            body: { text: string };
            action: { buttons: Array<{ type: "reply"; reply: { id: string; title: string } }> };
          }
        | {
            type: "list";
            body: { text: string };
            action: {
              button: string;
              sections: Array<{ title: string; rows: Array<{ id: string; title: string }> }>;
            };
          };
    };

/** MVP v1.1 intentionally avoids WhatsApp business buttons and lists. */
export function renderWhatsApp(message: CanonicalOutboundMessage): WhatsAppRenderable {
  return { type: "text", text: { body: numberedTextFallback(message) } };
}

/**
 * WeChat product variants expose different interactive capabilities. The
 * portable baseline is a normal text message with numbered choices.
 */
export function renderWeChatText(message: CanonicalOutboundMessage): { msgtype: "text"; text: { content: string } } {
  return { msgtype: "text", text: { content: numberedTextFallback(message) } };
}
