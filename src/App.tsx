import { useSyncExternalStore } from "react";
import { server } from "./server";
import { AddStoneForm, FeedPanel, LedgerPanel, StoneCard, WorkstationBoard } from "./components";

function useDesk() {
  return useSyncExternalStore(server.subscribe, server.getState);
}

function Metric({ label, value, accent }: { label: string; value: number | string; accent: string }) {
  return (
    <article className={accent}>
      <small>{label}</small>
      <strong>{value}</strong>
    </article>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="toggle-dot" />
      {label}
    </button>
  );
}

export default function App() {
  const state = useDesk();
  const count = {
    total: state.stones.length,
    leased: state.stones.filter((s) => s.status === "leased").length,
    waiting: state.stones.filter((s) => s.status === "waitlist" || s.status === "queued").length,
    confirmed: state.stones.filter((s) => s.status === "confirmed").length,
    posted: state.stones.filter((s) => s.status === "posted" || s.status === "mismatch").length,
    failed: state.stones.filter((s) => s.status === "failed").length,
  };

  return (
    <main className="app">
      <section className="hero">
        <div className="hero-top">
          <div>
            <p>珠宝镶嵌 · 裸石分拣对账台</p>
            <h1>占住镶位，带租约对账</h1>
            <span>
              裸石占住镶位并带租约；两个师傅同时提交同一镶位只放行先到的，晚到的进候补并看到冲突；
              订单号或石重一变，占用与租约立即失效重算；工位容量满了就排队。
              分拣结果报保险台账对账，本地改动冲正重报，外部回执对不上两版都留，写入失败留住已确认的、只重试没入账的。
              状态自动持久化，刷新页面即可续作。
            </span>
          </div>
          <div className="hero-actions">
            <button className="primary" onClick={() => void server.runConcurrentDemo()}>
              并发演示：双师傅抢同一镶位
            </button>
            <button onClick={() => void server.postAll()}>全部报账</button>
            <button onClick={() => { if (confirm("清空当前台面并重置为演示数据？")) server.reset(); }}>
              重置演示
            </button>
          </div>
        </div>
        <div className="hero-toggles">
          <Toggle
            label="模拟台账写入失败（留住已确认，只重试未入账）"
            checked={state.toggles.failWrite}
            onChange={(v) => server.setToggles({ failWrite: v })}
          />
          <Toggle
            label="模拟外部回执与本地不符（两版都留）"
            checked={state.toggles.badReceipt}
            onChange={(v) => server.setToggles({ badReceipt: v })}
          />
          <span className="save-state">
            {state.resumedAt
              ? `已续作 · 上次保存 ${new Date(state.savedAt).toLocaleTimeString("zh-CN")}`
              : `已自动保存 ${new Date(state.savedAt).toLocaleTimeString("zh-CN")}`}
          </span>
        </div>
        {state.resumedAt && (
          <div className="resume-banner">
            续作成功：已恢复 {state.stones.length} 笔裸石记录、{state.postings.length} 条台账分录；
            过期租约已释放，在途未确认分录已标记待重试。
          </div>
        )}
      </section>

      <section className="metrics">
        <Metric label="裸石总数" value={count.total} accent="accent-rose" />
        <Metric label="有效租约" value={count.leased} accent="accent-teal" />
        <Metric label="候补 / 排队" value={count.waiting} accent="accent-purple" />
        <Metric label="已确认待报账" value={count.confirmed} accent="accent-rose" />
        <Metric label="已入账 / 差异" value={count.posted} accent="accent-teal" />
        <Metric label="失败待重试" value={count.failed} accent="accent-purple" />
      </section>

      <section className="desk">
        <div className="desk-main">
          <section className="panel">
            <div className="heading">
              <div>
                <p>镶位示意图</p>
                <h2>工位 · 租约 · 候补排队</h2>
              </div>
            </div>
            <WorkstationBoard state={state} />
          </section>

          <section className="panel">
            <div className="heading">
              <div>
                <p>裸石台账</p>
                <h2>分拣单（{state.stones.length}）</h2>
              </div>
              <AddStoneForm />
            </div>
            <div className="stone-list">
              {state.stones.map((s) => <StoneCard key={s.id} stone={s} />)}
            </div>
          </section>
        </div>

        <aside className="desk-side">
          <LedgerPanel state={state} />
          <FeedPanel feed={state.feed} />
        </aside>
      </section>
    </main>
  );
}
