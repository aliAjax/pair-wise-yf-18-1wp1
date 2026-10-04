// 模拟服务端：权威状态 + 租约裁决 + 台账报账
// 所有异步动作都带网络时延；同一事件循环内并发提交同一镶位，先到先得。
import type {
  ConflictRecord,
  DeskState,
  FeedEntry,
  Posting,
  Slot,
  Stone,
  StoneInput,
  Workstation,
} from "./types";

const TTL_MS = 45_000; // 租约有效期 45s
const LATENCY_MS = 420;
const LEDGER_LATENCY_MS = 650;
const STORAGE_KEY = "jewelry-sorting-desk-v1";

export const WORKSTATIONS: Workstation[] = [
  { id: "ws-gaoding", name: "高定工位", capacity: 1 },
  { id: "ws-zhushi", name: "主石工位", capacity: 2 },
  { id: "ws-weishi", name: "围石工位", capacity: 3 },
];

export const SLOTS: Slot[] = [
  { id: "slot-gd-1", name: "高定镶位", workstationId: "ws-gaoding" },
  { id: "slot-zs-1", name: "主石A位", workstationId: "ws-zhushi" },
  { id: "slot-zs-2", name: "主石B位", workstationId: "ws-zhushi" },
  { id: "slot-ws-1", name: "围石甲位", workstationId: "ws-weishi" },
  { id: "slot-ws-2", name: "围石乙位", workstationId: "ws-weishi" },
  { id: "slot-ws-3", name: "围石丙位", workstationId: "ws-weishi" },
];

export function workstationForWeight(weight: number): Workstation {
  if (weight >= 3) return WORKSTATIONS[0];
  if (weight >= 1) return WORKSTATIONS[1];
  return WORKSTATIONS[2];
}

/** 保额（分）：按种类费率 * 克拉重量 */
const RATE_PER_CT: Record<string, number> = {
  钻石: 12000,
  红宝石: 8000,
  蓝宝石: 8000,
  祖母绿: 9000,
};

export function insuredAmount(kind: string, weight: number): number {
  const rate = RATE_PER_CT[kind] ?? 5000;
  return Math.round(weight * rate * 100);
}

