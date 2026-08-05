import { describe, expect, it } from "vitest";
import { numberedTextFallback, renderWhatsApp, renderWeChatText } from "../src/index.ts";

const actions = [
  { id: "a1", label: "价格不变" },
  { id: "a2", label: "修改报价" },
  { id: "a3", label: "无法承运" },
  { id: "a4", label: "稍后回复" },
];

describe("channel renderers", () => {
  it("always provides a numbered text fallback", () => {
    const rendered = numberedTextFallback({ text: "询价已更新", actions });
    expect(rendered).toContain("1. 价格不变");
    expect(rendered).toContain("2. 修改报价");
  });

  it("uses numbered text on WhatsApp instead of business buttons", () => {
    const rendered = renderWhatsApp({ text: "确认报价", actions: actions.slice(0, 2) });
    expect(rendered.type).toBe("text");
    expect(rendered.type === "text" && rendered.text.body).toContain("2. 修改报价");
  });

  it("uses portable numbered text for WeChat", () => {
    expect(renderWeChatText({ text: "询价已更新", actions }).text.content).toContain("4. 稍后回复");
  });

  it("prefixes task identity on single-thread channels", () => {
    const rendered = renderWhatsApp({
      threadReference: "RFQ-9222",
      text: "询价已更新",
      actions: actions.slice(0, 2),
    });
    expect(rendered.type === "text" && rendered.text.body).toContain("【RFQ-9222】");
  });
});
