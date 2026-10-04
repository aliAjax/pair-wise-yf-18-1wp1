// 镶位租约对账台 · 领域模型

export type Master = "A" | "B"; // 两个师傅

/** 裸石在分拣流水线中的阶段 */
export type Stage =
  | "idle" // 待分拣，未占镶位
  | "queued" // 工位满，排队中
  | "held" // 持租约占住镶位
  | "waitlisted" // 抢位晚到，进候补
  | "done" // 已完成分拣（有分拣结果）
  | "superseded"; // 改单后旧结果作废，待重新分拣

export interface Stone {
  id: string; // 宝石编号 ST-2048
  orderNo: string; // 订单号（改单指纹的一部分）
  kind: string; // 种类
  shape: string; // 形状/尺寸
  weightCt: number; // 克拉重量（改单指纹的一部分）
  note?: string; // 缺陷备注
  targetSeat: string; // 目标镶位
  version: number; // 改单一律 +1
  fingerprint: string; // orderNo + weightCt 指纹，指纹一变占用/租约立即失效
  stage: Stage;
}

/** 镶位租约：裸石占住镶位的凭证，带 TTL 与单调递增的 fencing token */
export interface Lease {
  leaseId: string;
  fencing: number;
  stoneId: string;
  seatId: string;
  master: Master;
  fingerprint: string; // 立约时的订单号|石重
  acquiredAt: number;
  expiresAt: number;
  ttlMs: number;
  ended: boolean;
  endReason?: "expired" | "revoked" | "completed";
}

/** 工位排队条目（容量信号量满时 FIFO） */
export interface QueueEntry {
  id: string;
  stoneId: string;
  master: Master;
  at: number;
}

export interface StationAssignment {
  stoneId: string;
  seatId: string;
  leaseId: string;
  since: number;
}

/** 候补条目：晚到的提交，留底当时的冲突现场 */
export interface WaitEntry {
  id: string;
  stoneId: string;
  seatId: string;
  master: Master;
  at: number;
  conflictLeaseId: string;
  conflictStoneId: string;
  conflictMaster: Master;
  holderSince: number;
}

/** 分拣结果（报保险台账的依据） */
export interface SortResult {
  stoneId: string;
  seatId: string;
  master: Master;
  fingerprint: string;
  at: number;
}

/** 台账报文的一版快照（本地版 / 回执版各一份） */
export interface VersionSnap {
  stoneId: string;
  orderNo: string;
  weightCt: number;
  seatId: string;
  fingerprint: string;
}

export type ReportKind = "report" | "reversal"; // 投保上报 / 冲正
export type ReportStatus =
  | "pending" // 未入账：失败后停留在此，只重投这种
  | "confirmed" // 已入账且回执相符
  | "mismatch"; // 回执对不上：两版都留，不得覆盖

export interface Receipt {
  no: string; // 外部回执号
  at: number;
  echoOrderNo: string;
  echoWeightCt: number;
  checksum: string;
}

export interface OutboxItem {
  key: string; // 幂等键 RPT:<stone>:<fingerprint> / REV:<原键>
  kind: ReportKind;
  stoneId: string;
  local: VersionSnap; // 本地版
  status: ReportStatus;
  attempts: number;
  lastError?: string;
  createdAt: number;
  postedAt?: number;
  receipt?: Receipt;
  external?: VersionSnap; // 回执版（仅 mismatch 时留存）
  reverses?: string; // 冲正关联的原报文键
  note?: string;
}

export type LogTone = "teal" | "rose" | "amber" | "slate" | "violet";

export interface LogLine {
  seq: number;
  at: number;
  tone: LogTone;
  text: string;
}

export interface State {
  seq: number;
  stones: Record<string, Stone>;
  /** seatId -> 当前生效租约 */
  leases: Record<string, Lease>;
  leaseHistory: Lease[];
  waitlist: WaitEntry[];
  queue: QueueEntry[];
  stations: { capacity: number; assignments: StationAssignment[] };
  results: Record<string, SortResult>;
  outbox: OutboxItem[];
  ledger: LogLine[];
  settings: { flaky: boolean; mismatchOnce: boolean };
}
