import { expect, test } from "@playwright/test";

/**
 * Browser slice of the §25 scenario: login → receive RFQ → quote by text →
 * confirm via numbered reply → see invalidation after operator change.
 */

const OP = { username: "operator1", password: "mercury" };
const FLEET = { username: "fleet1", password: "mercury" };

async function opApi(request: any, method: "post" | "patch" | "get", path: string, data?: unknown, state?: { cookie?: string }) {
  if (!state!.cookie) {
    const login = await request.post("/api/auth/login", { data: OP });
    state!.cookie = login.headers()["set-cookie"]!.split(";")[0];
  }
  return request[method](path, { data, headers: { cookie: state!.cookie! } });
}

test("fleet chat: quote → invalidation → price-unchanged", async ({ page, request }) => {
  const op: { cookie?: string } = {};

  // Operator: fresh order + RFQ to Fleet A.
  const ref = `M-${8000 + Math.floor(Math.random() * 999)}`;
  const orderRes = await opApi(request, "post", "/api/operator/orders", {
    publicReference: ref,
    orderType: "IMPORT_DRAYAGE",
    serviceCountry: "SG",
    destinationTerminal: "PSA Pasir Panjang Terminal",
    deliveryLocation: "Jurong Industrial Estate",
    emptyContainerReturnLocation: "Tuas Empty Depot",
    containerType: "40HQ",
    containerQuantity: 2,
    requestedStartAt: "2026-08-04T01:00:00Z",
  }, op);
  const orderBody = await orderRes.json();
  const order = orderBody.order;
  await opApi(
    request,
    "post",
    `/api/operator/orders/${order.id}/send-rfq`,
    { fleetOrganizationIds: [orderBody.candidates[0].id] },
    op,
  );

  // Fleet logs in and sees the RFQ card.
  await page.goto("/fleet/login");
  await page.getByLabel("用户名").fill(FLEET.username);
  await page.getByLabel("密码").fill(FLEET.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator(".card-rfq").last()).toContainText(ref.replace("M-", "RFQ-"), { timeout: 15_000 });

  // Quote by free text; confirm card appears with defaulted USD.
  await page.locator(".composer-box textarea").fill("220全包");
  await page.getByRole("button", { name: "发送" }).click();
  const quoteCard = page.locator(".card-quote").last();
  await expect(quoteCard).toContainText("USD 220.00", { timeout: 15_000 });
  await expect(quoteCard).toContainText("默认美元");
  await page.locator(".composer-box textarea").fill("1");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.locator(".system-message", { hasText: "报价已提交" }).last()).toBeVisible({ timeout: 15_000 });

  // Operator changes pickup → change card with strikethrough old value and 价格不变.
  await opApi(request, "patch", `/api/operator/orders/${order.id}/fleet-visible-fields`, { pickupAt: "2026-08-04T06:00:00Z" }, op);
  const changeCard = page.locator(".card-change").last();
  await expect(changeCard).toContainText("已失效", { timeout: 15_000 });
  await page.locator(".composer-box textarea").fill("1");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.locator(".system-message", { hasText: "已确认新报价 USD 220.00" }).last()).toBeVisible({ timeout: 15_000 });

});

test("fleet and operator sessions coexist in one browser", async ({ page }) => {
  await page.goto("/operator/login");
  await page.getByLabel("用户名").fill(OP.username);
  await page.getByLabel("密码").fill(OP.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("运输订单")).toBeVisible();

  await page.goto("/fleet/login");
  await page.getByLabel("用户名").fill(FLEET.username);
  await page.getByLabel("密码").fill(FLEET.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("任务对话")).toBeVisible();

  // The operator cookie was not overwritten by the fleet login.
  await page.goto("/operator");
  await expect(page.getByText("运输订单")).toBeVisible();
});
