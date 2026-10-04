// 对账台界面组件
import { useEffect, useState } from "react";
import type { Craftsman, DeskState, FeedEntry, Posting, Stone, StoneInput, StoneStatus } from "./types";
import { SLOTS, WORKSTATIONS, fmtAmount, fmtCountdown, insuredAmount, server } from "./server";

/* ---------------- 状态元数据 ---------------- */

const STONE_STATUS_META: Record<StoneStatus, { label: string; cls: string }> = {
  draft: { label: "待分拣", cls: "st-draft" },
  leased: { label: "占住中", cls: "st-leased" },
  waitlist: { label: "候补", cls: "st-wait" },
  queued: { label: "排队中", cls: "st-queue" },
  confirmed: { label: "已确认", cls: "st-confirmed" },
  posted: { label: "已报账", cls: "st-posted" },
  mismatch: { label: "回执差异·两版", cls: "st-mismatch" },
  failed: { label: "写入失败·待重试", cls: "st-failed" },
  reversed: { label: "冲正重报中", cls: "st-reversed" },
};

const POSTING_STATUS_META: Record<Posting["status"], { label: string; cls: string }> = {
  pending: { label: "入账中", cls: "st-pending" },
  posted: { label: "已入账", cls: "st-posted" },
  failed: { label: "写入失败", cls: "st-failed" },
  mismatch: { label: "回执差异", cls: "st-mismatch" },
  reversed: { label: "已冲正", cls: "st-reversed" },
  void: { label: "已作废", cls: "st-void" },
};

const FEED_CLS: Record<FeedEntry["kind"], string> = {
  lease: "fd-lease",
  conflict: "fd-conflict",
  queue: "fd-queue",
  expire: "fd-expire",
  promote: "fd-promote",
  post: "fd-post",
  reversal: "fd-reversal",
  edit: "fd-edit",
  resume: "fd-resume",
  info: "fd-info",
};

const KINDS = ["钻石", "红宝石", "蓝宝石", "祖母绿", "其他"];
const SHAPES = ["圆形", "椭圆", "梨形", "祖母绿切", "马眼形", "水滴形"];

function StatusBadge({ label, cls }: { label: string; cls: string }) {
  return <span className={`badge ${cls}`}>{label}</span>;
}

function StoneBadge({ status }: { status: StoneStatus }) {
  const meta = STONE_STATUS_META[status];
  return <StatusBadge label={meta.label} cls={meta.cls} />;
}

function PostingBadge({ status }: { status: Posting["status"] }) {
  const meta = POSTING_STATUS_META[status];
  return <StatusBadge label={meta.label} cls={meta.cls} />;
}

