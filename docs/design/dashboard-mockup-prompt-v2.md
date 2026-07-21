# Dashboard 成品预期图 — v2（部件分解阶段）

部件流：hero（冻结·26 号图）→ header（冻结·32 号图）→ lanes（冻结·37 号图）
→ cost strip（冻结·40 号图）→ needs-attention strip（冻结·41 号图+42 重chip 嫁接）。
**mockup 阶段就此收官（用户裁决 2026-07-21）**：activity feed / config
drawer / 侧栏 rail 不再出图，按 §3 既有规格直接实施（feed 的定性已钉死：
strip=还开着的事的队列，feed=发生过的事的日志）；整页融合也不出图，
以六件冻结基线 + frontend-design.md 为实施依据。

**冻结基线图索引（docs/design/mockup/）**：
hero-panel-dark/light.png（26 号）· header-dark/light.png（32 号）·
lanes-dark/light.png（37 号）· cost-dark.png（40 号）·
needs-attention-dark.png（41 号；v6.1 提示词含 42 重 chip 嫁接与
seen 半透明修正，作为实施注记，未再出图）。

设计阶段工作档案（随 PR 入库）。v1（整页提示词轮）已删除——其裁决全部
被本文件与 frontend-design.md 第三修订吸收，唯一存留价值的出图方法论
移至文末附录。流程 = 分部件设计 → 逐件出图评审 → 冻结。

## Round-1 审评落定（用户裁决，2026-07-20）

1. **亮色主题**：以 3.png 奶油色为基准，色调向浅苗木绿方向**微调一点点**
   （用户看过纯绿版后的裁决；后续实施时按 token 表修订流程更新
   `docs/frontend-design.md` 亮色值并重跑 AA 检查）。
2. **hero 几何**：不执着相位弧/跑道形式——只要优雅、完整地表现工作流与
   当前流程状态即可。
3. **命名禁令**：页面不得出现 gate⓪/gate①/gate② 及同类内部编号，
   一律用白话（下表）。
4. **术语原则（2026-07-21 用户澄清）**："不用专业词汇"指的是不用
   **项目内约定俗成**的词（gate⓪、harvest、retro、reclaim…）；
   **行业标准词汇是首选**，词要能看出实际执行内容。据此规划三节点
   定名：GOAL PLAN & ALIGN / ARCH PLAN & REVIEW / VERIFY PLAN &
   APPROVAL（实施时同步修订 frontend-design.md §7 标签表 + copy.ts）。

## Hero board 元素清单（PM + 架构师 + 架空用户三方合成，2026-07-21）

设计总纲（三方共识）：
- **只有真实事件驱动动画**——活着 vs 屏保必须可区分（操作者第 2 问）。
- 治理分离（producer ≠ reviewer ≠ merger）用**几何**表达，不靠文字标注；
  标注降级为 hover + 图例。
- hero 上无正文文本：数字、状态词、玻片(chip)；一切细节进 inspector 抽屉
  或下方面板。
- 花费不上 hero（留在 header spend meter）。

### ① Backlog（起点，无细节）
| 元素 | 内容 | 数据依据 |
|---|---|---|
| Backlog 计数徽章 | "N ready"，点击跳 GitHub board | live-only（外部状态），replay 变灰 |
| 本轮选池 | 本轮实际选入的 issue 编号玻片 | `pool-selected` 事件（可 replay，真实） |
| 出堆时刻 | droplet 离开 backlog 进入 lane | `dispatched` |

### ② Planning（三个真实相位节点，一组收拢）
| 节点（白话） | 内部相位 | 备注 |
|---|---|---|
| Planning | `aligning` | hover：决定本轮做什么并立为 issue |
| Design review | `architecting` | hover：开工前架构审查 |
| Plan approval | `plan_review` | hover：独立评审批准每个计划——**含验证计划**；"validation plan" 不是第三个串行节点，是计划内容（架构师核实） |

当前相位节点带**脉搏光标** + "last event Xs ago" 小字 = 活着/卡死指示
（架空用户第 2 需求）。"no plan, no dispatch" 规则作为 Planning 组的
hover/inspector 细节，demo 里可给一拍。

### ③ Round tasks — worker lanes（核心区，含修复回环）
| 元素 | 内容 | 数据依据 |
|---|---|---|
| N 条 lane 通道 | 数量随配置 | `lanes.max` |
| lane 状态玻片 | 一词一色：writing / checks+review 等待 / **fixing** / on hold / handed off / needs human / merged | `workers.state`（`fixing` 是 v19 真实持久化状态） |
| 关卡区 | 两个检查点 **Checks** 和 **Review** 并排，但 v0.2 只渲染**一个等待态**（per-gate 子进度未持久化，不造假动画） | `deriveGate` live 现算 |
| **打回箭头（回环的真形）** | 从关卡区**指回本 lane**：引擎真实形状是"过门→打回→worker 自己修→重新过门"，不是 pr↔ci↔review 三角互指。箭头带原因词：**review findings / checks failed / merge conflict** | `drive-fixup`（reason）、`fix-leg-started`（prescription） |
| **修复圈数计数** | "fix round n / cap" ——证明环真的转过（架空用户强需求） | `workers.fix_rounds` vs `lanes.prFixCap` |
| 回环出口 | ①绿 → Merge；②圈数用尽/无法起腿 → **出口到人**（指向 Needs-attention 条）；③软预算 → handed off（后续 `fix-leg-resumed` 续跑） | `merged` / `fix-rounds-capped` / `handoff` |
| 回环入口（人侧） | 人解锁 → 直接回 driving 重审 | `gated-reentry` |
| Merge → 年轮 | 签名时刻：droplet 成环，大衬线计数 | `merged` |

lane 并行错相（一条在 CI、一条在 review、一条在 fixing）是 demo 真实性
的证据——replay demo 选材时优先体现。

### ④ Report & reflection（收尾）
| 元素 | 内容 | 数据依据 |
|---|---|---|
| Round summary 节点 | `harvesting` 相位 | `rounds.phase` |
| Self-improvement 节点 | `retro` 相位；retro 提的 PR 单独一拍 | `retro-pr-opened/degraded` |
| **轮终局清单** | merged / carried / escalated 三数——一轮结束读作"结果"而非"动画停了" | `round_artifacts` 计数器 |

### 整板状态（覆盖层）
- 引擎态 `paused / standby / winding-down / stopped / park`：整板变暗 +
  状态词——区分"卡死（坏）"与"我暂停的（正常）"。
- Needs-attention 条承接一切"出口到人"；**空 = 不渲染**，空即可信。
- 人默认缺席于回环——demo 里人只出现一次（升级→解决→熄灭），
  以稀缺性戏剧化"人只在升级点"。

### 白话命名（新增节点，入 copy.ts 同一张表）
| 内部 | 板上白话 |
|---|---|
| `fixing` | Fixing |
| FIXABLE 打回 | Sent back to fix (round {n} of {cap}) + 原因词 |
| `fix-rounds-capped` | Fix attempts used up — needs a human |
| hold | On hold |
| `standby` | Waiting for work |
| park | Environment trouble — paused |

## 开放问题（已裁决，2026-07-21 用户确认）

1. **Backlog 语义**：✅ backlog = live 计数徽章 + 跳转链接；"本轮选池"
   （`pool-selected`，可 replay）作为真实主角。
2. **On hold 可见性**：✅ 预期图先画 On hold 状态（设计目标），实施时立
   引擎 issue 补 additive 事件。
3. （实施前置，非出图问题）`round-phase`/`run-started` 事件（#206）尚未
   落引擎——replay 相位点灯压在它上面，hero 实施前是硬前置。

---

## PROMPT — hero board 部件 · dark "autumn"（主版）

Wide horizontal dashboard component mockup, 21:9 landscape band, flat modern web app UI, crisp vector look, no browser chrome, no perspective, no photograph. This is ONE panel of a larger dashboard: the "hero board" showing an autonomous coding pipeline end to end.

