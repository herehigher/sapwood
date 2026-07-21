# Dashboard 成品预期图 — 出图提示词 v1

本地工作文件，不提交。用途：喂给 codex 生成 sapwood dashboard 成品预期图，
进入「出图 → 用户+PM 审评 → 改提示词」循环。每轮迭代在文末追加变更记录。

## 设计裁决（PM + 前端专家 Fable，2026-07-19）

- **T1 侧边栏**：采纳 2/4.png 的左侧栏，但降级为**纯 chrome 的窄图标栏**（~56px：
  wordmark、锚点/模式入口、底部 config 齿轮）——不引入路由，不动规格的
  "single page, five modules" 锁定项。红线：栏目一旦变成真实路由页面，就是
  §2 范围修订，须先改 `docs/frontend-design.md`。
- **T2 亮色主题**：渲染**浅苗木绿**（#EEF3E6），不用 3.png 的奶油色。奶油色在
  07-16 修订中被明确否决，且整套亮色 token（teal-green 成功色、加深的琥珀）都是
  按绿底重推的；"春季"隐喻本身也更贴合嫩绿。若用户看到绿版后仍要奶油色，
  按 token 表修订流程走，不静默换。
- **T3 hero 几何**：闭环是锁定决策，但不必画成圆——画成**扁平跑道（stadium
  circuit）**：顶部薄相位弧（Planning → Design review → Approve），中部直道就是
  1.png 那条高密度左→右流水线（Backlog → 3 lanes → Checks → Review → 年轮），
  底部虚线回程（Summary → Retro）接回 Planning。1.png 的
  PRODUCERS / REVIEWERS / MERGERS 分区标注作为直道上方的次级小字保留。

## 出图要点（写提示词时遵守）

- 钉死：画幅比例、每个关心的 hex（附口语描述）、按阅读顺序逐区块布局+比例、
  年轮签名的几何描述、字体**处理方式**（不写字体名）、必须可读的字符串清单+数量。
- 放开：图标形状、微间距、纹理、条形图精确几何。
- 失败模式规避：文字必然乱码 → 压缩文字面、必读字符串重复强调、其余允许模糊
  占位；别说 "chart" → 直接描述条形；模型爱画线性流水线 → 用"三条上下带、两端
  相连"描述跑道；防止漂移成纯黑+霓虹 → 底色说两遍+负面清单；一句话一个概念；
  关键约束放前 1/3；跑 4+ seed，产出只当布局/氛围参考，不当文字来源。

---

## PROMPT — dark "autumn" theme（主题版本 A）

High-fidelity desktop dashboard UI mockup, 16:10 landscape, flat modern web app design, crisp vector look, no browser chrome, no perspective, no photograph. Calm, dense, data-rich monitoring tool named "sapwood".

PALETTE (autumn, warm): background warm dark brown #251B10 — NOT black; panels slightly lighter brown #2E2317 with hairline 1px borders #8A7A64; primary text warm cream #F1E7D2; amber #E8A33D for activity; muted moss green #8FA36B for success; rust orange #C05A2E for warnings. No neon blue, no purple, no gradients, no glow, no glassmorphism, no shadows.

TYPE: wordmark and one big number in an elegant warm serif; all data in small monospace; labels tiny uppercase letterspaced. Only these strings must be legible: "sapwood", "round 12", "running", "#94", "PR #99", "PR #101", "24", "$10.4", "$100", "w1", "w2", "w3". All other text may be soft unreadable placeholder lines.

LAYOUT, top to bottom: (1) Slim left icon rail, full height, ~4% width: serif wordmark "sapwood" at top, four small line icons below, gear icon at bottom. (2) Header bar: green dot + word "running" + "round 12", a thin horizontal budget meter — solid amber segment ($10.4 settled) then a short translucent hatched amber tail ($2.2 est) against the $100 track — and a "Live / Replay" pill toggle. (3) A single thin rust-orange alert strip: "PR #99 needs a human decision". (4) HERO, ~35% of height: the pipeline drawn as one closed racetrack circuit in thin amber lines on the dark ground — a shallow arc across the top with three small nodes labeled PLAN, DESIGN REVIEW, APPROVE; a dense straightaway through the middle flowing left to right: a stack of small cards (backlog) → three horizontal lane channels labeled w1 w2 w3 with tiny amber droplet dots ("#94" riding lane w1) → two gate checkpoints labeled CHECKS and REVIEW → ending in a large tree-trunk cross-section drawn as ~24 fine concentric growth rings in faded amber-brown, the outermost ring glowing amber, big serif number "24" beside it; a dashed thin return line along the bottom, right to left, through two small nodes (SUMMARY, RETRO), reconnecting up to the top arc. Small uppercase zone captions above the straightaway: PRODUCERS, REVIEWERS, MERGERS. (5) Below, two panels side by side: left, three lane cards (w1 "#94" writing, amber dot; w2 "PR #99" rust dot; w3 empty outlined) with tiny monospace cost figures; right, an activity feed of 5 short lines with colored dots, top line green "Merged PR #101". (6) Bottom cost strip: two small groups of short solid amber horizontal bars of decreasing length (captioned BY PHASE and BY MODEL), one bar with a lighter translucent tail.

Mood: autumn heartwood, warm firelit browns, quiet precision. Signature moment: the growth rings.

## PROMPT — light "spring" variant（主题版本 B，同布局，仅换调色）

Same layout, spring "sapwood" theme: background milky pale green #EEF3E6, panels one step greener #E2EAD4, primary text dark heartwood brown #251B10, hairlines #8A7A64, accent amber deepened to #8A5A14, success a deep teal-green #3E6B4F, warnings #A34620. Mood: early spring, fresh sapwood, paper-bright but green — NOT cream, NOT white. Rings drawn in soft brown on the pale green ground.

---

## 审评清单（每轮出图后对照）

1. 底色是暖棕/浅绿，没有漂成纯黑或奶油白？
2. hero 是闭合跑道（顶弧+中直道+底部虚线回程），不是纯线性流水线？
3. 年轮出现且是画面唯一的"高光时刻"？"24" 用衬线大字？
4. est 段是半透明/斜纹，与实付实心段区分？
5. 三分区标注（PRODUCERS/REVIEWERS/MERGERS）是次级小字，未压过平实语言标签？
6. 侧栏是窄图标栏，没长成带文字的路由导航？
7. 必读字符串大致可辨？（其余乱码可接受，成图仅作布局/氛围参考）

## 变更记录

- v1（2026-07-19）：初版。裁决 T1 窄图标栏 / T2 浅苗木绿 / T3 跑道式闭环；
  PM 修订：必读字符串补 "round 12"/"running"；成本条明确为 BY PHASE + BY MODEL
  两组（对齐规格 §3 E）。
