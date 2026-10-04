// 珠宝镶嵌 · 裸石分拣对账台 —— 领域类型

export type Craftsman = "A" | "B";

/** 裸石分拣状态 */
export type StoneStatus =
  | "draft" // 待分拣
  | "leased" // 占住中（有效租约）
  | "waitlist" // 候补（同一镶位晚到一步）
  | "queued" // 排队（工位容量满）
  | "confirmed" // 已确认
  | "posted" // 已报保险台账
  | "mismatch" // 回执差异（两版留存）
  | "failed" // 写入失败（待重试）
  | "reversed"; // 已冲正，重报中

/** 镶位租约 */
export interface Lease {
  stoneId: string;
  slotId: string;
  workstationId: string;
  version: number;
  token: string;
  craftsman: Craftsman;
  grantedAt: number;
  expiresAt: number;
}

export interface Stone {
  id: string;
  code: string; // 宝石编号
  kind: string; // 种类
  shape: string; // 形状
  weight: number; // 克拉重量 ct
  size: string; // 尺寸
  clarity: string; // 净度
  color: string; // 颜色
  cut: string; // 切工
  orderNo: string; // 订单号
  targetSlotId: string; // 目标镶位，"auto" 为自动分配
  owner: Craftsman;
  status: StoneStatus;
  lease?: Lease;
  waitlistSlotId?: string;
  queueWorkstationId?: string;
  version: number;
  postingId?: string;
  createdAt: number;
  updatedAt: number;
}

export type PostingStatus =
  | "pending" // 入账中
  | "posted" // 已入账
  | "failed" // 写入失败
  | "mismatch" // 回执差异
  | "reversed" // 已冲正
  | "void"; // 会话中断作废（未入账）

/** 保险台账分录 */
export interface Posting {
  id: string;
  stoneId: string;
  orderNo: string;
  weight: number; // 本地口径石重
  insuredAmount: number; // 本地口径保额（分）
  externalWeight?: number; // 台账回执石重（外部口径）
  externalAmount?: number; // 台账回执保额
  status: PostingStatus;
  reversalOf?: string; // 冲正指向的原分录
  reverses?: string; // 本分录冲正的原分录 id
  localVersion: number;
  externalVersion?: number;
  receiptNo?: string;
  note?: string;
  createdAt: number;
  postedAt?: number;
}

export interface ConflictRecord {
  id: string;
  slotId: string;
  winnerStoneId: string;
  loserStoneId: string;
  reason: "first-come";
  at: number;
}

export type FeedKind =
  | "lease"
  | "conflict"
  | "queue"
  | "expire"
  | "promote"
  | "post"
  | "reversal"
  | "edit"
  | "resume"
  | "info";

export interface FeedEntry {
  id: string;
  at: number;
  kind: FeedKind;
  message: string;
}

export interface DeskToggles {
  failWrite: boolean; // 模拟台账写入失败
  badReceipt: boolean; // 模拟外部回执与本地不符
}

export interface DeskState {
  stones: Stone[];
  postings: Posting[];
  conflicts: ConflictRecord[];
  feed: FeedEntry[];
  toggles: DeskToggles;
  /** 模拟写入失败：打开后首次报账失败，重试成功 */
  failArmed: boolean;
  savedAt: number;
  resumedAt?: number;
}

export interface Slot {
  id: string;
  name: string;
  workstationId: string;
}

export interface Workstation {
  id: string;
  name: string;
  capacity: number;
}

export interface StoneInput {
  code: string;
  kind: string;
  shape: string;
  weight: number;
  size: string;
  clarity: string;
  color: string;
  cut: string;
  orderNo: string;
  targetSlotId: string;
  owner: Craftsman;
}