PALETTE (autumn, warm): background warm dark brown #251B10 — NOT black; panel surfaces slightly lighter brown #2E2317; hairline 1px borders #8A7A64; primary text warm cream #F1E7D2; amber #E8A33D = activity in motion; muted moss green #8FA36B = success; rust orange #C05A2E = needs-a-human. No neon blue, no purple, no gradients, no glow, no glassmorphism, no shadows.

TYPE: one big number in an elegant warm serif; everything else tiny monospace and tiny uppercase letterspaced labels. Only these strings must be legible: "BACKLOG (7 READY)", "w1", "w2", "w3", "#94", "#97", "PR #99", "CI", "REVIEW", "FIXING", "round 2 of 3", "24", "GOAL & ALIGN", "ARCH REVIEW", "VERIFY", "NEEDS HUMAN", "SUMMARY", "RETRO". All other text may be soft unreadable placeholder lines. All three zone captions PLAN, IMPLEMENT, OUTCOME must appear along the top.

LAYOUT — four zones flowing left to right, connected by thin amber lines, with small uppercase zone captions along the top: PLAN (spanning the backlog and planning columns), IMPLEMENT (spanning the work lanes and the CI/REVIEW checkpoints), OUTCOME (over the rings). Exactly these three captions, no role words:

(1) BACKLOG, far left, NARROW — the same width as the planning column (~12%): title "BACKLOG (7 READY)" — the ready count lives in the title parenthesis, no separate badge, no stacked card pile. Below the title, one single column of small monospace issue-number chips: the three SELECTED for this round — #94, #97, #99 — are amber filled and grouped together at the TOP of the column, floated above the dim hairline-outlined candidate chips (#95 #96 #98 …). Selected block first, candidates below — the promotion must be obvious at a glance.

(2) PLANNING, ~12% width: three small circular nodes stacked vertically, each a neutral line icon INSIDE a hairline circle with its uppercase label OUTSIDE below the circle: GOAL & ALIGN, ARCH REVIEW, VERIFY; the active node has a soft amber pulse halo; a tiny caption under the group: "last event 14s ago".

(3) WORK LANES with the FIX LOOP, ~45% width — the centerpiece: three horizontal lane channels labeled w1 w2 w3, each in a visibly DIFFERENT state (parallel work, staggered): lane w1 carries an amber droplet dot tagged "#94" mid-channel (writing); lane w2 shows an AMBER droplet returned from the checkpoints via a thin amber RETURN ARROW that loops back from the checkpoint area into the lane — the return arrow carries a small label "review findings" and the lane shows a small chip "FIXING · round 2 of 3" (the fixing droplet is amber like all working droplets — rust orange is reserved EXCLUSIVELY for needs-a-human markers); lane w3's channel runs to the checkpoint area with no droplet on it (its PR has left the flow — see the escalation branch below). All three lanes converge rightward into TWO adjacent circular checkpoints styled EXACTLY like the planning column's nodes — a small neutral line icon INSIDE each hairline circle, the uppercase label OUTSIDE below the circle: left one labeled CI, right one labeled REVIEW; the pair sits slightly ABOVE the vertical center of the lane area. Identity icons only (a small gear for CI, an eye for REVIEW) — NEVER render pass/fail status on them, never one green and one red; together they are one calm waiting area, breathing softly.

THE ESCALATION BRANCH: from the short connector segment BETWEEN the CI and REVIEW circles, one solid channel grows DOWNWARD — drawn in exactly the same stroke style as the work lanes but in rust orange — dropping below the checkpoint pair and ending at a hairline circle with a small person icon inside, uppercase label "NEEDS HUMAN" outside below it. A rust droplet tagged "PR #99" is parked on this descending branch beside the person node. No dashed escalation arrow anywhere, no floating exclamation pins — this rust branch, its droplet, and its node are the ONLY rust elements in the whole image.

(4) RINGS & REFLECTION, far right, ~20% width: a large tree-trunk cross-section — many fine concentric growth rings filling the whole disc like real wood grain, faded amber-brown, only the outermost ring slightly brighter; NO thick outer border circle, NO arrow or ornament on the disc; big serif number "24" at its center; beneath it two tiny nodes styled like the planning column's — icon inside a hairline circle, uppercase label OUTSIDE below the circle: a small bar-chart icon labeled SUMMARY, a small upward-trend icon labeled RETRO — and below them a small three-figure tally row for THIS ROUND only: "5 merged · 3 pending · 1 needs human" — small numbers, do NOT repeat the big 24 here. A thin DASHED return line runs along the bottom of the whole band, right to left, reconnecting to the PLANNING zone — the loop closes.

Mood: autumn heartwood, warm firelit browns, quiet precision, governance made visible as geometry. Signature moment: the growth rings; narrative moment: lane w2's return arrow — the reviewer pushed back and the worker is fixing its own PR.

## PROMPT — hero board 部件 · light "spring"（变体，仅换调色）

Same layout, light "spring" theme: background warm cream nudged slightly toward pale green #F1F0E2 — cream with a faint green whisper, NOT white, NOT saturated green; panel surfaces one step greener #E9EAD6; primary text dark heartwood brown #251B10; hairlines #8A7A64; activity accent deep amber #8A5A14; success deep teal-green #3E6B4F; needs-a-human #A34620. Mood: early spring on warm paper — fresh, calm, bright. Rings drawn in soft brown on the pale ground.

## Hero 审评清单（每轮出图后对照）

1. 三条 lane 状态明显错相（writing / fixing / 等待）？——并行的证据
2. 打回箭头从检查点**指回 lane 本身**（不是 ci↔review 互指），带原因词？
3. "round 2 of 3" 圈数计数可辨？——环转过的证据
4. 检查点是一个安静等待区，没有伪造的分步进度动画？
5. 升级是一条 rust 实线支线（从 CI/REVIEW 连接处向下长出，末端人形节点
   + PR #99 水滴），无虚线箭头无悬浮钉，且是全图唯一 rust 元素？
6. 年轮是唯一高光；"24" 大衬线字？
7. 底部虚线回程存在（环闭合），但不喧宾夺主？
8. 无 gate⓪①②字样；分区标注 PLAN/IMPLEMENT/OUTCOME 是次级小字且齐全？
9. 亮色版：底色是"奶油带一丝绿"，不是纯绿也不是纯白？

---

# Header 部件（v3.1 · 冻结，基准 32 号图）

前提裁决（用户，2026-07-21）：**顶部不设 Live/Replay 切换**——看最新轮≈live，
看历史轮=replay。与 §11"replay 单位是轮"同构；是对 §3 A 的正式修订（记档）。

## 元素方案（PM + 架构师 + 架空用户三方合成）

