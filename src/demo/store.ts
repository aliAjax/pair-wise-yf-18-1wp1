import type {
  Lease,
  LogLine,
  LogTone,
  Master,
  OutboxItem,
  QueueEntry,
  Receipt,
  SortResult,
  State,
  Stone,
  VersionSnap,
  WaitEntry,
} from "./types";

// ───────────────────────────── 常量 ─────────────────────────────

export const LEASE_TTL_MS = 45_000;
export const STORAGE_KEY = "inlay-reconcile-v1";

export interface SeatDef {
  id: string;
  label: string;
  angle: number; // 度，用于戒指图布局
  radius: number;
}

/** 一枚戒指：中央主石位 + 8 个围石位 */
export const SEATS: SeatDef[] = [
  { id: "C-主", label: "中央主石位", angle: -90, radius: 0 },
  { id: "N-围", label: "北围石", angle: -90, radius: 118 },
  { id: "NE-围", label: "东北围石", angle: -45, radius: 118 },
  { id: "E-围", label: "东围石", angle: 0, radius: 118 },
  { id: "SE-围", label: "东南围石", angle: 45, radius: 118 },
  { id: "S-围", label: "南围石", angle: 90, radius: 118 },
  { id: "SW-围", label: "西南围石", angle: 135, radius: 118 },
  { id: "W-围", label: "西围石", angle: 180, radius: 118 },
  { id: "NW-围", label: "西北围石", angle: 225, radius: 118 },
];

export const fingerprintOf = (orderNo: string, weightCt: number) =>
  `${orderNo.trim()}|${Number(weightCt)}ct`;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── 初始数据 ─────────────────────────────

function seed(): State {
  const mk = (
    id: string,
    orderNo: string,
    kind: string,
    shape: string,
    weightCt: number,
    targetSeat: string,
    note?: string,
  ): Stone => ({
    id,
    orderNo,
    kind,
    shape,
    weightCt,
    targetSeat,
    note,
    version: 1,
    fingerprint: fingerprintOf(orderNo, weightCt),
    stage: "idle",
  });

  const stones: Stone[] = [
    mk("ST-2048", "D-101", "蓝宝石", "椭圆 6×4mm", 1.12, "C-主", "亭部微裂，轻放"),
    mk("ST-2049", "D-101", "钻石", "圆钻 1.3mm", 0.009, "N-围"),
    mk("ST-2050", "D-101", "钻石", "圆钻 1.3mm", 0.009, "NE-围"),
    mk("ST-2051", "D-101", "钻石", "圆钻 1.3mm", 0.009, "E-围"),
    mk("ST-2061", "D-102", "钻石", "圆钻 0.08ct", 0.08, "S-围", "已分拣示例"),
    mk("ST-2072", "D-103", "祖母绿", "祖母绿切 4×3mm", 0.36, "SE-围", "内含物明显"),
    // 与 ST-2048 抢同一个主石位的备石 —— 用于双师傅同交一位
    mk("ST-2099", "D-104", "红宝石", "椭圆 6×4mm", 1.18, "C-主", "客户候选备石"),
  ];

  const seedReceipt: Receipt = {
    no: "RCP-7001",
    at: Date.now(),
    echoOrderNo: "D-102",
    echoWeightCt: 0.08,
    checksum: "OK",
  };

  return {
    seq: 1,
    stones: Object.fromEntries(stones.map((s) => [s.id, s])),
    leases: {},
    leaseHistory: [],
    waitlist: [],
    queue: [],
    stations: { capacity: 3, assignments: [] },
    results: {
      "ST-2061": {
        stoneId: "ST-2061",
        seatId: "S-围",
        master: "A",
        fingerprint: fingerprintOf("D-102", 0.08),
        at: Date.now() - 1000 * 60 * 40,
      },
    },
    outbox: [
      {
        key: "RPT:ST-2061:D-102|0.08ct",
        kind: "report",
        stoneId: "ST-2061",
        status: "confirmed",
        attempts: 1,
        createdAt: Date.now() - 1000 * 60 * 40,
        postedAt: Date.now() - 1000 * 60 * 40,
        receipt: seedReceipt,
        local: {
          stoneId: "ST-2061",
          orderNo: "D-102",
          weightCt: 0.08,
          seatId: "S-围",
          fingerprint: fingerprintOf("D-102", 0.08),
        },
      },
    ],
    ledger: [
      {
        seq: 0,
        at: Date.now(),
        tone: "slate",
        text: "白板记录已迁入对账台：9 个镶位、工位容量 3、租约 TTL 45 秒；ST-2061 历史分拣结果已入账。",
      },
    ],
    settings: { flaky: false, mismatchOnce: false },
  };
}

