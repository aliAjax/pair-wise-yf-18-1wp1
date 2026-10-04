import { useEffect, useMemo, useReducer, useState } from "react";
import "./styles.css";
import { server, LEASE_TTL_MS, SEATS } from "./demo/store";
import type { Lease, OutboxItem, Stone, WaitEntry } from "./demo/types";

// ── 订阅 store：命令串行、状态快照驱动渲染 ──
function useServer() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => server.subscribe(force), []);
  useEffect(() => {
    const t = setInterval(() => {
      server.tick();
      force();
    }, 500);
    return () => clearInterval(t);
  }, []);
  return server.state;
}

const fmtTime = (t: number) =>
  new Date(t).toLocaleTimeString("zh-CN", { hour12: false });

const stageLabel: Record<Stone["stage"], string> = {
  idle: "待分拣",
  queued: "工位排队",
  held: "占住镶位",
  waitlisted: "候补",
  done: "已分拣",
  superseded: "已作废",
};

const stageClass: Record<Stone["stage"], string> = {
  idle: "st-idle",
  queued: "st-queued",
  held: "st-held",
  waitlisted: "st-wait",
  done: "st-done",
  superseded: "st-sup",
};

function App() {
  const state = useServer();
  const busy = server.isBusy();
  const [resumeNote, setResumeNote] = useState<string | null>(server.resumedNote);
  const [amendFor, setAmendFor] = useState<string | null>(null);

  const now = Date.now();
  const leases = Object.values(state.leases);
  const pendingCount = state.outbox.filter((o) => o.status === "pending").length;
  const mismatchItems = state.outbox.filter((o) => o.status === "mismatch");

  // 按订单分组
  const orders = useMemo(() => {
    const map = new Map<string, Stone[]>();
    Object.values(state.stones).forEach((s) => {
      const arr = map.get(s.orderNo) ?? [];
      arr.push(s);
      map.set(s.orderNo, arr);
    });
    return [...map.entries()].map(([orderNo, stones]) => ({ orderNo, stones }));
  }, [state.stones]);

  const waitFor = (stoneId: string) => state.waitlist.find((w) => w.stoneId === stoneId);

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62006 · 可续作对账台 · Port 62006</p>
        <h1>珠宝镶嵌 · 裸石镶位租约对账台</h1>
        <span>
          裸石持 <b>TTL 租约 + fencing token</b> 占镶位；两位师傅同交一位只放行先到者，晚到进候补并留冲突现场；
          订单号/石重指纹一变，占用与租约立即失效重算；工位容量满则 FIFO 排队；分拣结果走保险 outbox
          对账——本地再改先冲正再重报，回执对不上两版都留；写入失败只重投未入账报文，刷新页面自动续作。
        </span>
      </section>

      {resumeNote && (
        <div className="resume-banner">
          <span>🔄 {resumeNote}</span>
          <button onClick={() => setResumeNote(null)}>知道了</button>
        </div>
      )}

      <section className="metrics">
        <article>
          <small>生效租约 / 镶位</small>
          <strong>
            {leases.length}<em>/{SEATS.length}</em>
          </strong>
        </article>
        <article>
          <small>工位占用 / 容量</small>
          <strong>
            {state.stations.assignments.length}<em>/{state.stations.capacity}</em>
          </strong>
        </article>
        <article>
          <small>排队 · 候补</small>
          <strong>
            {state.queue.length}<em> · {state.waitlist.length}</em>
          </strong>
        </article>
        <article>
          <small>未入账 / 回执不符</small>
          <strong className={mismatchItems.length ? "danger" : ""}>
            {pendingCount}<em> / {mismatchItems.length}</em>
          </strong>
        </article>
      </section>

      <section className="workspace">
        {/* 左：裸石与订单 */}
        <div className="panel stones-panel">
          <div className="heading">
            <div>
              <p>按订单查看</p>
              <h2>裸石清单与提交</h2>
            </div>
            <button className="ghost" onClick={() => server.reset()}>重置演示</button>
          </div>

          <div className="dual-test">
            <div>
              <b>并发场景：</b>两位师傅同时提交中央主石位（ST-2048 蓝宝石 vs ST-2099 红宝石）
            </div>
            <div className="dual-btns">
              <button className="primary" disabled={busy} onClick={() => dualRace()}>
                ⚔ 双师傅同交一位
              </button>
            </div>
          </div>

          {orders.map(({ orderNo, stones }) => (
            <div key={orderNo} className="order-block">
              <h3>
                订单 {orderNo}
                <span>{stones.length} 颗</span>
              </h3>
              <div className="stone-list">
                {stones.map((stone) => (
                  <StoneCard
                    key={stone.id}
                    stone={stone}
                    wait={waitFor(stone.id)}
                    lease={leases.find((l) => l.stoneId === stone.id)}
                    now={now}
                    amending={amendFor === stone.id}
                    busy={busy}
                    onAmend={() => setAmendFor(amendFor === stone.id ? null : stone.id)}
                    onCloseAmend={() => setAmendFor(null)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* 右：镶位图 + 工位 */}
        <div className="right-col">
          <section className="panel">
            <div className="heading">
              <div>
                <p>镶嵌位置示意图</p>
                <h2>戒指镶位租约图</h2>
              </div>
              <span className="ttl-tag">租约 TTL {Math.round(LEASE_TTL_MS / 1000)}s</span>
            </div>
            <RingMap now={now} />
          </section>

          <section className="panel station-panel">
            <div className="heading">
              <div>
                <p>工位容量信号量</p>
                <h2>
                  {state.stations.assignments.length}/{state.stations.capacity} 占用
                </h2>
              </div>
            </div>
            <div className="station-slots">
              {Array.from({ length: state.stations.capacity }).map((_, i) => {
                const a = state.stations.assignments[i];
                const stone = a && state.stones[a.stoneId];
                return (
                  <div key={i} className={`slot ${a ? "filled" : ""}`}>
                    {a && stone ? (
                      <>
                        <b>{stone.id}</b>
                        <span>{a.seatId}</span>
                        <small>师傅{leases.find((l) => l.leaseId === a.leaseId)?.master ?? "?"}</small>
                      </>
                    ) : (
                      <span className="empty-slot">空工位</span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="queue-list">
              <p>FIFO 队列</p>
              {state.queue.length === 0 && <small className="muted">暂无排队，容量满后新提交进队</small>}
              {state.queue.map((q, i) => (
                <div key={q.id} className="queue-chip">
                  <b>#{i + 1}</b> {state.stones[q.stoneId]?.id}
                  <span>{state.stones[q.stoneId]?.targetSeat}</span>
                  <small>师傅{q.master}</small>
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>

      {/* 候补冲突 */}
      <section className="panel wait-panel">
        <div className="heading">
          <div>
            <p>晚到候补 · 冲突留底</p>
            <h2>候补名单（看到与谁冲突）</h2>
          </div>
        </div>
        {state.waitlist.length === 0 ? (
          <p className="muted">没有候补。点上面「双师傅同交一位」可制造一个冲突现场。</p>
        ) : (
          <div className="wait-grid">
            {state.waitlist.map((w) => {
              const holderLease = state.leases[w.seatId];
              const holderStill = holderLease && holderLease.leaseId === w.conflictLeaseId;
              return (
                <article key={w.id} className="wait-card">
                  <div>
                    <b>{w.stoneId}</b>（师傅{w.master}）想占 <b>{w.seatId}</b>
                  </div>
                  <div className="conflict-line">
                    ⛔ 已被 <b>{w.conflictStoneId}</b>（师傅{w.conflictMaster}，租约 {w.conflictLeaseId}，fencing{" "}
                    {state.leaseHistory.find((l) => l.leaseId === w.conflictLeaseId)?.fencing ??
                      holderLease?.fencing ??
                      "?"}
                    ）先租
                  </div>
                  <div className="wait-meta">
                    迟到 {w.at - w.holderSince >= 0 ? `${w.at - w.holderSince}ms` : "—"} · 提交于 {fmtTime(w.at)}
                  </div>
                  <div className="wait-actions">
                    <button
                      disabled={busy || holderStill}
                      title={holderStill ? "镶位仍被占，先等持位方完工或租约到期" : "镶位已空，可补位"}
                      onClick={() => server.retryWait(w.id)}
                    >
                      {holderStill ? "等持位方释放…" : "补位重交"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* 保险台账 */}
      <section className="panel ledger-panel">
        <div className="heading">
          <div>
            <p>保险台账 · outbox 对账</p>
            <h2>分拣结果报送（冲正 / 重报 / 双版留底）</h2>
          </div>
          <div className="ledger-controls">
            <label className="switch">
              <input
                type="checkbox"
                checked={state.settings.flaky}
                onChange={(e) => server.setSetting("flaky", e.target.checked)}
              />
              注入网络故障（写入失败）
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={state.settings.mismatchOnce}
                onChange={(e) => server.setSetting("mismatchOnce", e.target.checked)}
              />
              下次回执对不上
            </label>
            <button className="primary" disabled={busy || pendingCount === 0} onClick={() => server.flushOutbox()}>
              重投未入账（{pendingCount}）
            </button>
          </div>
        </div>
        <div className="outbox-list">
          {state.outbox.length === 0 && <p className="muted">台账为空，先完成一颗已持租约的裸石。</p>}
          {state.outbox.map((item) => (
            <OutboxRow key={item.key} item={item} busy={busy} />
          ))}
        </div>
      </section>

      {/* 事件台账 */}
      <section className="panel journal-panel">
        <div className="heading">
          <div>
            <p>事件溯源台账</p>
            <h2>租约 / 冲突 / 冲正 全留痕</h2>
          </div>
        </div>
        <div className="journal">
          {state.ledger.slice(0, 40).map((l) => (
            <div key={l.seq} className={`log-line tone-${l.tone}`}>
              <time>{fmtTime(l.at)}</time>
              <span>{l.text}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );

  // 双师傅并发：两个请求几乎同时进命令队列，先入队者立约，后者进候补
  function dualRace() {
    void server.submitStone("ST-2048", "A");
    setTimeout(() => void server.submitStone("ST-2099", "B"), 120);
  }
}

// ─────────────────────── 裸石卡 ───────────────────────

function StoneCard(props: {
  stone: Stone;
  wait?: WaitEntry;
  lease?: Lease;
  now: number;
  amending: boolean;
  busy: boolean;
  onAmend: () => void;
  onCloseAmend: () => void;
}) {
  const { stone, wait, now, amending } = props;
  const [orderNo, setOrderNo] = useState(stone.orderNo);
  const [weight, setWeight] = useState(String(stone.weightCt));
  useEffect(() => {
    setOrderNo(stone.orderNo);
    setWeight(String(stone.weightCt));
  }, [stone.orderNo, stone.weightCt, stone.version]);

  const remaining = props.lease ? Math.max(0, props.lease.expiresAt - now) : 0;
  const pct = props.lease ? Math.max(0, Math.min(1, remaining / LEASE_TTL_MS)) : 0;

  return (
    <article className={`stone-card ${stageClass[stone.stage]}`}>
      <div className="stone-head">
        <b>{stone.id}</b>
        <span className={`stage-tag ${stageClass[stone.stage]}`}>{stageLabel[stone.stage]}</span>
        <em className="ver">v{stone.version}</em>
      </div>
      <p className="stone-meta">
        {stone.kind} · {stone.shape} · <b>{stone.weightCt}ct</b> · 目标 {stone.targetSeat}
      </p>
      {stone.note && <p className="note">📝 {stone.note}</p>}

      {stone.stage === "held" && props.lease && (
        <div className="lease-box">
          <div>
            租约 {props.lease.leaseId} · fencing <b>{props.lease.fencing}</b> · 指纹
            <code>{stone.fingerprint}</code>
          </div>
          <div className="lease-bar">
            <i style={{ width: `${pct * 100}%` }} />
          </div>
          <small>
            剩 {(remaining / 1000).toFixed(1)}s · 师傅{props.lease.master} · 到期自动释放
          </small>
        </div>
      )}

      {stone.stage === "waitlisted" && wait && (
        <div className="conflict-hint">
          ⛔ 与 <b>{wait.conflictStoneId}</b>（师傅{wait.conflictMaster}）争 {wait.seatId}，我方晚到 → 候补
        </div>
      )}

      <div className="stone-actions">
        <button
          className="primary sm"
          disabled={props.busy || stone.stage === "held" || stone.stage === "queued" || stone.stage === "done"}
          title="师傅A提交占镶位"
          onClick={() => server.submitStone(stone.id, "A")}
        >
          师傅A 提交
        </button>
        <button
          className="sm"
          disabled={props.busy || stone.stage === "held" || stone.stage === "queued" || stone.stage === "done"}
          title="师傅B提交占镶位"
          onClick={() => server.submitStone(stone.id, "B")}
        >
          师傅B 提交
        </button>
        <button
          className="sm good"
          disabled={props.busy || stone.stage !== "held"}
          title="持租约才能报完成"
          onClick={() => server.complete(stone.id)}
        >
          完成分拣
        </button>
        <button className="sm ghost" onClick={props.onAmend}>
          改单
        </button>
      </div>

      {amending && (
        <div className="amend-box">
          <p>改订单号或石重 → 租约/占用立即失效重算，已入账保险先冲正</p>
          <label>
            <span>订单号</span>
            <input value={orderNo} onChange={(e) => setOrderNo(e.target.value)} />
          </label>
          <label>
            <span>石重 ct</span>
            <input value={weight} onChange={(e) => setWeight(e.target.value)} inputMode="decimal" />
          </label>
          <div className="amend-actions">
            <button
              className="primary sm"
              disabled={props.busy || !Number(weight)}
              onClick={() => {
                void server.amendStone(stone.id, orderNo, Number(weight)).then((r) => {
                  if (r.ok) props.onCloseAmend();
                });
              }}
            >
              确认改单重算
            </button>
            <button className="sm ghost" onClick={props.onCloseAmend}>
              取消
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

// ─────────────────────── 戒指镶位图 ───────────────────────

function RingMap({ now }: { now: number }) {
  const size = 320;
  const c = size / 2;
  return (
    <div className="ring-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={c} cy={c} r={148} fill="none" stroke="#d9e2ef" strokeWidth={2} />
        <circle cx={c} cy={c} r={70} fill="none" stroke="#e2e8f0" strokeWidth={1.5} strokeDasharray="4 5" />
        {SEATS.map((seat) => {
          const rad = (seat.angle * Math.PI) / 180;
          const x = c + seat.radius * Math.cos(rad);
          const y = c + seat.radius * Math.sin(rad);
          return <RingSeat key={seat.id} seat={seat} x={x} y={y} now={now} />;
        })}
      </svg>
    </div>
  );
}

function RingSeat({ seat, x, y, now }: { seat: (typeof SEATS)[number]; x: number; y: number; now: number }) {
  const state = server.state;
  const lease = state.leases[seat.id];
  const stone = lease && state.stones[lease.stoneId];
  const remaining = lease ? Math.max(0, lease.expiresAt - now) : 0;
  const pct = lease ? remaining / LEASE_TTL_MS : 0;
  return (
    <g transform={`translate(${x} ${y})`} className={`ring-seat ${lease ? "occupied" : ""}`}>
      <circle r={seat.radius === 0 ? 42 : 28} fill={lease ? "#be123c" : "#ffffff"} stroke={lease ? "#881337" : "#94a3b8"} strokeWidth={lease ? 3 : 1.5} />
      {lease ? (
        <>
          <text textAnchor="middle" y={-4} fontSize={11} fill="#fff" fontWeight={700}>
            {stone?.id}
          </text>
          <text textAnchor="middle" y={11} fontSize={10} fill="#fecdd3">
            师傅{lease.master} · {(remaining / 1000).toFixed(0)}s
          </text>
          <circle
            r={seat.radius === 0 ? 48 : 34}
            fill="none"
            stroke="#0f766e"
            strokeWidth={3}
            strokeDasharray={`${2 * Math.PI * (seat.radius === 0 ? 48 : 34) * pct} 999`}
            transform="rotate(-90)"
            opacity={0.85}
          />
        </>
      ) : (
        <text textAnchor="middle" y={4} fontSize={9} fill="#64748b">
          {seat.id}
        </text>
      )}
      <text textAnchor="middle" y={seat.radius === 0 ? 62 : 44} fontSize={9} fill="#94a3b8">
        {seat.label}
      </text>
    </g>
  );
}

// ─────────────────────── 台账行 ───────────────────────

function OutboxRow({ item, busy }: { item: OutboxItem; busy: boolean }) {
  return (
    <article className={`outbox-row st-${item.status}`}>
      <div className="outbox-top">
        <span className={`report-kind ${item.kind}`}>{item.kind === "reversal" ? "冲正" : "投保"}</span>
        <code>{item.key}</code>
        <span className={`status-pill ${item.status}`}>
          {item.status === "pending" && "未入账 pending"}
          {item.status === "confirmed" && "已入账 ✓"}
          {item.status === "mismatch" && "回执不符 ✱ 双版留底"}
        </span>
        <span className="attempts">尝试 {item.attempts} 次</span>
      </div>

      {item.note && <p className="rev-note">📋 {item.note}</p>}

      <div className="versions">
        <div className="ver-col local">
          <small>本地版</small>
          <p>
            {item.local.orderNo} · {item.local.weightCt}ct · {item.local.seatId}
          </p>
          <code>{item.local.fingerprint}</code>
        </div>
        <div className="ver-arrow">→</div>
        <div className={`ver-col ext ${item.status === "mismatch" ? "bad" : ""}`}>
          <small>回执版</small>
          {item.receipt ? (
            <>
              <p>
                {item.receipt.echoOrderNo} · {item.receipt.echoWeightCt}ct
              </p>
              <code>
                {item.receipt.no} · {fmtTime(item.receipt.at)}
              </code>
            </>
          ) : (
            <p className="muted">尚无回执</p>
          )}
        </div>
      </div>

      {item.status === "pending" && item.lastError && <p className="err-line">✗ {item.lastError}</p>}
      {item.status === "mismatch" && (
        <p className="err-line">
          ⚠ 两版指纹不同（本地 {item.local.fingerprint} / 回执 {item.external?.fingerprint}），均保留待人工对账，
          不覆盖、不重投；改单会另挂冲正。
        </p>
      )}
      <div className="outbox-foot">
        <small className="muted">创建 {fmtTime(item.createdAt)} · {item.postedAt ? `入账尝试 ${fmtTime(item.postedAt)}` : "尚未发出"}</small>
        {item.status === "pending" && (
          <button className="sm primary" disabled={busy} onClick={() => server.flushOutbox(item.key)}>
            只重投此份
          </button>
        )}
      </div>
    </article>
  );
}

export default App;