| # | 元素 | 设计 | 数据依据 / 边界 |
|---|---|---|---|
| 1 | 引擎状态词 + 静点 | 词是主角，点是标点（**点不做动画**——hero 已在呼吸）。显示词收敛：running / waiting（=standby+park 合并，park 加小字副注）/ paused / stopping（=winding-down+stopping 合并）/ stopped，异常态 **stalled**（rust）。全称进 tooltip | 哨兵文件+events+staleness 推导，**服务端算**（CLI 与面板永不打架）。先例修订：**staleness 压过 PAUSE**（死引擎+PAUSE 文件显示 stalled，不是 paused）——§8 与 walkthrough §6 矛盾的裁决 |
| 2 | **轮导航**（模式载体） | `◂ [round 12] ▸` 步进器；**最右永远是 LIVE 槽**：有开轮显 "LIVE · round 12 · executing"，无开轮显 "LIVE · waiting/stopped"（live 是一个可导航到的位置，空轮情形有定义）。点击轮号弹列表：每行 = 轮号 · 日期 · PR 数 · 花费 · 已关轮行首 **▶ 字形**（可回放性一眼可读，列表兼作 history ledger）。不在 LIVE 位时，**"◂ back to live" 常显** | `rounds` 表为脊柱 + `round_artifacts` left-join 终局三数（无 artifact 的轮如实无 tally）——§8 /api/rounds 修订项。`◂` hover tooltip = "replay round 11"（无模式开关下的可发现性） |
| 3 | 回放走带（条件性） | 仅历史轮渲染：play/pause · 一个速度循环钮（×1/×4/×16）· scrub "event 12/33"；同时 header 持续显示 **"ROUND 9 · CLOSED" 染色徽章**（40 秒后也不忘身处历史）。功能就此打住（无逐帧/AB 区间/花式倍速） | 游标=events.id，章节窗=rounds 的 id cursors，纯客户端折叠。**铁律：走带与引擎动词永不共享位置与图标语言**（走带=媒体图标、左侧下沉条；引擎动词=文字按钮、右上）——本轮走查唯一"真实事故级"发现 |
| 4 | 花费仪表 | `$10.4 ▓▓▓░ +$2.2 est / $100`：实付实心+估算斜纹，run 层为主；**日限额收 hover，用量 ≥75% 自动浮出示警**。历史轮：截至游标、纯实付无 est 段、"today" 副读数隐藏 | 四个数：日和(有)/日限(config)/run 和(**引擎内存 anchor 未持久化——见依赖**)/run 限(optional)。无 run 限→整表落日层（§3 A 既有路径）；config 不可读→只分子不造分母 |
| 5 | 运行控制（三档） | header 右端，**文字小按钮**：**PAUSE**（温和：不再派新活，在飞的干完）/ **STOP**（drain-first：kill-switch + 排水窗内收尾，超时才硬停）/ **EMERGENCY STOP**（急停：立即硬停一切，rust 红、视觉隔离在最右，**八边形轮廓图标 + 全拼**——E-STOP 缩写在软件语境误读为 E-SHOP，v3.1 裁决弃用；全拼与引擎信号 `EMERGENCY_STOP` 一字不差。图标规则：八边形全页唯一，PAUSE/STOP 保持纯文字——不对称即层级）。合法动词才显示（resume 仅 paused 态…）；两步确认；STOP 长按 arm 且**松手=取消**；E-STOP 双保险（长按 arm + 确认弹层写明后果"in-flight work is killed, WIP may be lost"）。**看历史轮时整组隐藏**（对过去无可操作——模式纯净律用在写路径上），配 "back to live" 跳回 | POST /api/control 哨兵写；`dashboard.controls` 键 gate（#210 未落地）。**E-STOP 需引擎新增信号**（现有 kill-switch 必排水后杀；急停=跳过排水立即硬杀，additive，实施时立引擎 issue）。进程已死时 Start 钮翻转为 CLI 启动命令展示 |
| 6 | "?" 图例 | 小圆钮：水滴=issue / lane=worker / 年轮=merged PR 三行 + 角色词（producers≠reviewers≠mergers 住这里）+ est/settled 斜纹语法 | copy.ts 静态，live/replay 同词表 |

不进 header：wordmark/config（侧栏）、needs-attention 条（独立）、staleness 明细（hero）。

## 三个开放问题的裁决

1. **无开轮时 live 是什么** → live 是导航器最右的**常驻槽位**（不是"最后一轮+悬浮标签"）——standby/park/stopped/空库四种空态都有定义。
2. **当前轮可否回拖** → **v0.2 不可**。"游标落后于 HEAD"会把控制隐藏、est 纯净性搅成第三种模式；当前轮看 live、关轮即可回放，边际复杂度不值。v0.3 再议。
3. **实施排期 vs #206** → 出图不受影响（预期图画目标态）；实施上 **#206（run-started + round-phase）升格为 header 的硬前置**：run 层仪表的 anchor 只存在于引擎进程内存（未持久化，面板服务器读不到），replay 相位点灯同样压在它上面。落地前仪表整表走日层（既有 fallback 路径，零新机器）。

## 实施期文档修订清单（出图不阻塞，记档防丢）

- §3 A：撤 Live/Replay toggle → 轮导航即模式；日限额 hover 化+阈值浮出。
- §8：状态推导先例（staleness > PAUSE）；/api/rounds 改 rounds 表为脊柱。
- park 态显示折入 waiting；§11 REPLAY 徽章挂到导航器位置上。
- 新铁律：回放走带与引擎动词不共位置/不共图标语言。
- #206 标记为 dashboard header 硬前置。
- **E-STOP 引擎信号**（用户新增，2026-07-21）：急停=跳过 drain 窗立即硬停；
  代码核查确认 kill-switch 为 drain-first（SIGTERM 交接请求，超窗才硬杀），
  急停需 additive 新信号 → **已立 #293**（EMERGENCY_STOP 哨兵，v0.2 里程碑，
  type:security，实施 PR human-merge-only）。UI 侧 E-STOP 与 STOP 的区别
  必须在确认弹层里如实陈述（不许把急停说得比引擎行为软）。

## PROMPT — header 部件 · dark "autumn"（双态对照图 · v3.1）

基底=29 号图（密度、方槽 chevron、虚线栅栏），融合 31 号图的走带通栏分隔线；
E-STOP 改 `⬡ EMERGENCY STOP`。

Two horizontal dashboard header bars stacked vertically with a small gap on one dark canvas, wide 16:5 landscape, flat modern web app UI, crisp vector look, no browser chrome, no perspective, no photograph. Top bar = LIVE state, bottom bar = HISTORY state of the SAME header. This is one component of a larger dashboard. Dense compact instrument-panel layout, square-cornered slots, NOT airy or rounded.

PALETTE (autumn, warm): canvas warm dark brown #251B10 — NOT black; bar surfaces slightly lighter brown #2E2317 with hairline 1px borders #8A7A64; primary text warm cream #F1E7D2; amber #E8A33D for activity; rust orange #C05A2E strictly reserved for the EMERGENCY STOP button. No neon, no purple, no gradients, no glow, no shadows. All text tiny monospace or tiny uppercase letterspaced; nothing animated-looking, everything still and calm.

TOP BAR — LIVE state, left to right:
(1) a small static green dot + the word "running";
(2) round navigator: a rectangular stepper made of three joined slots — left slot with a thin chevron "‹", middle slot "ROUND 12 · LIVE", right slot with a chevron "›" rendered dimmed/disabled. Chevrons are thin angle brackets, NEVER triangle play glyphs;
(3) center: a thin horizontal budget meter — solid amber segment, then a short hatched translucent amber tail, then empty track — captioned below "$10.4 + $2.2 est / $100";
(4) a thin vertical DASHED divider, then two small plain text buttons "PAUSE" and "STOP" (no underline, no border), then another thin vertical dashed divider, then one rust-outlined rectangular button at the far right containing a small rust octagon outline icon (stop-sign shape, empty inside) followed by the rust text "EMERGENCY STOP" — the only rust element and the only icon-bearing button in the whole image;
(5) a tiny hairline circle "?" button at the very end.

BOTTOM BAR — HISTORY state of the same header. Two rows separated by a full-width thin horizontal hairline rule inside the bar.
Upper row, left to right:
(1) the same static green dot + "running" (the engine is still alive);
(2) the same rectangular round stepper now reading "‹ ROUND 9 · CLOSED ›" with a subtle amber-tinted outline badge, then a small solid amber button "▸▸ BACK TO LIVE";
(3) the budget meter with a solid-only amber segment captioned "$6.2 of this round" — no hatched tail;
(4) NO PAUSE, NO STOP, NO EMERGENCY STOP anywhere on this bar — right end empty except the "?" button.
Lower row, under the full-width hairline rule — the replay transport, clearly a separate control layer: a small play triangle "▷", a speed chip "×4", a long thin scrub line with one round position dot, and at the far right the caption "event 12/33". MEDIA-style icons live ONLY in this lower row.

Only these strings must be legible: "running", "ROUND 12 · LIVE", "ROUND 9 · CLOSED", "BACK TO LIVE", "$10.4 + $2.2 est / $100", "PAUSE", "STOP", "EMERGENCY STOP", "$6.2 of this round", "×4", "event 12/33". All other text may be soft unreadable placeholder lines.