export function fmtAmount(cents: number): string {
  return "¥" + (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtCountdown(expiresAt: number, now: number): string {
  const left = Math.max(0, Math.round((expiresAt - now) / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function uid(prefix: string): string {
  return prefix + "-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freshState(): DeskState {
  return { stones: [], postings: [], conflicts: [], feed: [], toggles: { failWrite: false, badReceipt: false }, failArmed: true, savedAt: Date.now() };
}

function seedStones(): Stone[] {
  const now = Date.now();
  const mk = (partial: Partial<StoneInput> & { code: string; orderNo: string; weight: number; kind: string }): Stone => ({
    id: uid("stone"),
    code: partial.code,
    kind: partial.kind,
    shape: partial.shape ?? "圆形",
    weight: partial.weight,
    size: partial.size ?? "",
    clarity: partial.clarity ?? "",
    color: partial.color ?? "",
    cut: partial.cut ?? "",
    orderNo: partial.orderNo,
    targetSlotId: "auto",
    owner: "A",
    status: "draft",
    version: 0,
    createdAt: now,
    updatedAt: now,
  });
  return [
    mk({ code: "ST-2048", kind: "蓝宝石", shape: "椭圆", weight: 1.25, size: "6x4mm", clarity: "VS", color: "皇家蓝", cut: "椭圆刻面", orderNo: "DD-2026-0901" }),
    mk({ code: "ST-2061", kind: "钻石", shape: "圆形", weight: 0.08, size: "2.6mm", clarity: "SI", color: "H", cut: "明亮式", orderNo: "DD-2026-0902" }),
    mk({ code: "ST-2077", kind: "钻石", shape: "圆形", weight: 0.55, size: "5.2mm", clarity: "VS", color: "F", cut: "明亮式", orderNo: "DD-2026-0902" }),
    mk({ code: "ST-2083", kind: "祖母绿", shape: "梨形", weight: 2.1, size: "9x7mm", clarity: "微油", color: "翠绿", cut: "阶梯式", orderNo: "DD-2026-0903" }),
    mk({ code: "ST-2091", kind: "红宝石", shape: "椭圆", weight: 0.92, size: "6x4mm", clarity: "VS", color: "鸽血红", cut: "椭圆刻面", orderNo: "DD-2026-0904" }),
    mk({ code: "ST-2095", kind: "钻石", shape: "圆形", weight: 3.2, size: "9.4mm", clarity: "VVS", color: "D", cut: "明亮式", orderNo: "DD-2026-0905" }),
    mk({ code: "ST-2099", kind: "祖母绿", shape: "祖母绿切", weight: 1.66, size: "8x6mm", clarity: "内含物明显", color: "浅绿", cut: "阶梯式", orderNo: "DD-2026-0906" }),
    mk({ code: "ST-2103", kind: "蓝宝石", shape: "圆形", weight: 0.34, size: "4.5mm", clarity: "VS", color: "矢车菊", cut: "明亮式", orderNo: "DD-2026-0906" }),
  ];
}

function persist(state: DeskState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* 隐私模式等场景静默 */
  }
}

function load(): DeskState | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as DeskState;
    if (!parsed || !Array.isArray(parsed.stones)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

class DeskServer {
  private state: DeskState;
  private listeners = new Set<() => void>();
  private tickTimer: number;

  constructor() {
    const saved = load();
    if (saved) {
      this.state = saved;
      this.resume();
    } else {
      this.state = freshState();
      for (const s of seedStones()) {
        this.state.stones.push(s);
        this.attempt(s);
      }
    }
    this.tickTimer = window.setInterval(() => this.tick(), 1000);
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): DeskState => this.state;

  // ---------- 内部工具 ----------

  private emit(): void {
    this.state = {
      ...this.state,
      stones: this.state.stones.slice(),
      postings: this.state.postings.slice(),
      conflicts: this.state.conflicts.slice(),
      feed: this.state.feed.slice(),
      savedAt: Date.now(),
    };
    persist(this.state);
    this.listeners.forEach((fn) => fn());
  }

  private pushFeed(kind: FeedEntry["kind"], message: string): void {
    this.state.feed.unshift({ id: uid("feed"), at: Date.now(), kind, message });
    if (this.state.feed.length > 80) this.state.feed.length = 80;
  }

  private activeLeaseInSlot(slotId: string): Stone | undefined {
    return this.state.stones.find((s) => s.status === "leased" && s.lease?.slotId === slotId);
  }

  private activeLeaseCount(workstationId: string): number {
    return this.state.stones.filter((s) => s.status === "leased" && s.lease?.workstationId === workstationId).length;
  }

  private grantLease(s: Stone, slotId: string): void {
    const slot = SLOTS.find((sl) => sl.id === slotId)!;
    s.status = "leased";
    s.targetSlotId = slotId;
    s.waitlistSlotId = undefined;
    s.queueWorkstationId = undefined;
    s.version += 1;
    s.lease = {
      stoneId: s.id,
      slotId,
      workstationId: slot.workstationId,
      version: s.version,
      token: uid("lease"),
      craftsman: s.owner,
      grantedAt: Date.now(),
      expiresAt: Date.now() + TTL_MS,
    };
  }

  /** 占住裁决：
   * 自动分配 → 工位满员排队，否则占首个空镶位；
   * 指定镶位 → 镶位被占则候补（先到先得冲突），工位满员则排队。 */
  private attempt(s: Stone): "leased" | "waitlist" | "queued" {
    const explicit =
      !!s.targetSlotId && s.targetSlotId !== "auto" && SLOTS.some((sl) => sl.id === s.targetSlotId);
    let slotId: string;
    if (!explicit) {
      const ws = workstationForWeight(s.weight);
      const free = SLOTS.find((sl) => sl.workstationId === ws.id && !this.activeLeaseInSlot(sl.id));
      if (!free) {
        s.status = "queued";
        s.queueWorkstationId = ws.id;
        s.waitlistSlotId = undefined;
        this.pushFeed("queue", `工位满员：${ws.name}（${ws.capacity}席）已满，${s.code} 进入排队`);
        return "queued";
      }
      slotId = free.id;
    } else {
      slotId = s.targetSlotId;
    }

    const slot = SLOTS.find((sl) => sl.id === slotId)!;
    const holder = this.activeLeaseInSlot(slotId);
    if (holder && holder.id !== s.id) {
      s.status = "waitlist";
      s.waitlistSlotId = slotId;
      s.queueWorkstationId = undefined;
      const conflict: ConflictRecord = {
        id: uid("cf"),
        slotId,
        winnerStoneId: holder.id,
        loserStoneId: s.id,
        reason: "first-come",
        at: Date.now(),
      };
      this.state.conflicts.unshift(conflict);
      this.pushFeed(
        "conflict",
        `冲突：${holder.code} 已占${slot.name}，${s.code} 晚到一步，进候补（先到先得）`,
      );
      return "waitlist";
    }

    const ws = WORKSTATIONS.find((w) => w.id === slot.workstationId)!;
    if (this.activeLeaseCount(ws.id) >= ws.capacity) {
      s.status = "queued";
      s.queueWorkstationId = ws.id;
      s.waitlistSlotId = undefined;
      this.pushFeed("queue", `工位满员：${ws.name}（${ws.capacity}席）已满，${s.code} 进入排队`);
      return "queued";
    }

    this.grantLease(s, slotId);
    this.pushFeed("lease", `占住：${s.code} 租约 ${TTL_MS / 1000}s（${slot.name} · 师傅${s.owner}）`);
    return "leased";
  }

  /** 镶位空出后：候补优先转正，其次排队补位 */
  private promote(slotId: string): void {
    const slot = SLOTS.find((sl) => sl.id === slotId)!;
    const wait = this.state.stones
      .filter((s) => s.status === "waitlist" && s.waitlistSlotId === slotId)
      .sort((a, b) => a.updatedAt - b.updatedAt);
    if (wait.length > 0) {
      const s = wait[0];
      this.grantLease(s, slotId);
      this.pushFeed("promote", `候补转正：${s.code} 补入${slot.name}（先到先得）`);
      return;
    }
    const queue = this.state.stones
      .filter((s) => s.status === "queued" && s.queueWorkstationId === slot.workstationId)
      .sort((a, b) => a.updatedAt - b.updatedAt);
    if (queue.length > 0) {
      const s = queue[0];
      this.grantLease(s, slotId);
      this.pushFeed("promote", `排队补位：${s.code} 补入${slot.name}`);
    }
  }

  private releaseStone(s: Stone, reason: "expire" | "release"): void {
    if (!s.lease) return;
    const slotId = s.lease.slotId;
    const slot = SLOTS.find((sl) => sl.id === slotId)!;
    s.lease = undefined;
    s.status = "draft";
    if (reason === "expire") {
      this.pushFeed("expire", `租约到期：${s.code} 已释放${slot.name}`);
    } else {
      this.pushFeed("lease", `已释放：${s.code} 退出租约，${slot.name} 空出`);
    }
    this.promote(slotId);
  }

  private tick(): void {
    const now = Date.now();
    let changed = false;
    for (const s of this.state.stones) {
      if (s.status === "leased" && s.lease && s.lease.expiresAt <= now) {
        this.releaseStone(s, "expire");
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** 会话续作：过期租约立即失效，在途分录作废待重试 */
  private resume(): void {
    const now = Date.now();
    if (this.state.failArmed === undefined) this.state.failArmed = true;
    let expired = 0;
    for (const s of this.state.stones) {
      if (s.status === "leased" && s.lease && s.lease.expiresAt <= now) {
        s.lease = undefined;
        s.status = "draft";
        expired += 1;
      }
    }
    for (const p of this.state.postings) {
      if (p.status === "pending") {
        p.status = "void";
        p.note = "会话中断，入账结果未确认";
      }
    }
    // 释放出的镶位按候补/排队顺序补位
    for (const slot of SLOTS) {
      if (!this.activeLeaseInSlot(slot.id)) this.promote(slot.id);
    }
    this.state.resumedAt = now;
    this.pushFeed(
      "resume",
      `续作：已恢复 ${this.state.stones.length} 笔裸石记录，${expired} 笔过期租约已失效，${this.state.postings.filter((p) => p.status === "void").length} 笔在途分录待重试`,
    );
    persist(this.state);
  }

  // ---------- 台账 ----------

  /** 本地分录报账；按开关模拟写入失败 / 回执不符，失败留住已确认结果 */
  private createPosting(s: Stone): void {
    const localAmount = insuredAmount(s.kind, s.weight);
    const p: Posting = {
      id: uid("post"),
      stoneId: s.id,
      orderNo: s.orderNo,
      weight: s.weight,
      insuredAmount: localAmount,
      status: "pending",
      localVersion: (this.state.postings.filter((x) => x.stoneId === s.id).length || 0) + 1,
      createdAt: Date.now(),
    };
    this.state.postings.unshift(p);
    s.postingId = p.id;
    s.status = "confirmed"; // 入账期间保留确认结果，失败也不丢
    window.setTimeout(() => {
      const target = this.state.postings.find((x) => x.id === p.id);
      if (!target || target.status !== "pending") return;
      const stone = this.state.stones.find((x) => x.id === s.id);
      if (this.state.toggles.failWrite && this.state.failArmed) {
        target.status = "failed";
        target.note = "写入失败（模拟开关），已确认结果保留";
        this.state.failArmed = false;
        if (stone) stone.status = "failed";
        this.pushFeed("post", `入账失败：${s.code} 台账写入未确认，已留住确认结果，可只重试本笔`);
      } else if (this.state.toggles.badReceipt) {
        const delta = (Math.random() * 0.08 + 0.01) * (Math.random() < 0.5 ? -1 : 1);
        const extWeight = Math.round((s.weight + delta) * 100) / 100;
        target.externalWeight = extWeight;
        target.externalAmount = insuredAmount(s.kind, extWeight);
        target.externalVersion = 1;
        target.receiptNo = "RCP-" + uid("rcp");
        target.status = "mismatch";
        if (stone) stone.status = "mismatch";
        this.pushFeed(
          "post",
          `回执差异：${s.code} 本地 ${s.weight}ct / 台账 ${extWeight}ct，两版均保留`,
        );
      } else {
        target.status = "posted";
        target.postedAt = Date.now();
        target.receiptNo = "RCP-" + uid("rcp");
        if (stone) stone.status = "posted";
        this.pushFeed("post", `已入账：${s.code} 报保险台账 ${fmtAmount(localAmount)}`);
      }
      this.emit();
    }, LEDGER_LATENCY_MS + Math.random() * 300);
  }

  /** 冲正原分录并重报新分录：已入账/差异分录走红冲，失败分录直接作废 */
  private reverseAndRepost(s: Stone): void {
    const old = this.state.postings.find((p) => p.id === s.postingId);
    if (old) {
      if (old.status === "posted" || old.status === "mismatch") {
        old.status = "reversed";
        const rev: Posting = {
          id: uid("post"),
          stoneId: s.id,
          orderNo: old.orderNo,
          weight: old.weight,
          insuredAmount: -old.insuredAmount,
          status: "posted",
          reversalOf: old.id,
          reverses: old.id,
          localVersion: old.localVersion,
          note: "红冲分录",
          createdAt: Date.now(),
          postedAt: Date.now(),
        };
        this.state.postings.unshift(rev);
        this.pushFeed("reversal", `冲正：${s.code} 原台账分录已红冲（${fmtAmount(old.insuredAmount)}）`);
      } else {
        old.status = "void";
        old.note = "本地修改，作废重报";
      }
    }
    s.postingId = undefined;
    s.status = "reversed";
    this.createPosting(s);
  }

  // ---------- 对外动作 ----------

  async addStone(input: StoneInput): Promise<void> {
    await delay(LATENCY_MS);
    const now = Date.now();
    const stone: Stone = {
      id: uid("stone"),
      ...input,
      status: "draft",
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.state.stones.unshift(stone);
    this.pushFeed("info", `新到裸石：${stone.code}（${stone.kind} ${stone.weight}ct · 订单 ${stone.orderNo}）`);
    this.attempt(stone);
    this.emit();
  }

  async updateStone(id: string, patch: Partial<StoneInput>): Promise<void> {
    await delay(LATENCY_MS);
    const s = this.state.stones.find((x) => x.id === id);
    if (!s) return;
    const routingChanged =
      (patch.weight !== undefined && patch.weight !== s.weight) ||
      (patch.orderNo !== undefined && patch.orderNo !== s.orderNo) ||
      (patch.targetSlotId !== undefined && patch.targetSlotId !== s.targetSlotId);
    const wasPosted = ["posted", "mismatch", "failed"].includes(s.status);
    Object.assign(s, patch, { updatedAt: Date.now() });

    if (routingChanged) {
      // 订单号/石重一变：占用与租约立即失效，重新分拣
      if (s.lease) {
        const slotId = s.lease.slotId;
        this.pushFeed("edit", `订单号/石重变更：${s.code} 原租约立即失效，重新分拣`);
        s.lease = undefined;
        s.status = "draft";
        s.waitlistSlotId = undefined;
        s.queueWorkstationId = undefined;
        this.promote(slotId);
      } else {
        s.status = "draft";
        s.waitlistSlotId = undefined;
        s.queueWorkstationId = undefined;
      }
      if (wasPosted) {
        this.reverseAndRepost(s);
      } else {
        this.attempt(s);
      }
    } else if (wasPosted) {
      this.pushFeed("edit", `本地修改：${s.code} 冲正原分录后重报`);
      this.reverseAndRepost(s);
    }
    this.emit();
  }

  async submitPlacement(stoneId: string, craftsman: "A" | "B"): Promise<void> {
    await delay(LATENCY_MS);
    const s = this.state.stones.find((x) => x.id === stoneId);
    if (!s) return;
    s.owner = craftsman;
    if (s.status === "leased" && s.lease) {
      s.lease.expiresAt = Date.now() + TTL_MS;
      this.pushFeed("lease", `续租：${s.code} 租约续期 ${TTL_MS / 1000}s`);
    } else {
      this.attempt(s);
    }
    this.emit();
  }

  async renewLease(stoneId: string): Promise<void> {
    await delay(200);
    const s = this.state.stones.find((x) => x.id === stoneId);
    if (s?.status === "leased" && s.lease) {
      s.lease.expiresAt = Date.now() + TTL_MS;
      this.pushFeed("lease", `续租：${s.code} 租约续期 ${TTL_MS / 1000}s`);
      this.emit();
    }
  }

  async confirmPlacement(stoneId: string): Promise<void> {
    await delay(LATENCY_MS);
    const s = this.state.stones.find((x) => x.id === stoneId);
    if (s?.status !== "leased" || !s.lease) return;
    const slotId = s.lease.slotId;
    const slot = SLOTS.find((sl) => sl.id === slotId)!;
    s.lease = undefined;
    s.status = "confirmed";
    s.version += 1;
    this.pushFeed("lease", `已确认：${s.code} 镶位${slot.name} 交接完成，租约结束`);
    this.promote(slotId);
    this.emit();
  }

  async releaseLease(stoneId: string): Promise<void> {
    await delay(200);
    const s = this.state.stones.find((x) => x.id === stoneId);
    if (s?.status === "leased" && s.lease) {
      this.releaseStone(s, "release");
      this.emit();
    }
  }

  async leaveWaitlist(stoneId: string): Promise<void> {
    await delay(200);
    const s = this.state.stones.find((x) => x.id === stoneId);
    if (s && (s.status === "waitlist" || s.status === "queued")) {
      this.pushFeed("info", `退出${s.status === "waitlist" ? "候补" : "排队"}：${s.code}`);
      s.waitlistSlotId = undefined;
      s.queueWorkstationId = undefined;
      s.status = "draft";
      this.emit();
    }
  }

  async postOne(stoneId: string): Promise<void> {
    await delay(LATENCY_MS);
    const s = this.state.stones.find((x) => x.id === stoneId);
    if (!s || s.status !== "confirmed") return;
    this.createPosting(s);
    this.emit();
  }

  async postAll(): Promise<void> {
    await delay(LATENCY_MS);
    for (const s of this.state.stones) {
      if (s.status === "confirmed") this.createPosting(s);
    }
    this.emit();
  }

  /** 只重试没入账的：失败/作废分录冲销后重新报账 */
  async retryFailed(stoneId?: string): Promise<void> {
    await delay(LATENCY_MS);
    const targets = this.state.stones.filter((s) => {
      if (stoneId) return s.id === stoneId;
      return s.status === "failed";
    });
    for (const s of targets) {
      const old = this.state.postings.find((p) => p.id === s.postingId);
      if (old && (old.status === "failed" || old.status === "void")) {
        old.status = "void";
        old.note = "重试前作废";
      }
      s.postingId = undefined;
      s.status = "confirmed";
      this.pushFeed("post", `重试：${s.code} 仅重报未入账分录`);
      this.createPosting(s);
    }
    this.emit();
  }

  /** 双师傅同一事件循环内并发提交同一镶位：先到先得 */
  async runConcurrentDemo(): Promise<void> {
    let target = SLOTS.find(
      (slot) => !this.activeLeaseInSlot(slot.id) && this.activeLeaseCount(slot.workstationId) < WORKSTATIONS.find((w) => w.id === slot.workstationId)!.capacity,
    );
    if (!target) {
      // 满席时临时腾出最早到期的镶位（不触发补位，保证演示为空地）
      const held = this.state.stones
        .filter((s) => s.status === "leased" && s.lease)
        .sort((a, b) => a.lease!.expiresAt - b.lease!.expiresAt);
      const victim = held[0];
      if (victim?.lease) {
        target = SLOTS.find((sl) => sl.id === victim.lease!.slotId)!;
        this.pushFeed("info", `并发演示：临时腾出 ${target.name}（${victim.code} 退回待分拣，可重新提交）`);
        victim.lease = undefined;
        victim.status = "draft";
        victim.waitlistSlotId = undefined;
        victim.queueWorkstationId = undefined;
      }
    }
    if (!target) {
      this.pushFeed("info", "没有可演示的空闲镶位（请先释放一个镶位）");
      this.emit();
      return;
    }
    const base: StoneInput = {
      code: "ST-21" + String(Math.floor(Math.random() * 90) + 10),
      kind: "钻石",
      shape: "圆形",
      weight: 1.12,
      size: "6.5mm",
      clarity: "VS",
      color: "F",
      cut: "明亮式",
      orderNo: "DD-2026-DEMO",
      targetSlotId: target.id,
      owner: "A",
    };
    const mk = (owner: "A" | "B", code: string): Stone => ({
      id: uid("stone"),
      ...base,
      code,
      owner,
      status: "draft",
      version: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const a = mk("A", base.code + "-A");
    const b = mk("B", base.code + "-B");
    this.state.stones.unshift(b, a);
    this.pushFeed("info", `并发演示：师傅A、师傅B 同时提交 ${target.name}`);
    this.emit();
    // 同一事件循环内并发：服务端按调用顺序裁决，先到先得
    await Promise.all([this.submitPlacement(a.id, "A"), this.submitPlacement(b.id, "B")]);
  }

  setToggles(patch: Partial<DeskState["toggles"]>): void {
    this.state.toggles = { ...this.state.toggles, ...patch };
    if (patch.failWrite) this.state.failArmed = true;
    this.emit();
  }

  reset(): void {
    clearInterval(this.timer);
    localStorage.removeItem(STORAGE_KEY);
    const fresh = freshState();
    this.state = fresh;
    for (const s of seedStones()) {
      this.state.stones.push(s);
      this.attempt(s);
    }
    this.tickTimer = window.setInterval(() => this.tick(), 1000);
    this.emit();
  }
}

export const server = new DeskServer();