function OwnerTag({ owner }: { owner: Craftsman }) {
  return <span className={`owner-tag owner-${owner.toLowerCase()}`}>师傅{owner}</span>;
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/* ---------------- 工位 · 镶位示意图 ---------------- */

function SlotBox({ stoneId, state, now }: { stoneId?: string; state: DeskState; now: number }) {
  const stone = stoneId ? state.stones.find((s) => s.id === stoneId) : undefined;
  if (!stone || !stone.lease) {
    return <div className="slot slot-empty">空镶位</div>;
  }
  const pct = Math.max(0, Math.min(100, ((stone.lease.expiresAt - now) / 45000) * 100));
  const urgent = pct < 25;
  return (
    <div className="slot slot-held">
      <div className="slot-top">
        <b>{stone.code}</b>
        <OwnerTag owner={stone.owner} />
      </div>
      <div className="slot-weight">{stone.kind} {stone.weight}ct</div>
      <div className={`lease-count ${urgent ? "urgent" : ""}`}>
        <span>租约 {fmtCountdown(stone.lease.expiresAt, now)}</span>
        <div className="lease-bar">
          <i style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="slot-actions">
        <button className="mini" onClick={() => server.renewLease(stone.id)}>续租</button>
        <button className="mini" onClick={() => server.confirmPlacement(stone.id)}>确认</button>
        <button className="mini" onClick={() => server.releaseLease(stone.id)}>释放</button>
      </div>
    </div>
  );
}

export function WorkstationBoard({ state }: { state: DeskState }) {
  const now = useNow();
  return (
    <div className="board">
      {WORKSTATIONS.map((ws) => {
        const slots = SLOTS.filter((sl) => sl.workstationId === ws.id);
        const held = state.stones.filter((s) => s.status === "leased" && s.lease?.workstationId === ws.id);
        return (
          <div key={ws.id} className="ws-card">
            <div className="ws-head">
              <h3>{ws.name}</h3>
              <span className="ws-cap">
                {held.length}/{ws.capacity} 席
              </span>
            </div>
            <div className="slot-grid">
              {slots.map((slot) => {
                const occupant = state.stones.find(
                  (s) => s.status === "leased" && s.lease?.slotId === slot.id,
                );
                return (
                  <div key={slot.id} className="slot-wrap">
                    <p className="slot-name">{slot.name}</p>
                    <SlotBox stoneId={occupant?.id} state={state} now={now} />
                  </div>
                );
              })}
            </div>
            <div className="ws-lists">
              {slots.map((slot) => {
                const waiters = state.stones.filter(
                  (s) => s.status === "waitlist" && s.waitlistSlotId === slot.id,
                );
                if (waiters.length === 0) return null;
                return (
                  <div key={slot.id} className="wait-row">
                    <span className="wait-label">{slot.name} 候补</span>
                    {waiters.map((w) => (
                      <span key={w.id} className="chip chip-wait">
                        {w.code} · 晚到一步
                        <button className="chip-x" title="退出候补" onClick={() => server.leaveWaitlist(w.id)}>×</button>
                      </span>
                    ))}
                  </div>
                );
              })}
              {state.stones
                .filter((s) => s.status === "queued" && s.queueWorkstationId === ws.id)
                .map((q) => (
                  <div key={q.id} className="wait-row">
                    <span className="wait-label">排队</span>
                    <span className="chip chip-queue">
                      {q.code} · 工位满员
                      <button className="chip-x" title="退出排队" onClick={() => server.leaveWaitlist(q.id)}>×</button>
                    </span>
                  </div>
                ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- 裸石卡片 ---------------- */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function StoneForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: Partial<StoneInput>;
  submitLabel: string;
  onSubmit: (v: StoneInput) => void;
}) {
  const [code, setCode] = useState(initial?.code ?? "ST-" + String(Math.floor(Math.random() * 9000) + 1000));
  const [kind, setKind] = useState(initial?.kind ?? "钻石");
  const [shape, setShape] = useState(initial?.shape ?? "圆形");
  const [weight, setWeight] = useState(String(initial?.weight ?? "0.50"));
  const [size, setSize] = useState(initial?.size ?? "");
  const [clarity, setClarity] = useState(initial?.clarity ?? "");
  const [color, setColor] = useState(initial?.color ?? "");
  const [cut, setCut] = useState(initial?.cut ?? "");
  const [orderNo, setOrderNo] = useState(initial?.orderNo ?? "DD-2026-" + String(Math.floor(Math.random() * 900) + 100));
  const [slot, setSlot] = useState(initial?.targetSlotId ?? "auto");
  const [owner, setOwner] = useState<Craftsman>(initial?.owner ?? "A");

  const submit = () => {
    const w = parseFloat(weight);
    if (!code.trim() || !orderNo.trim() || Number.isNaN(w) || w <= 0) return;
    onSubmit({
      code: code.trim(),
      kind,
      shape,
      weight: Math.round(w * 100) / 100,
      size: size.trim(),
      clarity: clarity.trim(),
      color: color.trim(),
      cut: cut.trim(),
      orderNo: orderNo.trim(),
      targetSlotId: slot,
      owner,
    });
  };

  return (
    <div className="form-grid">
      <Field label="宝石编号">
        <input value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
      <Field label="订单号（变更后租约失效重算）">
        <input value={orderNo} onChange={(e) => setOrderNo(e.target.value)} />
      </Field>
      <Field label="种类">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map((k) => <option key={k}>{k}</option>)}
        </select>
      </Field>
      <Field label="形状">
        <select value={shape} onChange={(e) => setShape(e.target.value)}>
          {SHAPES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </Field>
      <Field label="克拉重量 ct（变更后租约失效重算）">
        <input type="number" step="0.01" min="0.01" value={weight} onChange={(e) => setWeight(e.target.value)} />
      </Field>
      <Field label="尺寸">
        <input value={size} placeholder="如 6x4mm" onChange={(e) => setSize(e.target.value)} />
      </Field>
      <Field label="净度">
        <input value={clarity} placeholder="如 VS" onChange={(e) => setClarity(e.target.value)} />
      </Field>
      <Field label="颜色">
        <input value={color} placeholder="如 F" onChange={(e) => setColor(e.target.value)} />
      </Field>
      <Field label="切工">
        <input value={cut} placeholder="如 明亮式" onChange={(e) => setCut(e.target.value)} />
      </Field>
      <Field label="目标镶位">
        <select value={slot} onChange={(e) => setSlot(e.target.value)}>
          <option value="auto">自动分配（按石重）</option>
          {SLOTS.map((sl) => <option key={sl.id} value={sl.id}>{sl.name}</option>)}
        </select>
      </Field>
      <Field label="分拣师傅">
        <div className="owner-switch">
          <button className={owner === "A" ? "on" : ""} onClick={() => setOwner("A")}>师傅A</button>
          <button className={owner === "B" ? "on" : ""} onClick={() => setOwner("B")}>师傅B</button>
        </div>
      </Field>
      <div className="form-actions">
        <button className="primary" onClick={submit}>{submitLabel}</button>
      </div>
    </div>
  );
}

export function AddStoneForm() {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button className="primary add-toggle" onClick={() => setOpen(true)}>＋ 新增裸石分拣</button>
    );
  }
  return (
    <div className="add-form">
      <StoneForm
        submitLabel="提交分拣"
        onSubmit={(v) => {
          void server.addStone(v);
          setOpen(false);
        }}
      />
    </div>
  );
}

export function StoneCard({ stone }: { stone: Stone }) {
  const now = useNow();
  const [editing, setEditing] = useState(false);
  const slot = stone.lease ? SLOTS.find((sl) => sl.id === stone.lease!.slotId) : undefined;
  const posting = stone.postingId ? server.getState().postings.find((p) => p.id === stone.postingId) : undefined;

  return (
    <article className={`stone-card status-${stone.status}`}>
      <div className="stone-head">
        <div>
          <h3>
            {stone.code}
            <StoneBadge status={stone.status} />
          </h3>
          <p className="stone-sub">
            {stone.kind} · {stone.shape} · <b>{stone.weight}ct</b>
            {stone.size ? ` · ${stone.size}` : ""} · 订单 {stone.orderNo}
          </p>
        </div>
        <OwnerTag owner={stone.owner} />
      </div>

      <dl className="stone-meta">
        {stone.clarity && <div><dt>净度</dt><dd>{stone.clarity}</dd></div>}
        {stone.color && <div><dt>颜色</dt><dd>{stone.color}</dd></div>}
        {stone.cut && <div><dt>切工</dt><dd>{stone.cut}</dd></div>}
        <div><dt>目标镶位</dt><dd>{slot ? slot.name : stone.targetSlotId === "auto" ? "自动分配" : SLOTS.find((s) => s.id === stone.targetSlotId)?.name ?? "—"}</dd></div>
        {posting?.receiptNo && <div><dt>回执号</dt><dd>{posting.receiptNo}</dd></div>}
      </dl>

      {stone.status === "mismatch" && posting?.externalWeight !== undefined && (
        <div className="version-box">
          <div><span>本地版本</span><b>{stone.weight}ct · {fmtAmount(posting.insuredAmount)}</b></div>
          <div><span>台账回执</span><b>{posting.externalWeight}ct · {fmtAmount(posting.externalAmount ?? 0)}</b></div>
          <em>两版均保留，待与保险台账核对</em>
        </div>
      )}

      {stone.lease && (
        <div className="lease-inline">
          租约剩余 <b>{fmtCountdown(stone.lease.expiresAt, now)}</b>
          <div className="lease-bar"><i style={{ width: `${Math.max(0, ((stone.lease.expiresAt - now) / 45000) * 100)}%` }} /></div>
        </div>
      )}

      <div className="stone-actions">
        {stone.status === "draft" && <button className="primary" onClick={() => void server.submitPlacement(stone.id, stone.owner)}>提交占住</button>}
        {stone.status === "leased" && <>
          <button onClick={() => void server.renewLease(stone.id)}>续租</button>
          <button className="primary" onClick={() => void server.confirmPlacement(stone.id)}>确认交接</button>
          <button onClick={() => void server.releaseLease(stone.id)}>释放</button>
        </>}
        {stone.status === "waitlist" && <span className="hint">候补中：镶位空出后按先到先得自动补位</span>}
        {stone.status === "queued" && <span className="hint">排队中：工位空出后自动补位</span>}
        {stone.status === "confirmed" && <button className="primary" onClick={() => void server.postOne(stone.id)}>报保险台账</button>}
        {stone.status === "failed" && <button className="primary" onClick={() => void server.retryFailed(stone.id)}>重试本笔入账</button>}
        {stone.status === "reversed" && <span className="hint">冲正完成，新分录入账中…</span>}
        <button onClick={() => setEditing((e) => !e)}>{editing ? "收起编辑" : "编辑"}</button>
      </div>

      {editing && (
        <div className="stone-edit">
          <p className="edit-hint">
            改 <b>订单号 / 石重 / 目标镶位</b> → 占用与租约立即失效并重新分拣；
            已报账记录 → 自动冲正原分录并重报。
          </p>
          <StoneForm
            initial={{
              code: stone.code,
              kind: stone.kind,
              shape: stone.shape,
              weight: stone.weight,
              size: stone.size,
              clarity: stone.clarity,
              color: stone.color,
              cut: stone.cut,
              orderNo: stone.orderNo,
              targetSlotId: stone.targetSlotId,
              owner: stone.owner,
            }}
            submitLabel="保存并重新分拣"
            onSubmit={(v) => {
              void server.updateStone(stone.id, v);
              setEditing(false);
            }}
          />
        </div>
      )}
    </article>
  );
}

/* ---------------- 保险台账 ---------------- */

function Reconciliation({ state }: { state: DeskState }) {
  const effective = state.postings.filter(
    (p) => (p.status === "posted" || p.status === "mismatch") && !p.reverses,
  );
  const reversalEntries = state.postings.filter((p) => p.reverses);
  const reversalCount = reversalEntries.length;
  const failedCount = state.postings.filter((p) => p.status === "failed").length;
  const localWeight = effective.reduce((sum, p) => sum + p.weight, 0);
  const localAmount = effective.reduce((sum, p) => sum + p.insuredAmount, 0);
  const extWeight = effective.reduce((sum, p) => sum + (p.externalWeight ?? p.weight), 0);
  const extAmount = effective.reduce((sum, p) => sum + (p.externalAmount ?? p.insuredAmount), 0);
  const diffs = effective.filter((p) => p.status === "mismatch");

  return (
    <div className="recon">
      <div className="recon-grid">
        <div>
          <h4>本地分拣口径</h4>
          <p>{effective.length} 笔</p>
          <p>{localWeight.toFixed(2)} ct</p>
          <p>{fmtAmount(localAmount)}</p>
        </div>
        <div>
          <h4>保险台账口径</h4>
          <p>{effective.length} 笔</p>
          <p>{extWeight.toFixed(2)} ct</p>
          <p>{fmtAmount(extAmount)}</p>
        </div>
      </div>
      <div className="recon-flags">
        <span className="chip chip-wait">冲正 {reversalCount} 笔</span>
        {diffs.length > 0 && <span className="chip chip-mismatch">回执差异 {diffs.length} 笔（两版都留）</span>}
        {failedCount > 0 && <span className="chip chip-failed">失败待重试 {failedCount} 笔</span>}
      </div>
      {diffs.length > 0 && (
        <ul className="diff-list">
          {diffs.map((p) => {
            const stone = state.stones.find((s) => s.id === p.stoneId);
            return (
              <li key={p.id}>
                <b>{stone?.code ?? p.stoneId}</b>
                <span>本地 {p.weight}ct / {fmtAmount(p.insuredAmount)}</span>
                <span>台账 {p.externalWeight}ct / {fmtAmount(p.externalAmount ?? 0)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function LedgerPanel({ state }: { state: DeskState }) {
  const failedCount = state.postings.filter((p) => p.status === "failed").length;
  return (
    <section className="panel ledger-panel">
      <div className="heading">
        <div>
          <p>保险台账</p>
          <h2>分拣结果对账</h2>
        </div>
        {failedCount > 0 && (
          <button className="primary" onClick={() => void server.retryFailed()}>全部重试（{failedCount}）</button>
        )}
      </div>
      <Reconciliation state={state} />
      <div className="posting-list">
        {state.postings.length === 0 && <p className="empty">暂无台账分录</p>}
        {state.postings.map((p) => {
          const stone = state.stones.find((s) => s.id === p.stoneId);
          return (
            <article key={p.id} className={`posting status-${p.status}`}>
              <div className="posting-head">
                <b>{stone?.code ?? "—"}</b>
                <PostingBadge status={p.status} />
                {p.reverses && <span className="chip chip-reversal">红冲</span>}
              </div>
              <p className="posting-line">
                订单 {p.orderNo} · {p.weight}ct · {fmtAmount(p.insuredAmount)}
                {p.externalWeight !== undefined && <> · 回执 {p.externalWeight}ct / {fmtAmount(p.externalAmount ?? 0)}</>}
              </p>
              {p.note && <p className="posting-note">{p.note}</p>}
              <div className="posting-foot">
                <span>{new Date(p.createdAt).toLocaleTimeString("zh-CN")}</span>
                {p.receiptNo && <span>{p.receiptNo}</span>}
                {p.status === "failed" && (
                  <button className="mini" onClick={() => void server.retryFailed(p.stoneId)}>只重试本笔</button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/* ---------------- 活动流 ---------------- */

export function FeedPanel({ feed }: { feed: FeedEntry[] }) {
  return (
    <section className="panel feed-panel">
      <div className="heading">
        <div>
          <p>活动流</p>
          <h2>租约 · 冲突 · 台账</h2>
        </div>
      </div>
      <ul className="feed-list">
        {feed.length === 0 && <p className="empty">暂无活动</p>}
        {feed.map((f) => (
          <li key={f.id} className={FEED_CLS[f.kind]}>
            <span className="feed-time">{new Date(f.at).toLocaleTimeString("zh-CN")}</span>
            <span>{f.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