Mood: quiet instrument panel, autumn heartwood, warm firelit browns. The two bars must read instantly as the same component in two modes: live = controls present + est tail; history = transport row present + controls gone.

## PROMPT — header 部件 · light "spring"（变体，仅换调色）

Same two-bar layout, light "spring" theme: canvas warm cream nudged slightly toward pale green #F1F0E2 — NOT white, NOT saturated green; bar surfaces one step greener #E9EAD6; primary text dark heartwood brown #251B10; hairlines #8A7A64; activity accent deep amber #8A5A14; EMERGENCY STOP button (octagon icon + text) #A34620. Mood: early spring on warm paper.

## Header 审评清单

1. 双态一眼可辨：live 有控制无走带，history 有走带无控制？
2. EMERGENCY STOP 全拼 + 八边形轮廓图标，与 PAUSE/STOP 间有虚线断层，
   rust 色全图唯一、八边形全图唯一、图标按钮全图唯一？
3. 走带是媒体图标语言（▷/×4/scrub 线），住在通栏细线下的独立子行；
   轮导航箭头是 chevron（‹ ›）**绝非三角形**？
4. est 斜纹尾只出现在 live 态；history 态是纯实付实心段？
5. "ROUND 9 · CLOSED" 徽章醒目（不会看着看着忘了在历史）？"BACK TO LIVE" 存在？
6. 状态词是主角，色点是静止小标点（无光晕无动画感）？
7. 右箭头在 LIVE 位处于灰态（已在最右，无更新一轮可去）？
8. 无 Live/Replay 切换开关残留？无 wordmark/config（它们在侧栏）？

# Lanes 部件（v4.1 · 冻结，基准 37 号图）

输入：用户原型图（33 号，三卡：Available / #94 writing / #90 needs-human）。
三方 = PM + 架构师（引擎代码审计）+ 架空用户（Mara 运维者 / Deniz 评估者）。

## 原型审计（架构师，file:line 在案）

引擎真实 worker 状态**只有六个**：`running / driving / fixing / done / failed
/ handoff`（state.ts:701）。逐项判定：

| 原型元素 | 判定 | 依据 |
|---|---|---|
| "Work lane 1 (w1)" 稳定槽位 | **虚构** | lane 名=`lane-<issue>-<uuid8>` 一次性（worker.ts:988）；w1/w2/w3 只能是渲染序号，不是有历史的实体 |
| 空道卡 "LAST RUN —…"（按道归属） | **虚构**（全局版真实） | "这条道的上一次 run" 无此概念；"最近完成的 run" 可从终态 workers row + spend_ledger 真实回填 |
| "writing" 状态词 | **假粒度** | 无 writing/testing 子状态；running 就是 running |
| 每道不同 model·effort | **虚构** | config 只有全局 worker.model/effort；workers 表无 model 列 |
| driving 道（卡3）的 est/tok/budget 条 | **虚构** | 离开 running 瞬间 telemetry 清空（clearLiveTelemetry, state.ts:1304）；driving 只有已结算成本 |
| 卡3 "— needs human" 占道显示 | **基本虚构** | gate② 升级即释放道（lane→failed）+ 事件进 Needs-attention strip；唯一占道例外=review-silence-escalated（#170） |
| "#94" / "⇌ PR #99" / est $ / tok 数 / 经过时间 | 真实 | workers.issue/pr/est_cost_usd/context_tokens/started_at（est 每 RECLAIM probe 刷新） |
| "5% budget" 条 | 真实可推 | est / worker.budgetUsdSoft（zod 默认 10，分母恒存在） |
| 议题标题内联 | 超前 | 标题入事件=#207 未落；§3 C 定为 hover |

原型遗漏而引擎有据：**fixing**（fix_rounds / lanes.prFixCap → "round 1/2"，有
live telemetry）、**handoff**（resume_attempts / worker.maxResumes）、gated
re-entry 等人摘标、park/canary 停派、DETACHED（重启后无实时数据，不得显示
冻结数字）、auto-compact（context_tokens 掉落值得示意）。

## 架空用户核心诉求

- 两人共同点的最大洞：**fix 态卡缺席**——Mara 的"stalled 还是在思考"盲区
  = Deniz 的"证明评审回环存在"盲区。引擎恰好有真字段供。
- 共同砍：token 数内联（美元已讲完成本故事）→ 收 hover。
- 升级卡要**原因词 + 点击直达**（Mara 要行动，Deniz 要信）。
- 分工共识：**hero 管位置，卡片管深度**（why/cost/reason/act）；卡片头条
  复述水滴位置=纯重复。
- 分歧：空闲卡。Mara 要收窄成细行（三张 Available 大卡挤掉扫视路径），
  Deniz 要保 "LAST RUN 收据"（最有说服力的采纳证据）。折中=细行保收据。

## PM 合成：五种卡面（全部映射真实状态）

面板 = 一行全局 caption + N 个 lane 位（`lanes.max` 定容量，渲染序即槽序，
不造 lane 人格）。**面板级 caption：`opus · high · soft budget $10`**（全局
config 事实上移，卡面不再重复）。

| 卡面 | 触发 | 内容 | 样式 |
|---|---|---|---|
| **working**（原型卡2 骨架保留） | state=running | 大字 issue 号（hover 标题）· 状态词 working · `~$0.53 est` + budget 细条 · 经过时间 · amber 点 | 全尺寸，amber |
| **fixing**（新增，最大缺口） | state=fixing | 大字 issue 号 · `fixing · round 1/2`（fix_rounds/prFixCap）· PR 号 · est + budget 条（fix leg 有活进程有 telemetry）· 经过时间 | 全尺寸，amber，回环小箭头 icon 呼应 hero |
| **in review**（原型卡3 改造） | state=driving | 大字 issue 号 · `PR #99 · in review`（review_trigger_in_flight 推导）· **已结算成本**（spend_ledger 和，无 est 无 tok 无 budget 条）| 中尺寸，静 amber 描边；review-silence-escalated 例外时加 rust 边注（唯一允许的占道 rust）|
| **handed off**（新增） | state=handoff | issue 号 · `handed off · resume 1/2` · WIP 已推送提示 · 已结算成本 | 中尺寸 |
| **idle**（原型卡1 收窄） | 容量−活跃 | 细行：`idle` + `RECENT — #92 ⇒ PR #101 · $0.95`（**全局最近完成 run** 收据，按新近序分配到空行，不再声称"本道上一次"）| 细行，静默 |

排序律：fixing > handoff > working > in review > idle（需要注意的在前）。
DETACHED 道：telemetry 为 NULL 时显示 `no live data`，禁止冻结数字。
needs-human 的家在 Needs-attention strip（原因词+直达链接住那里）；lane 卡
不再做升级头条——与引擎状态机一致（升级即释放道）。

## 实施期规范修订清单（记档防丢）

- §8 items 增补 `fixing`/`handoff`（合同早于 v19）；样例 `"lane":"w1"`
  与引擎命名漂移注记；schema v11 → 22。
- §3 C 空道 "quiet outline" 改为细行+RECENT 收据；caption 上移面板级。
- token 数收 hover（context % 对 pricing.yaml contextWindow）。
- **首轮出图后用户三裁决（2026-07-21，均接受）**：
  1. **w1/w2/w3 槽号**与 hero 对读——定性为显示层渲染槽位，hero 与
     面板由服务端同一排序分配（w2 水滴=w2 卡）；红线：槽号不携带历史。
  2. **issue/PR 图标区分**：issue=水滴（hero 同款）、PR=行业标准
     pull-request 字形；"?" 图例补这一对。
  3. **标题内联**（issue 一行截断 + PR 行带标题）——对 §3 C hover-only
     的正式修订；**#207（标题入事件 payload）升格为 lanes 面板硬前置**
     （面板服务器不碰 GitHub，标题唯一来源是事件）；#207 落地前卡面
     退化为纯编号。