// ───────────────────────────── 模拟服务端 ─────────────────────────────
// 单命令队列：所有提交串行处理 => 先到先得由到达顺序决定。
// 状态 + 事件台账整体持久化，刷新后 hydrate => 可续作。

type Outcome = { ok: true; message: string } | { ok: false; error: string };

class SimServer {
  state: State;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private busyCount = 0;
  resumedNote: string | null = null;

  constructor() {
    this.state = this.hydrate();
  }

  // ── 订阅 ──
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  isBusy() {
    return this.busyCount > 0;
  }

  // ── 持久化 / 续作 ──
  private hydrate(): State {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return seed();
      const state = JSON.parse(raw) as State;
      const now = Date.now();
      const expired = Object.values(state.leases).filter((l) => l.expiresAt <= now);
      if (expired.length) {
        for (const lease of expired) {
          lease.ended = true;
          lease.endReason = "expired";
          state.leaseHistory.unshift(lease);
          delete state.leases[lease.seatId];
          state.stations.assignments = state.stations.assignments.filter(
            (a) => a.leaseId !== lease.leaseId,
          );
          const st = state.stones[lease.stoneId];
          if (st && st.stage === "held") st.stage = "idle";
        }
        this.pumpStations(state, now);
        this.resumedNote = `续作恢复：发现 ${expired.length} 份租约已到期（${expired
          .map((l) => `${l.stoneId}@${l.seatId}`)
          .join("、")}），占位自动释放，候补保留待人工重交。`;
      } else {
        this.resumedNote = "续作恢复：租约与台账完整，直接接着上次干。";
      }
      return state;
    } catch {
      return seed();
    }
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* 配额满时不丢内存态 */
    }
  }

  reset() {
    localStorage.removeItem(STORAGE_KEY);
    this.state = seed();
    this.resumedNote = null;
    this.persist();
    this.emit();
  }

  // ── 串行命令执行 ──
  private run<T>(label: string, fn: (s: State) => Outcome, latency = 260): Promise<Outcome> {
    this.busyCount++;
    this.emit();
    const task = this.queue
      .then(() => delay(latency))
      .then(() => {
        const before = JSON.stringify(this.state);
        let outcome: Outcome;
        try {
          outcome = fn(this.state);
        } catch (err) {
          outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        this.log(this.state, outcome.ok ? "slate" : "rose", `${label} → ${outcome.ok ? outcome.message : "失败：" + outcome.error}`);
        if (JSON.stringify(this.state) !== before) this.persist();
        return outcome;
      });
    this.queue = task.catch(() => {});
    void task.finally(() => {
      this.busyCount--;
      this.emit();
    });
    return task;
  }

  private log(s: State, tone: LogTone, text: string) {
    const line: LogLine = { seq: s.seq++, at: Date.now(), tone, text };
    s.ledger.unshift(line);
    if (s.ledger.length > 220) s.ledger.length = 220;
  }

  // ── 命令：师傅提交裸石占镶位 ──
  submitStone(stoneId: string, master: Master) {
    return this.run(`师傅${master} 提交 ${stoneId}`, (s) => {
      const stone = s.stones[stoneId];
      if (!stone) throw new Error("没有这颗裸石");
      if (stone.stage === "held") return { ok: false, error: "已持租约占着镶位，勿重复提交" };
      if (stone.stage === "queued") return { ok: false, error: "已在工位队列里排队" };
      if (stone.stage === "done") return { ok: false, error: "已完成分拣，改单请走改单" };

      // 1) 镶位先到先得（争的是镶位，与订单无关；fencing token 挡住迟到写入）
      const existing = s.leases[stone.targetSeat];
      if (existing) {
        const lag = Date.now() - existing.acquiredAt;
        const entry: WaitEntry = {
          id: `W${s.seq}`,
          stoneId,
          seatId: stone.targetSeat,
          master,
          at: Date.now(),
          conflictLeaseId: existing.leaseId,
          conflictStoneId: existing.stoneId,
          conflictMaster: existing.master,
          holderSince: existing.acquiredAt,
        };
        s.waitlist.unshift(entry);
        stone.stage = "waitlisted";
        this.log(
          s,
          "amber",
          `冲突留底：师傅${master} 的 ${stoneId} 晚到 ${lag}ms，镶位 ${stone.targetSeat} 已被师傅${existing.master} 的 ${existing.stoneId}（fencing ${existing.fencing}）租下 → 进候补。`,
        );
        return {
          ok: true,
          message: `晚到 ${lag}ms：镶位被 ${existing.stoneId} 先租，${stoneId} 进候补并保留冲突现场`,
        };
      }

      // 2) 工位容量（信号量）：满了排队
      if (s.stations.assignments.length >= s.stations.capacity) {
        const entry: QueueEntry = { id: `Q${s.seq}`, stoneId, master, at: Date.now() };
        s.queue.push(entry);
        stone.stage = "queued";
        return { ok: true, message: `工位容量 ${s.stations.capacity} 已满，${stoneId} 第 ${s.queue.length} 位排队` };
      }

      this.grant(s, stone, master, Date.now());
      return { ok: true, message: `租约立成：${stoneId} 占住 ${stone.targetSeat}` };
    });
  }

  private grant(s: State, stone: Stone, master: Master, now: number): Lease {
    const lease: Lease = {
      leaseId: `L${s.seq}`,
      fencing: s.seq,
      stoneId: stone.id,
      seatId: stone.targetSeat,
      master,
      fingerprint: stone.fingerprint,
      acquiredAt: now,
      expiresAt: now + LEASE_TTL_MS,
      ttlMs: LEASE_TTL_MS,
      ended: false,
    };
    s.leases[stone.targetSeat] = lease;
    s.stations.assignments.push({ stoneId: stone.id, seatId: stone.targetSeat, leaseId: lease.leaseId, since: now });
    stone.stage = "held";
    // 租约立成，先前针对该石的候补冲突现场标记消解
    s.waitlist = s.waitlist.filter((w) => w.stoneId !== stone.id);
    this.log(s, "teal", `租约 ${lease.leaseId} 立成：${stone.id} 以 fencing ${lease.fencing} 占住 ${stone.targetSeat}（师傅${master}，${Math.round(LEASE_TTL_MS / 1000)}s 后到期）。`);
    return lease;
  }

  // ── 命令：候补重交（持位方完工/到期后补位） ──
  retryWait(waitId: string) {
    return this.run(`候补补位 ${waitId}`, (s) => {
      const w = s.waitlist.find((x) => x.id === waitId);
      if (!w) throw new Error("候补条目不存在");
      const stone = s.stones[w.stoneId];
      if (s.leases[w.seatId]) return { ok: false, error: `镶位 ${w.seatId} 仍被 ${s.leases[w.seatId].stoneId} 占着` };
      s.waitlist = s.waitlist.filter((x) => x.id !== waitId);
      if (s.stations.assignments.length >= s.stations.capacity) {
        s.queue.push({ id: `Q${s.seq}`, stoneId: stone.id, master: w.master, at: Date.now() });
        stone.stage = "queued";
        return { ok: true, message: `镶位空了但工位满，${stone.id} 转排队` };
      }
      this.grant(s, stone, w.master, Date.now());
      return { ok: true, message: `候补补位成功：${stone.id} 租下 ${w.seatId}` };
    });
  }

  // ── 命令：完成分拣（结果即保险上报依据） ──
  complete(stoneId: string) {
    return this.run(`完成分拣 ${stoneId}`, (s) => {
      const stone = s.stones[stoneId];
      const lease = s.leases[stone.targetSeat];
      if (!lease || lease.stoneId !== stoneId) return { ok: false, error: "没有生效租约，不能报完成" };
      const result: SortResult = {
        stoneId,
        seatId: lease.seatId,
        master: lease.master,
        fingerprint: stone.fingerprint,
        at: Date.now(),
      };
      s.results[stoneId] = result;
      stone.stage = "done";
      lease.ended = true;
      lease.endReason = "completed";
      s.leaseHistory.unshift(lease);
      delete s.leases[lease.seatId];
      s.stations.assignments = s.stations.assignments.filter((a) => a.leaseId !== lease.leaseId);
      this.log(s, "teal", `${stoneId} 在 ${lease.seatId} 完成分拣，租约 ${lease.leaseId} 正常结束，工位释放。`);
      this.enqueueReport(s, stone, result);
      this.pumpStations(s, Date.now());
      return { ok: true, message: "分拣结果已出，保险报文已进台账待发" };
    });
  }

  // ── 命令：改单（订单号或石重一变 → 占用/租约立即失效，整体重算） ──
  amendStone(stoneId: string, nextOrderNo: string, nextWeight: number) {
    return this.run(`改单 ${stoneId}`, (s) => {
      const stone = s.stones[stoneId];
      const fp = fingerprintOf(nextOrderNo, nextWeight);
      if (fp === stone.fingerprint) return { ok: false, error: "订单号与石重都没变，不算改单" };

      const oldFp = stone.fingerprint;
      const changes: string[] = [];
      if (nextOrderNo.trim() !== stone.orderNo.trim()) changes.push(`订单号 ${stone.orderNo} → ${nextOrderNo}`);
      if (Number(nextWeight) !== stone.weightCt) changes.push(`石重 ${stone.weightCt}ct → ${Number(nextWeight)}ct`);

      stone.orderNo = nextOrderNo.trim();
      stone.weightCt = Number(nextWeight);
      stone.fingerprint = fp;
      stone.version += 1;

      // 旧指纹的已入账保险：本地再改 → 先冲正旧版，等重分拣后重报新版
      this.reverseForFingerprint(s, stoneId, oldFp, `改单（v${stone.version}）：${changes.join("，")}`);

      // 占着镶位？租约立即作废
      const lease = s.leases[stone.targetSeat];
      if (lease && lease.stoneId === stoneId) {
        lease.ended = true;
        lease.endReason = "revoked";
        s.leaseHistory.unshift(lease);
        delete s.leases[lease.seatId];
        s.stations.assignments = s.stations.assignments.filter((a) => a.leaseId !== lease.leaseId);
        this.log(s, "rose", `指纹变更使租约 ${lease.leaseId} 即刻失效（${changes.join("，")}），${stone.targetSeat} 镶位腾空。`);
      }

      // 旧分拣结果作废
      if (s.results[stoneId] && s.results[stoneId].fingerprint !== fp) {
        delete s.results[stoneId];
        this.log(s, "rose", `${stoneId} 旧分拣结果（指纹 ${oldFp}）随改单作废，待重新分拣。`);
      }

      // 排队/候补中？全部摘出回到待分拣，随后统一重算
      s.queue = s.queue.filter((q) => q.stoneId !== stoneId);
      s.waitlist = s.waitlist.filter((w) => w.stoneId !== stoneId);
      stone.stage = "idle";

      // 候补重算：若等的就是刚腾空的位且自己仍在候补 → 保留人工补位；队列补位
      this.pumpStations(s, Date.now());
      return { ok: true, message: `改单生效（v${stone.version}），占用与租约已重算：${changes.join("，")}` };
    });
  }

  /** 释放工位后 FIFO 补位：先拿工位、再抢镶位（抢不到进候补） */
  private pumpStations(s: State, now: number) {
    while (s.stations.assignments.length < s.stations.capacity && s.queue.length) {
      const q = s.queue.shift()!;
      const stone = s.stones[q.stoneId];
      if (!stone || stone.stage !== "queued") continue;
      if (s.leases[stone.targetSeat]) {
        const existing = s.leases[stone.targetSeat];
        s.waitlist.unshift({
          id: `W${s.seq}`,
          stoneId: stone.id,
          seatId: stone.targetSeat,
          master: q.master,
          at: now,
          conflictLeaseId: existing.leaseId,
          conflictStoneId: existing.stoneId,
          conflictMaster: existing.master,
          holderSince: existing.acquiredAt,
        });
        stone.stage = "waitlisted";
        this.log(s, "amber", `队列补位到 ${stone.id} 但镶位被 ${existing.stoneId} 占着 → 进候补（不占工位名额）。`);
        continue;
      }
      this.grant(s, stone, q.master, now);
    }
  }

  // ── 租约到期（由界面每秒驱动；同一时刻只走一次） ──
  tick() {
    const s = this.state;
    const now = Date.now();
    let changed = false;
    for (const lease of Object.values(s.leases)) {
      if (lease.expiresAt <= now) {
        lease.ended = true;
        lease.endReason = "expired";
        s.leaseHistory.unshift(lease);
        delete s.leases[lease.seatId];
        s.stations.assignments = s.stations.assignments.filter((a) => a.leaseId !== lease.leaseId);
        const stone = s.stones[lease.stoneId];
        if (stone && stone.stage === "held") stone.stage = "idle";
        this.log(s, "amber", `租约 ${lease.leaseId}（${lease.stoneId}@${lease.seatId}，师傅${lease.master}）到期未续，占位释放。`);
        changed = true;
      }
    }
    if (changed) {
      this.pumpStations(s, now);
      this.persist();
      this.emit();
    }
  }

  // ───────────────────── 保险台账 outbox ─────────────────────

  private snap(stone: Stone, seatId: string): VersionSnap {
    return { stoneId: stone.id, orderNo: stone.orderNo, weightCt: stone.weightCt, seatId, fingerprint: stone.fingerprint };
  }

  private enqueueReport(s: State, stone: Stone, result: SortResult) {
    const key = `RPT:${stone.id}:${stone.fingerprint}`;
    if (s.outbox.some((o) => o.key === key)) {
      this.log(s, "slate", `${stone.id}（${stone.fingerprint}）报文已在台账，幂等跳过，不重复上报。`);
      return;
    }
    s.outbox.unshift({
      key,
      kind: "report",
      stoneId: stone.id,
      local: this.snap(stone, result.seatId),
      status: "pending",
      attempts: 0,
      createdAt: Date.now(),
    });
    this.log(s, "violet", `分拣结果已写入 outbox 待报保险：${key}（未入账，故障后只重投它）。`);
  }

  /** 旧指纹报文冲正：confirmed 直接挂冲正；mismatch 两版留存再挂冲正 */
  private reverseForFingerprint(s: State, stoneId: string, oldFp: string, reason: string) {
    const olds = s.outbox.filter((o) => o.stoneId === stoneId && o.kind === "report" && o.local.fingerprint === oldFp);
    for (const old of olds) {
      const revKey = `REV:${old.key}`;
      if (s.outbox.some((o) => o.key === revKey)) continue;
      if (old.status === "confirmed") {
        s.outbox.unshift({
          key: revKey,
          kind: "reversal",
          stoneId,
          local: old.local,
          status: "pending",
          attempts: 0,
          createdAt: Date.now(),
          reverses: old.key,
          note: reason,
        });
        this.log(s, "violet", `本地再改 → 已入账 ${old.key} 生成冲正 ${revKey}，重分拣后按新指纹重报。`);
      } else if (old.status === "mismatch") {
        s.outbox.unshift({
          key: revKey,
          kind: "reversal",
          stoneId,
          local: old.local,
          status: "pending",
          attempts: 0,
          createdAt: Date.now(),
          reverses: old.key,
          note: `${reason}；原报文回执不符，双版继续留底`,
        });
        this.log(s, "violet", `双版留底的不符报文 ${old.key} 随改单补挂冲正，本地版/回执版均保留。`);
      }
    }
  }

  /** 只重投没入账的：pending。confirmed 不动，mismatch 不动。 */
  flushOutbox(onlyKey?: string) {
    return this.run(
      onlyKey ? `重投 ${onlyKey}` : "重投全部未入账报文",
      (s) => {
        const pendings = s.outbox.filter((o) => o.status === "pending" && (!onlyKey || o.key === onlyKey));
        if (!pendings.length) return { ok: true, message: "没有未入账报文需要重投" };
        let ok = 0;
        let failed = 0;
        for (const item of pendings) this.postOne(s, item) ? ok++ : failed++;
        return failed
          ? { ok: false, error: `${ok} 份入账，${failed} 份仍失败（已确认的未动，失败的留在 pending 待重试）` }
          : { ok: true, message: `${ok} 份未入账报文已重投并取得回执` };
      },
      420,
    );
  }

  /** 模拟保险公司端点：成功 / 网络失败（可注入）/ 回执对不上（一次性注入） */
  private postOne(s: State, item: OutboxItem): boolean {
    item.attempts++;
    if (s.settings.flaky) {
      item.lastError = "对端网络抖动，写入失败";
      this.log(s, "rose", `${item.key} 第 ${item.attempts} 次发送失败：${item.lastError}（已确认报文不受影响）。`);
      return false;
    }
    const now = Date.now();
    // 一次性「回执对不上」：回执把订单号/石重回错
    const mismatch = s.settings.mismatchOnce;
    if (mismatch) s.settings.mismatchOnce = false;
    const echoOrderNo = mismatch ? item.local.orderNo + "X" : item.local.orderNo;
    const echoWeight = mismatch ? Math.max(0.001, item.local.weightCt + 0.05) : item.local.weightCt;
    const receipt: Receipt = {
      no: `RCP-${Math.floor(Math.random() * 9000 + 1000)}`,
      at: now,
      echoOrderNo,
      echoWeightCt: echoWeight,
      checksum: mismatch ? "DIFF" : "OK",
    };
    item.postedAt = now;
    item.receipt = receipt;
    const external: VersionSnap = { ...item.local, orderNo: echoOrderNo, weightCt: echoWeight, fingerprint: fingerprintOf(echoOrderNo, echoWeight) };
    const consistent = echoOrderNo === item.local.orderNo && echoWeight === item.local.weightCt;
    if (!consistent) {
      item.status = "mismatch";
      item.external = external;
      item.lastError = "回执订单号/石重与本地版对不上";
      this.log(s, "amber", `⚠ 回执不符：${item.key} 本地「${item.local.orderNo}/${item.local.weightCt}ct」 vs 回执「${echoOrderNo}/${echoWeight}ct」→ 两版都留，挂起待对账，不覆盖本地。`);
    } else {
      item.status = "confirmed";
      item.lastError = undefined;
      this.log(s, "teal", `${item.kind === "reversal" ? "冲正" : "上报"}入账：${item.key} ← 回执 ${receipt.no}，核对一致。`);
    }
    return consistent;
  }

  setSetting(key: "flaky" | "mismatchOnce", value: boolean) {
    this.state.settings[key] = value;
    this.persist();
    this.emit();
  }
}

export const server = new SimServer();
