import "./styles.css";

const project = {
  "sourceNo": 8,
  "id": "hxyfront-62006",
  "port": 62006,
  "title": "珠宝镶嵌宝石分拣",
  "domain": "珠宝镶嵌",
  "prompt": "我需要一个面向珠宝镶嵌工作室的宝石分拣前端系统，可以记录宝石编号、种类、形状、克拉重量、尺寸、净度、颜色、切工、镶嵌位置和分拣状态。页面需要有分拣批次、尺寸筛选、镶嵌位置示意图、缺陷备注和按订单查看的宝石清单。",
  "palette": [
    "#be123c",
    "#0f766e",
    "#a855f7"
  ],
  "metrics": [
    "分拣批次",
    "待镶嵌",
    "缺陷备注",
    "总克拉"
  ],
  "filters": [
    "圆形",
    "椭圆",
    "梨形",
    "祖母绿切"
  ],
  "fields": [
    "宝石编号",
    "种类",
    "形状",
    "克拉重量",
    "尺寸",
    "镶嵌位置"
  ],
  "records": [
    [
      "ST-2048",
      "蓝宝石",
      "椭圆6x4mm",
      "主石位"
    ],
    [
      "ST-2061",
      "钻石",
      "圆形0.08ct",
      "围石A组"
    ],
    [
      "ST-2099",
      "祖母绿",
      "内含物明显",
      "需客户确认"
    ]
  ]
};

function App() {
  return (
    <main className="app">
      <section className="hero">
        <p>{project.id} · 源提示词{project.sourceNo} · Port {project.port}</p>
        <h1>{project.title}</h1>
        <span>{project.prompt}</span>
      </section>

      <section className="metrics">
        {project.metrics.map((metric: string, index: number) => (
          <article key={metric}>
            <small>{metric}</small>
            <strong>{[86, 14, 7, 32][index] ?? 12}</strong>
          </article>
        ))}
      </section>

      <section className="workspace">
        <aside className="panel">
          <h2>{project.domain}筛选</h2>
          <div className="chips">
            {project.filters.map((item: string) => (
              <button key={item}>{item}</button>
            ))}
          </div>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>专业字段</p>
              <h2>新增记录</h2>
            </div>
            <button className="primary">保存草稿</button>
          </div>
          <div className="field-grid">
            {project.fields.map((field: string) => (
              <label key={field}>
                <span>{field}</span>
                <input placeholder={"填写" + field} />
              </label>
            ))}
          </div>
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>历史记录</p>
            <h2>近期工作台</h2>
          </div>
          <button>导出摘要</button>
        </div>
        <div className="records">
          {project.records.map((record: string[], index: number) => (
            <article key={record.join("-")}>
              <b>{String(index + 1).padStart(2, "0")}</b>
              <div>
                <h3>{record[0]}</h3>
                <p>{record.slice(1).join(" · ")}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;