## 裁决记录（用户，2026-07-21：四点全部接受）

1. idle 收据 = 细行 + `RECENT`（全局新近，不装道史）✔
2. needs-human 移出 lane 卡 → Needs-attention strip（卡上只留
   review-silence 例外的 rust 边注）✔
3. token 数收 hover；model·effort 上移面板级 caption ✔
4. 状态词表 working / fixing (round n of cap) / in review / handed off /
   idle 采纳 ✔

## On hold（用户新增议题，2026-07-21 裁决）

hold = 三档升级模型中唯一**人主动发起**的载体（人贴 hold 标签 →
gate 推导判 WAIT，不合并直到摘标）。语义与 needs-human 相反：
needs-human=系统请求人（rust）；hold=人已介入、行使控制（**禁 rust**）。

- **Lane 卡（主呈现）**：in review 卡变体，状态词 `PR #99 · on hold`，
  小 hold 钉图标 + cream 素色徽章，平静无告警感；已结算成本照旧；
  排序与 in review 同档（人自己停的不抢注意力位）。
- **Hero**：水滴停 CI/REVIEW 检查点 + 小 hold 钉（第三修订已画为目标态）。
- **Needs-attention strip：不进**（strip 纯度=系统在等人）。
- 数据边界：引擎今天只在 gate 推导时读 hold 标签、无事件落库 →
  **#294 已立**（2026-07-21，v0.2 里程碑，Project #4）：`pr-held`/
  `pr-released` transition-only 事件（沿用 #169 去重旗范式，gate 行为
  不动），为 ON HOLD 卡 + hero hold 钉的实施硬前置。
- **执行入口（2026-07-21 议定）**：hold 动作**在 GitHub 执行**（PR 贴
  `escalation.holdLabels` 标签；issue 侧同标签兼派工排除 #248），
  dashboard **不设 hold 按钮**——写面只有 /api/control 运行态哨兵，
  零 GitHub 写路径（#110"token 即能力"既锁）。面板职责=affordance：
  ①PR 号一键直达 GitHub PR 页；②"?" 图例 + ON HOLD hover 白话说明
  "held by label X — remove the label on GitHub to release"，标签名
  从 resolved config 与 #294 事件 payload 读出。

## PROMPT — lanes 部件 · dark "autumn"（v4.1 · 基底=35 号图）

首轮评审：34/35/36 共同过零 rust/零 token/caption 唯一/fixing 计数/
ON HOLD cream 徽章。基底取 35（卡顶横条给槽号+状态一个家，卡身高度
容得下标题行）。三处用户裁决并入：w 槽号、issue/PR 字形、标题内联。

A single wide dashboard panel on a dark canvas, wide 16:5 landscape, flat modern web app UI, crisp vector look, no browser chrome, no perspective, no photograph. This is the "lanes" panel of a larger dashboard: one row of THREE cards side by side plus ONE slim full-width row underneath. Dense compact instrument-panel aesthetic, square-cornered slots, NOT airy or rounded.

PALETTE (autumn, warm): canvas warm dark brown #251B10 — NOT black; card surfaces slightly lighter brown #2E2317 with hairline 1px borders #8A7A64; primary text warm cream #F1E7D2; muted secondary text #B9A98C; amber #E8A33D strictly for activity marks and progress bars. ABSOLUTELY NO rust orange, NO red, NO green checkmarks, NO neon, NO gradients, NO glow. All text tiny monospace or tiny uppercase letterspaced; everything still and calm.

PANEL HEADER: top-left small letterspaced label "LANES"; top-right one quiet caption "opus · high · soft budget $10" — appears ONCE at panel level, NEVER inside cards.

Each card has a slim TOP STRIP separated from the card body by a hairline rule. Two tiny glyphs are used throughout and must look clearly different: a small WATER-DROPLET outline glyph always sits before issue numbers; a small GIT PULL-REQUEST glyph (two tiny circles joined by a branching line) always sits before PR numbers. Both are thin cream line icons.

CARD 1 — working lane. Top strip: left "w1", right a small static amber dot + "working". Body: droplet glyph + LARGE monospace "#94"; under it one muted single-line issue title "Add cost ceiling alert webhook"; then "~$0.53 est" with a very thin amber progress bar only slightly filled; bottom-left elapsed "8m".

CARD 2 — fixing lane. Top strip: left "w2", right amber dot + "FIXING · ROUND 1/2" + a SMALL curved return-loop arrow icon. Body: droplet glyph + LARGE "#90"; muted title line "Support multi-repo board sync"; below it a quieter reference line: pull-request glyph + "PR #99 — board: multi-repo sync support"; then "~$1.69 est" with a thin amber bar filled about a fifth; bottom-left elapsed "32m".

CARD 3 — on hold lane. Top strip: left "w3", right a small cream-outlined badge "ON HOLD" with a tiny pin glyph inside — CREAM outline, calm, NOT amber, NOT orange. Body: droplet glyph + LARGE "#87"; muted title line "Prune stale board columns"; reference line: pull-request glyph + "PR #96 — chore: prune stale columns"; then "$1.10 settled" as plain text with NO progress bar, NO est; NO elapsed time.

SLIM ROW below the three cards, full width, half card height: left "w4 · idle" with a small hollow dot; right one quiet receipt "RECENT — #92 ⇒ PR #101 · $0.95".

NO token counts anywhere. NO model names inside cards. NO green/red status icons. NO rust or red pixels anywhere.

Only these strings must be legible: "LANES", "opus · high · soft budget $10", "w1", "working", "#94", "Add cost ceiling alert webhook", "~$0.53 est", "8m", "w2", "FIXING · ROUND 1/2", "#90", "Support multi-repo board sync", "PR #99", "~$1.69 est", "32m", "w3", "ON HOLD", "#87", "PR #96", "$1.10 settled", "w4 · idle", "RECENT — #92 ⇒ PR #101 · $0.95". Other text may be soft placeholder lines.

Mood: quiet instrument panel, autumn heartwood, warm firelit browns. Three sibling cards in different states: active amber (working, fixing), deliberately parked cream (on hold), slim idle capacity row.

## PROMPT — lanes 部件 · light "spring"（变体，仅换调色）

Same panel layout, light "spring" theme: canvas warm cream nudged slightly toward pale green #F1F0E2 — NOT white, NOT saturated green; card surfaces one step greener #E9EAD6; primary text dark heartwood brown #251B10; hairlines #8A7A64; activity accent deep amber #8A5A14; ON HOLD badge outline dark heartwood brown. Mood: early spring on warm paper.

## Lanes 审评清单

1. fixing 卡存在且带 `FIXING · ROUND 1/2` 计数 + 回环小箭头（评审回环
   在细节层有家）？
2. on hold 徽章是 cream 素色 + hold 钉，无告警感？**全图零 rust 零红**？
3. on hold 卡是 `$1.10 settled` 纯文本——无 est、无进度条、无 token、
   无经过时间（driving 态 telemetry 已清空的诚实呈现）？
4. token 数全图缺席？model·effort 只在面板 caption 出现一次、卡内无？
5. idle 是细行不是大卡；RECENT 收据在、且不声称"本道上一次"？
6. ~~大字 issue 号无内联标题~~ **v4.1 改判**：issue/PR 标题一行截断内联
   （用户裁决；#207 升格 lanes 硬前置）？
7. budget 条只出现在活进程卡（working/fixing），细、amber、无分段？
8. 三卡读得出是同一部件的三种状态（活动 amber / 停驻 cream / 容量细行）？
9. （v4.1 新增）w1–w4 槽号在卡顶横条/细行，与 hero 可对读？
10. （v4.1 新增）水滴=issue、pull-request 字形=PR，两字形清晰可辨、
    全部编号前都带？

# Cost strip 部件（v5 · 冻结，基准 40 号图）

