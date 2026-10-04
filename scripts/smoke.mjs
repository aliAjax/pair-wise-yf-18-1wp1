// 冒烟测试：桩掉浏览器 API 后加载服务端模块，验证核心业务流
import { createServer } from "vite";
import assert from "node:assert/strict";

const memory = new Map();
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => void memory.set(k, v),
  removeItem: (k) => void memory.delete(k),
};
globalThis.window = { setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout };

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { server, SLOTS, WORKSTATIONS } = await vite.ssrLoadModule("/src/server.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => server.getState();

// 1. 初始：8 笔种子，6 笔占住、2 笔排队
assert.equal(state().stones.length, 8, "种子 8 笔");
const leased0 = state().stones.filter((s) => s.status === "leased").length;
const queued0 = state().stones.filter((s) => s.status === "queued").length;
assert.equal(leased0, 6, "初始 6 笔有效租约");
assert.equal(queued0, 2, "初始 2 笔排队（工位满员）");
console.log("✓ 种子分拣：6 笔占住、2 笔排队");

// 2. 并发演示：双师傅同一镶位，先到先得
const before = state().stones.length;
await server.runConcurrentDemo();
await sleep(700);
assert.equal(state().stones.length, before + 2, "演示新增 2 笔");
const demoStones = state().stones.filter((s) => s.code.endsWith("-A") || s.code.endsWith("-B"));
assert.equal(demoStones.length, 2, "演示双石");
const winner = demoStones.find((s) => s.status === "leased");
const loser = demoStones.find((s) => s.status === "waitlist");
assert.ok(winner && loser, "一石占住、一石候补");
assert.ok(winner.lease && loser.waitlistSlotId === winner.lease.slotId, "候补指向同一镶位");
assert.equal(state().conflicts[0].winnerStoneId, winner.id, "冲突记录胜者");
assert.equal(state().conflicts[0].loserStoneId, loser.id, "冲突记录败者（晚到一步）");
console.log("✓ 并发先到先得：", winner.code, "占住，", loser.code, "进候补并看到冲突");

// 3. 确认交接后报账：正常入账
const confirmed = state().stones.find((s) => s.status === "leased" && !s.code.includes("DEMO"));
await server.confirmPlacement(confirmed.id);
await sleep(200);
assert.equal(confirmed.status, "confirmed", "确认后状态");
await server.postOne(confirmed.id);
await sleep(1200);
assert.equal(confirmed.status, "posted", "报账后已入账");
assert.ok(state().postings[0].status === "posted", "台账分录已入账");
console.log("✓ 确认交接 → 报保险台账 → 已入账");

// 4. 回执不符：两版都留
server.setToggles({ badReceipt: true });
const c2 = state().stones.find((s) => s.status === "leased");
await server.confirmPlacement(c2.id);
await sleep(100);
await server.postOne(c2.id);
await sleep(1200);
assert.equal(c2.status, "mismatch", "回执差异状态");
const p2 = state().postings.find((p) => p.stoneId === c2.id && p.status === "mismatch");
assert.ok(p2 && p2.externalWeight !== undefined && p2.externalAmount !== undefined, "两版金额都保留");
assert.notEqual(p2.weight, p2.externalWeight, "本地与台账石重不一致");
console.log("✓ 回执不符：本地", p2.weight, "ct / 台账", p2.externalWeight, "ct，两版都留");

// 5. 写入失败：留住已确认，只重试未入账
server.setToggles({ badReceipt: false, failWrite: true });
const c3 = state().stones.find((s) => s.status === "leased");
await server.confirmPlacement(c3.id);
await sleep(100);
await server.postOne(c3.id);
await sleep(1200);
assert.equal(c3.status, "failed", "写入失败状态");
const failedPostings = state().postings.filter((p) => p.status === "failed");
assert.ok(failedPostings.length >= 1, "存在失败分录");
await server.retryFailed(c3.id);
await sleep(1200);
assert.equal(c3.status, "posted", "重试后入账");
const retried = state().postings.filter((p) => p.stoneId === c3.id);
assert.ok(retried.some((p) => p.status === "posted"), "重试分录入账");
assert.ok(retried.some((p) => p.status === "void"), "失败分录作废留痕");
console.log("✓ 写入失败：留住确认结果，只重试未入账 → 已入账");

// 6. 订单号/石重变更：租约失效重算 + 已报账冲正重报
server.setToggles({ failWrite: false });
const posted = state().stones.find((s) => s.status === "posted");
const oldPostingId = posted.postingId;
await server.updateStone(posted.id, { orderNo: "DD-2026-CHANGED", weight: posted.weight + 0.5 });
await sleep(1200);
assert.equal(posted.orderNo, "DD-2026-CHANGED", "订单号已变更");
const oldP = state().postings.find((p) => p.id === oldPostingId);
assert.equal(oldP.status, "reversed", "原分录已冲正");
const reversal = state().postings.find((p) => p.reverses === oldPostingId);
assert.ok(reversal && reversal.insuredAmount < 0, "红冲分录为负");
const newP = state().postings.find((p) => p.stoneId === posted.id && p.status === "posted" && !p.reverses);
assert.ok(newP, "新分录入账");
console.log("✓ 订单号/石重变更：租约失效重算，原分录冲正（红冲）并重报新分录");

// 7. 持久化续作：localStorage 有快照
assert.ok(memory.has("jewelry-sorting-desk-v1"), "状态已持久化");
console.log("✓ 状态自动保存，刷新即可续作");

// 8. 续作：新实例恢复，过期租约释放
const saved = JSON.parse(memory.get("jewelry-sorting-desk-v1"));
// 把一笔租约改成已过期
const leased = saved.stones.find((s) => s.status === "leased");
leased.lease.expiresAt = Date.now() - 1000;
memory.set("jewelry-sorting-desk-v1", JSON.stringify(saved));
const vite2 = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { server: server2 } = await vite2.ssrLoadModule("/src/server.ts");
await sleep(100);
const resumed = server2.getState();
assert.ok(resumed.resumedAt, "标记续作时间");
const expiredStillLeased = resumed.stones.find((s) => s.id === leased.id && s.status === "leased");
assert.ok(!expiredStillLeased, "过期租约已失效");
assert.ok(resumed.feed.some((f) => f.kind === "resume"), "续作活动流");
console.log("✓ 续作恢复：过期租约立即失效并释放");

await vite.close();
await vite2.close();
console.log("\n全部冒烟测试通过 ✅");