§3 E 信息架构已定（phase+model 双桶、est/settled 斜纹语法、Config ▸ 入口），
本轮只做数据核实 + 元素落地。**核实结论：零新引擎前置。**

## 数据依据（架构师核查 2026-07-21）

- `spend_ledger`：`ts/worker/issue/usd` + v-迁移 `model` 与 token 四列
  （input/output/cache_read/cache_creation），每 (lane, model) 一行。
- **phase 推导 = worker 名前缀**：lane 工人 `lane-<issue>-<uuid8>`
  （worker.ts:988）、角色 session `role-<roleId>-<uuid8>`
  （peripheral.ts:413，记账 peripheral.ts:916）。服务端前缀映射 →
  §7 阶段词：role-po→Goal & align，role-architect→Arch review，
  role-plan-review→Verify，`lane-*`→Lanes（首 leg+fix leg 同桶），
  role-harvest→Summary，role-retro→Retro。内部 key 永不渲染。
  实施注：前缀解析是服务端约定，须配一条"角色名前缀改动即碎"守护测试。
- **回放窗口**：rounds 表 `start_spend_id` 游标（state.ts:25）切轮窗——
  既有机制，live=今日 ts 窗，replay=轮 id 窗。
- **est 叠层只属 Lanes 桶**：live est 三件套只存在于活 lane
  （workers.est_cost_usd）；角色 session 同步短跑、无 live telemetry——
  别的桶画斜纹尾就是造假。
- Codex bot 评审=外部服务，引擎零记账——REVIEW 不成桶（诚实缺席）。

## 元素方案

| 元素 | 设计 | 数据 |
|---|---|---|
| BY STAGE 横条组 | 六桶横条（Goal & align / Arch review / Verify / **Lanes** / Summary / Retro），settled 实心 amber，**仅 Lanes 条**可带斜纹 est 尾；条右端小字金额 | 前缀映射 + SUM(usd)，est 尾=活 lane est_cost_usd 和 |
| BY MODEL 横条组 | 每 model 一条（opus/sonnet/…），实心；hover = token 四分（input/output/cache read/cache write） | `model` 列 + token 四列 |
| 窗口标注 | 左上角 "TODAY"（live）/ "ROUND 9"（replay，跟随导航器） | ts 窗 / start_spend_id 窗 |
| Config ▸ | 右上小入口，开只读 drawer（§3 E 既有规格，不在本部件出图） | allowlist 键 |
| 空态 | 今日零记账 → 条组隐去，一行 "no spend recorded today" | |

不进 cost strip：日限额/run 总额（header 花费仪表管）、per-lane 成本
（lane 卡管）——同一事实一个家。

## 裁决记录（三方合成，2026-07-21；用户指令：带架空用户审评 + 历史轮费用议题）

1. **历史轮费用**（用户提问）：平均值进 strip 标注（"this round $6.2 ·
   avg $4.8" **成对**才是单位，孤立平均无锚点）；每轮总额的家=轮导航器
   列表（已有 spend 列），strip 不重复。§2 历史聚合 deferral 不踩线
   （本地 ledger 聚合，非 GitHub 历史）。
2. **轮账单行**（Deniz）：replay 窗右对齐一行
   `total $6.2 · 3 PRs merged · $2.07/PR · review: external ($0)` ——
   review 零花费**明说**而非无声缺席（信任洞修补）；$/PR = 采纳备忘录
   数字（轮 spend 窗 + artifact merged 数，零新数据）。
3. **Config ▸ 砍出 strip**（两人设一致；rail 底部 config 齿轮已是入口）
   ——§3 E 修订项。
4. **布局 = Mara 案**：左右并排一条扁 strip，BY STAGE 占 2/3 宽。
5. **BY MODEL 保留收窄**（评估者的"收据"信任信号），token 四分留 hover。
6. **幽灵中位刻度**（Mara）：每根 stage 条一枚暗淡刻度=该阶段历史中位，
   一眼判常异；超中位**不染 rust**（超均值≠该人看）。
7. fix-leg v0.2 不拆；费率/速度概念不加。
8. **$ ⇄ tok 显示切换**（用户新增，2026-07-21）：微型 `$ | tok` 文字
   开关，strip 右上（原 Config ▸ 位）。三道护栏：①只切两组条的单位，
   货币事实（avg round / 轮账单行）永远 $；②tok 模式无 est 斜纹尾
   （引擎无 est-tokens 事实，尾巴诚实消失）；③开关=显示 chrome（与
   主题切换同类），永不进控制动词的位置/样式语言。token 四分 hover
   两模式保留；tok 模式同样禁分段。默认 $——与人设裁决兼容（砍的是
   常驻内联，不是按需深入）。40 号基准不返工，融合图补画开关。

## PROMPT — cost strip 部件 · dark "autumn"（双态对照图 · v5）

Two slim horizontal dashboard cost panels stacked vertically with a small gap on one dark canvas, wide 16:5 landscape, flat modern web app UI, crisp vector look, no browser chrome, no perspective, no photograph. Top panel = LIVE "today" state, bottom panel = REPLAY "closed round" state of the SAME component. Dense compact instrument-panel aesthetic, square corners, NOT airy.

PALETTE (autumn, warm): canvas warm dark brown #251B10 — NOT black; panel surfaces slightly lighter brown #2E2317 with hairline 1px borders #8A7A64; primary text warm cream #F1E7D2; muted secondary text #B9A98C; amber #E8A33D strictly for spend bars. NO rust orange, NO red, NO green, NO neon, NO gradients, NO glow. All text tiny monospace or tiny uppercase letterspaced.

TOP PANEL — LIVE state:
(1) top-left caption "COST · TODAY" followed by a muted reference "avg round $4.8";
(2) left two-thirds, group label "BY STAGE": six thin horizontal bars stacked, labels left, small dollar amounts at each bar's right: "Goal & align $0.22", "Arch review $0.31", "Verify $0.18", "Lanes $8.9", "Summary $0.26", "Retro $0.29". The Lanes bar is much longer than all others and carries a short HATCHED translucent amber tail at its end (live estimate). Each bar also shows one FAINT short vertical tick — a dim historical-median marker, quiet, amber-dimmed, NOT a second bar;
(3) right third, group label "BY MODEL": two solid amber bars "opus $7.8" and "sonnet $2.4". No hatched tails here;
(4) NO config link anywhere.

BOTTOM PANEL — REPLAY state of the same component:
(1) top-left caption "COST · ROUND 9" with a small amber-outlined badge "CLOSED";
(2) same six BY STAGE bars, ALL solid — no hatched tail anywhere — amounts "Goal & align $0.15", "Arch review $0.24", "Verify $0.12", "Lanes $5.1", "Summary $0.21", "Retro $0.38", faint median ticks present;
(3) same BY MODEL group, solid bars "opus $4.9", "sonnet $1.3";
(4) bottom-right one quiet ledger line: "total $6.2 · 3 PRs merged · $2.07/PR · review: external ($0)".

Only these strings must be legible: "COST · TODAY", "avg round $4.8", "BY STAGE", "BY MODEL", "Goal & align", "Arch review", "Verify", "Lanes", "Summary", "Retro", "$8.9", "opus", "sonnet", "COST · ROUND 9", "CLOSED", "total $6.2 · 3 PRs merged · $2.07/PR · review: external ($0)". Other numbers may be small but tidy; any other text soft placeholder.

Mood: quiet instrument panel, autumn heartwood, warm firelit browns. The two panels must read instantly as the same strip in two windows: live = est tail on Lanes only; replay = all settled plus the round ledger line.

## PROMPT — cost strip 部件 · light "spring"（变体，仅换调色）

Same two-panel layout, light "spring" theme: canvas warm cream nudged slightly toward pale green #F1F0E2 — NOT white, NOT saturated green; panel surfaces one step greener #E9EAD6; primary text dark heartwood brown #251B10; hairlines #8A7A64; spend bars deep amber #8A5A14. Mood: early spring on warm paper.

## Cost strip 审评清单

1. 双窗一眼可辨：TODAY 有 est 斜纹尾（仅 Lanes 条），ROUND 全实心？
2. 六个 stage 桶齐全、用 §7 阶段词、无内部 key、无 REVIEW 假桶？
3. 轮账单行存在且含 `review: external ($0)` 明示零？
4. "avg round $4.8" 参照在 TODAY 标注旁（成对语义在 replay 由
   total 行承担）？
5. 中位刻度暗淡、不是第二根条、无 rust？
6. BY STAGE 占约 2/3 宽、BY MODEL 收窄右侧、无 token 数内联？
7. 无 Config 链接残留？
8. 全图零 rust 零红零绿？

## 出图评审（2026-07-21，38/39/40 号图）

40 号定为基准（8/8）；38 亚军（同样全对，线重更细——整页融合时的
像素层备选）；39 淘汰：条画成带分隔线的分段盒，打穿"预算条一种语法：
实心+斜纹、无分段"，BY MODEL 凭空分段。实施注记：**BY MODEL 条永不带
刻度/分段**（中位刻度只属 stage 条）。

# Needs-attention strip 部件（v6 · 冻结，基准 41 号图 + 42 重 chip 嫁接）

rust 的正主。三方 = PM + 架构师（升级事件族全量审计，file:line 在案）+
架空用户（Mara/Deniz）。

## 架构师审计核心（离场机制三分天下）

引擎升级事件 Tier-1 约 18 种（drive-needs-human / fix-rounds-capped /
gated-reentry-capped / resume-capped / resume-undecidable /
review-silence-escalated / ceiling-escalated / env-failure-preserved /
worktree-retained / rollback-escalated / park-escalated /
plan-review-escalated / fix-thread-write-escalated / 无 PR 家族 / …）。
清场信号分三类：

1. **健康类（真实 clear）**：gated-reentry / merged / dispatched /
   park-resumed / plan-approved / concern-adjudicated / 同键 supersession。
2. **永久闩类（零 clear）**：gated-reentry-capped（手工合并引擎零感知）、
   worktree-retained（等 #210 worktree-released）、merged-path
   rollback-escalated、labeled:0 的 drive-needs-human。
3. **只认 dispatched 类**：resume-capped / resume-undecidable /
   ceiling-escalated（该路径不置 gated_escalation_labeled，规范原 clear
   列表过宽——修订项）/ env-failure-preserved / 无 PR 升级——人在循环外
   手工完成即永久僵尸。

发射侧漏洞：**verify:n/a 提案零事件**（plan-review.ts:540-564 只贴标签）。
规范另有四处修订项：plan-review-escalated 的 round-close clear 不诚实
（须改 issue-scoped，真 clear=plan-approved/dispatched）；ceiling clear
列表过宽；rollback 两 target 未区分；Tier-2 label-failed 家族取舍要对称。

**引擎补洞（已立项 2026-07-21）**：**#295** escalation-resolution
reconciler（观察外部态发 escalation-resolved，范式=concern-adjudicated
+ #210）；**#296** verify-na-proposed 事件。二者为 strip 契约
（"空=没有事等你"）的硬前置。

## 架空用户核心裁决（Mara/Deniz 高度同向）

- **入场铁律**：系统**真的停下来在等人**才进 strip——警告/FYI/自愈/
  人自己的 hold 一律不进；一条假 rust 杀死整个契约。
- **禁 UI 删除**；允许点击后的本地 "seen" 变暗（计数不变、条目不消失）。
- **oldest-first**；同 issue 多告警合一行叠 reason 徽章。
- 过期升级**不发明新色**：≥24h 年龄 chip 加重，位置（oldest-first 置顶）
  自己喊。头部聚合 `N waiting · oldest 3d`。
- **空态永不隐藏**：一行 moss `nothing waiting on you` + 心跳时间戳
  （"空"与"采集器死了"必须可区分）。
- **位置：页首 header 之下**（Deniz："把自我批评放 hero 之上是价值观
  声明——失败是一等公民"）。

## 元素方案

| 元素 | 设计 | 数据 |
|---|---|---|
| 头部行 | `NEEDS ATTENTION — 3 waiting · oldest 3d`；空态换 moss 行 `nothing waiting on you · checked 12s ago` | 服务端 fold + 轮询心跳 |
| 条目行（整行可点，直达 issue/PR） | `[REASON 徽章(可叠)] [字形+编号+标题截断] — 白话原因 + 明示要求（"asks: adjudicate"）· 年龄`；默认一行，chevron 展开细节（尝试计数等） | 事件 payload + §7 copy map |
| reason 词表（封闭集，行业词） | FIX CAP / REVIEW SILENCE / NO PR / RESUME CAP / CEILING / ENV / BOARD / PLAN / VERIFY? / WORKTREE / PARKED / ORPHAN | 事件 kind → 徽章映射 |
| 折叠律 | dedupe 键=issue（无实体类按 source 单例）；Tier-2 label-failed 不成行，折为父条目上的小注 "label write failing, retrying"；每 tick 重发类必须折叠 | 架构师 C 节 |
| seen 态 | 本地 cosmetic 变暗（localStorage），计数永不变 | 纯前端 |
| 无 clear 类的诚实边界（#295 落地前） | 该类条目带小标 `manual · verify on GitHub`——引擎无法确认时**把不确定说出来**（Mara 规则 7），#295 落地后与健康类同清场 | payload 判别（如 labeled:0） |
| rust 预算 | 徽章+左边框 rust 点染，**不整行泼 rust**；strip 是 rust 主家但不是 rust 洪水 | |

**dissent 改判（用户，2026-07-21）**：dissent **进 strip**——返工代价论
（speak-not-act 不阻塞交付，分歧越有价值发现越晚返工越贵；strip 是人
唯一必看区）。但**不穿 rust**：amber DISSENT 层，排在 rust 条目之后，
头部分开计数 `2 waiting · 1 dissent`（"waiting on you" 空态契约不稀释；
rust 清零+有 dissent 时 moss 行变 `nothing blocked · 1 dissent open`）。
离场=concern-adjudicated（closed/body-changed/external-reply）。
色谱语义定稿：rust=停摆等人；amber dissent=带异议继续跑，早看免返工。

**排除判定（记名）**：
produce-PR-and-stop 模式下 gated-green PR 的聚合行（"N PRs ready for
your merge"，amber 非 rust——是工作流不是故障）**deferred**，v0.2 dogfood
用 conductor-merge；orphan-detected 进 strip（快照语义清场）。

## 裁决记录（2026-07-21 全部落定）

1. dissent：**用户改判进 strip**（amber 层不穿 rust，见上）✔
2. 无 clear 类 `manual · verify on GitHub` 小标（#295 前诚实降级）✔
3. PLAN / VERIFY 合并为一个 PLAN 徽章（词表最小化）✔
4. 头部聚合行 `N waiting · oldest Xd · M dissent` + 空态心跳戳 ✔

## PROMPT — needs-attention strip · dark "autumn"（双态对照图 · v6.1 · 基底=41 号图）

基底 41（单行密度、槽位一致）+ 42 的重型年龄 chip；43 的 seen 提亮
反转列为负约束。

A slim wide dashboard alert strip shown TWICE stacked vertically with a small gap on one dark canvas — top instance POPULATED, bottom instance EMPTY — wide 16:5 landscape, flat modern web app UI, crisp vector look, no browser chrome, no perspective, no photograph. Dense compact instrument-panel aesthetic, square corners. Every list row is a SINGLE line — no two-line wrapping.

PALETTE (autumn, warm): canvas warm dark brown #251B10 — NOT black; strip surface slightly lighter brown #2E2317 with hairline 1px borders #8A7A64; primary text warm cream #F1E7D2; muted secondary #B9A98C; amber #E8A33D; muted moss green #8FA36B ONLY for the empty-state line; rust orange #C05A2E ONLY on the waiting-tier badges and their thin left borders. No neon, no red, no gradients, no glow. Tiny monospace / tiny uppercase letterspaced text. ABSOLUTELY NO close buttons, NO "x" icons, NO dismiss affordances anywhere.

TOP INSTANCE — populated. Header row: left small letterspaced title "NEEDS ATTENTION", right aggregate "3 waiting · oldest 3d · 1 dissent". Below, four single-line rows separated by hairlines. EVERY row uses the same slot order left to right: [thin colored left border] [badge] [tiny glyph] [number — short title] [muted reason with an "asks:" verb] [right-aligned age chip]:
(row 1, oldest) RUST left border; rust-outlined badge "FIX CAP"; pull-request glyph; "PR #212 — retry queue backoff"; muted "fix rounds used up (3/3), reviewer still requesting changes · asks: adjudicate"; age chip "3d" rendered HEAVY — noticeably LARGER than the other age chips, bold cream text, thick border — the one loud element of the whole strip;
(row 2) rust left border; badge "REVIEW SILENCE"; pull-request glyph; "PR #208 — cache warmers"; muted "reviewer never answered after 2 pings · asks: review or nudge"; small age chip "2h"; this ENTIRE row is DIMMED to about half opacity — clearly darker and quieter than its neighbors, NEVER highlighted or brighter — with a tiny eye glyph at its far left (operator has seen it; still unresolved, still counted);
(row 3) rust left border; badge "CEILING"; water-droplet glyph; "#217 — nightly export job"; muted "hard-stopped at daily budget, worktree kept · asks: re-ready or salvage"; small cream hairline tag "manual · verify on GitHub"; small age chip "45m";
(row 4, last) NO rust anywhere in this row: AMBER left border and AMBER-outlined badge "DISSENT"; pull-request glyph; "PR #226 — schema loosening"; muted "worker complied, filed disagreement · asks: adjudicate"; small age chip "20m".

BOTTOM INSTANCE — empty state: the same strip frame at half height, containing one single quiet moss-green line, centered-left: "nothing waiting on you · checked 12s ago". Nothing else. The frame is identical in width and border to the populated instance.

Only these strings must be legible: "NEEDS ATTENTION", "3 waiting · oldest 3d · 1 dissent", "FIX CAP", "PR #212", "3d", "REVIEW SILENCE", "PR #208", "2h", "CEILING", "#217", "manual · verify on GitHub", "45m", "DISSENT", "PR #226", "asks: adjudicate", "20m", "nothing waiting on you · checked 12s ago". Other text may be soft placeholder.

Mood: quiet instrument panel, autumn heartwood. Reading order of loudness: the oversized "3d" chip first, then the bright rust rows, then the dimmed seen row, then the amber dissent row; empty = calm moss reassurance with a heartbeat, frame never hidden.

## PROMPT — needs-attention strip · light "spring"（变体，仅换调色）

Same two-instance layout, light "spring" theme: canvas warm cream nudged slightly toward pale green #F1F0E2 — NOT white; strip surface one step greener #E9EAD6; primary text dark heartwood brown #251B10; hairlines #8A7A64; amber #8A5A14; rust accents #A34620 (badges + left borders only); empty-state moss line #3E6B4F. Mood: early spring on warm paper.

## Needs-attention 审评清单

1. rust 层与 amber DISSENT 层一眼分层（DISSENT 无 rust 边、排最后）？
2. 头部聚合 `3 waiting · oldest 3d · 1 dissent` 分开计数？
3. oldest-first：3d 条目在最上且年龄 chip 加重（无新色）？
4. "seen" 行是变暗+眼形小标，条目仍完整在场、计数未变？
5. `manual · verify on GitHub` 小标在 CEILING 条目上（诚实降级可见）？
6. 每行都有 asks: 动词 + 白话原因 + 字形化编号（水滴/PR 字形沿用）？
7. **全图零关闭钮零 X**（禁 UI 删除的像素证据）？
8. 空态=同框架半高 + moss 行 + 心跳戳，框架未隐藏？
9. rust 只出现在徽章与左边框（不整行泼）；moss 只在空态行？

## 定性澄清（用户提问，2026-07-21）：队列不是日志

- **已处理条目离场**（clear 信号一到整行消失），strip 只装还开着的事；
  已解决记录的家 = activity feed（升级+解决事件同流）与轮回放。
- **新条目可见性三道保险**：①头部计数先动（第一信号）；②亮暗分层——
  seen 变暗的另一半作用是让未看过的新条目全亮跳出，位置=欠账时长、
  亮度=新旧，两维互不打架；③健康规模 0–3 行本来就一屏。
- v0.2 不设行数上限不折叠——strip 变长本身就是诚实信号。
- newest-first 被否的原因：新条目有计数+亮度两道保险，旧欠账只有
  位置一道，位置必须留给旧的（否则底部腐烂→整条变装饰）。

## 出图评审（2026-07-21，41/42/43 号图）

**41 号定基准**（单行密度贴 strip 本分、字形槽位全行一致、双层/小标/
空态/零关闭钮全过），嫁接 42 号的**重型年龄 chip**（加大加粗描边，
≥24h 阈值——42 是唯一做对 oldest 喊话的）。43 淘汰：seen 行画成整行
**提亮**=语义反转（看过的该变暗退后，提亮读作选中）。实施注记：
①seen 变暗要 40–50% 不透明度，仅眼形字形不足；②CEILING 类字形槽位
与其余行保持一致（徽章→字形→编号）。

## 变更记录（浓缩：只留迭代理由，细节以各部件章节现行文本为准）

- v2：转部件分解流程；hero 三方合成 + 首版提示词。
- v2.1–v2.4：hero 四轮出图迭代，冻结于 26 号图。留下的通用规则：
  ①检查点禁 per-gate 伪状态渲染；②rust 配额极窄（仅"人该看"）；
  ③术语规则成型（禁项目内行话、行业标准词优先 → GOAL & ALIGN /
  ARCH REVIEW / VERIFY，分区头 PLAN / IMPLEMENT / OUTCOME）；
  ④升级出口=rust 实线支线（悬浮注释废）。
- v3–v3.1：header 方案 + 两轮迭代，冻结于 32 号图。轮导航即模式
  （撤 Live/Replay toggle）、三档运行控制、走带与引擎动词图标隔离
  铁律、E-STOP → EMERGENCY STOP 全拼 + 八边形唯一图标（E-SHOP 误读）；
  #206 升格 header 硬前置、#293 立项。
- v4–v4.1：lanes 三方合成 + 两轮迭代，冻结于 37 号图。"卡面只映射
  真实状态"原则（六状态、三处原型虚构拆除）；fixing 卡补最大缺口；
  on hold 裁决（人主动、禁 rust、GitHub 标签执行入口）；w 槽号=显示层
  渲染槽位、issue/PR 双字形、标题内联（#207 升格硬前置）；#294 立项。
- v5：cost strip 方案 + 三方裁决（avg 参照进标注、轮账单行含
  review: external ($0) 明示零、Config ▸ 砍除、幽灵中位刻度）；
  零新引擎前置。文件重组：部件按页面流排序，历史迭代版本浓缩。

## 附录：出图方法论（自 v1 存留，供未来 mockup 轮复用）

- 钉死：画幅比例、每个关心的 hex（附口语描述）、按阅读顺序逐区块
  布局+比例、关键图形的几何描述、字体**处理方式**（不写字体名）、
  必须可读的字符串清单。
- 放开：图标形状、微间距、纹理、条形图精确几何。
- 失败模式规避：文字必然乱码 → 压缩文字面、必读字符串重复强调、其余
  允许模糊占位；别说 "chart" → 直接描述条形；防漂移成纯黑+霓虹 →
  底色说两遍+负面清单；一句话一个概念；关键约束放前 1/3；跑 3–4 seed，
  产出当布局/氛围参考，不当文字来源；语义级约束（禁伪状态、色彩配额）
  写成 NEVER/ONLY 负面句式最有效。
