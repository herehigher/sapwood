# Dashboard 成品预期图 — v2（部件分解阶段 · hero board）

本地工作文件，不提交。v1（整页提示词+首轮出图）见 `dashboard-mockup-prompt-v1.md`。
本轮起改为**分部件设计、最后融合**，首个部件 = hero board。

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

# Header 部件（v3 · 方案定稿待用户确认）

前提裁决（用户，2026-07-21）：**顶部不设 Live/Replay 切换**——看最新轮≈live，
看历史轮=replay。与 §11"replay 单位是轮"同构；是对 §3 A 的正式修订（记档）。

## 元素方案（PM + 架构师 + 架空用户三方合成）

| # | 元素 | 设计 | 数据依据 / 边界 |
|---|---|---|---|
| 1 | 引擎状态词 + 静点 | 词是主角，点是标点（**点不做动画**——hero 已在呼吸）。显示词收敛：running / waiting（=standby+park 合并，park 加小字副注）/ paused / stopping（=winding-down+stopping 合并）/ stopped，异常态 **stalled**（rust）。全称进 tooltip | 哨兵文件+events+staleness 推导，**服务端算**（CLI 与面板永不打架）。先例修订：**staleness 压过 PAUSE**（死引擎+PAUSE 文件显示 stalled，不是 paused）——§8 与 walkthrough §6 矛盾的裁决 |
| 2 | **轮导航**（模式载体） | `◂ [round 12] ▸` 步进器；**最右永远是 LIVE 槽**：有开轮显 "LIVE · round 12 · executing"，无开轮显 "LIVE · waiting/stopped"（live 是一个可导航到的位置，空轮情形有定义）。点击轮号弹列表：每行 = 轮号 · 日期 · PR 数 · 花费 · 已关轮行首 **▶ 字形**（可回放性一眼可读，列表兼作 history ledger）。不在 LIVE 位时，**"◂ back to live" 常显** | `rounds` 表为脊柱 + `round_artifacts` left-join 终局三数（无 artifact 的轮如实无 tally）——§8 /api/rounds 修订项。`◂` hover tooltip = "replay round 11"（无模式开关下的可发现性） |
| 3 | 回放走带（条件性） | 仅历史轮渲染：play/pause · 一个速度循环钮（×1/×4/×16）· scrub "event 12/33"；同时 header 持续显示 **"ROUND 9 · CLOSED" 染色徽章**（40 秒后也不忘身处历史）。功能就此打住（无逐帧/AB 区间/花式倍速） | 游标=events.id，章节窗=rounds 的 id cursors，纯客户端折叠。**铁律：走带与引擎动词永不共享位置与图标语言**（走带=媒体图标、左侧下沉条；引擎动词=文字按钮、右上）——本轮走查唯一"真实事故级"发现 |
| 4 | 花费仪表 | `$10.4 ▓▓▓░ +$2.2 est / $100`：实付实心+估算斜纹，run 层为主；**日限额收 hover，用量 ≥75% 自动浮出示警**。历史轮：截至游标、纯实付无 est 段、"today" 副读数隐藏 | 四个数：日和(有)/日限(config)/run 和(**引擎内存 anchor 未持久化——见依赖**)/run 限(optional)。无 run 限→整表落日层（§3 A 既有路径）；config 不可读→只分子不造分母 |
| 5 | 运行控制（三档） | header 右端，**文字小按钮**：**PAUSE**（温和：不再派新活，在飞的干完）/ **STOP**（drain-first：kill-switch + 排水窗内收尾，超时才硬停）/ **E-STOP**（急停：立即硬停一切，rust 红、视觉隔离在最右）。合法动词才显示（resume 仅 paused 态…）；两步确认；STOP 长按 arm 且**松手=取消**；E-STOP 双保险（长按 arm + 确认弹层写明后果"in-flight work is killed, WIP may be lost"）。**看历史轮时整组隐藏**（对过去无可操作——模式纯净律用在写路径上），配 "back to live" 跳回 | POST /api/control 哨兵写；`dashboard.controls` 键 gate（#210 未落地）。**E-STOP 需引擎新增信号**（现有 kill-switch 必排水后杀；急停=跳过排水立即硬杀，additive，实施时立引擎 issue）。进程已死时 Start 钮翻转为 CLI 启动命令展示 |
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

## PROMPT — header 部件 · dark "autumn"（双态对照图）

Two horizontal dashboard header bars stacked vertically with a small gap on one dark canvas, wide 16:5 landscape, flat modern web app UI, crisp vector look, no browser chrome, no perspective, no photograph. Top bar = LIVE state, bottom bar = HISTORY state of the SAME header. This is one component of a larger dashboard.

PALETTE (autumn, warm): canvas warm dark brown #251B10 — NOT black; bar surfaces slightly lighter brown #2E2317 with hairline 1px borders #8A7A64; primary text warm cream #F1E7D2; amber #E8A33D for activity; rust orange #C05A2E strictly reserved for the E-STOP button and human-related marks. No neon, no purple, no gradients, no glow, no shadows. All text tiny monospace or tiny uppercase letterspaced; nothing animated-looking, everything still and calm.

TOP BAR — LIVE state, left to right:
(1) a small static green dot + the word "running";
(2) round navigator: a left chevron "◂", then a quiet pill "ROUND 12 · LIVE", then a right chevron "▸" rendered dimmed/disabled;
(3) center-right: a thin horizontal budget meter — solid amber segment, then a short hatched translucent amber tail, then empty track — captioned "$10.4 + $2.2 est / $100";
(4) right end: two small hairline text buttons "PAUSE" and "STOP" side by side, then a clear gap, then one rust-outlined text button "E-STOP" visually isolated at the far right;
(5) a tiny hairline circle "?" button after the controls.

BOTTOM BAR — HISTORY state of the same header, left to right:
(1) the same static green dot + "running" (the engine is still alive);
(2) round navigator now shows "◂ ROUND 9 · CLOSED ▸" with a subtle amber-tinted badge, plus a small solid button "▸▸ BACK TO LIVE";
(3) below-left inside the bar: a slim replay transport — a play triangle, a speed chip "×4", and a thin scrub line with a position dot captioned "event 12/33" — drawn with MEDIA-style icons, clearly different shape language from the text buttons above;
(4) the budget meter shows a solid-only amber segment captioned "$6.2 of this round" — no hatched tail in history;
(5) NO PAUSE/STOP/E-STOP buttons anywhere on this bar — the right end is empty except the "?" button.

Only these strings must be legible: "running", "ROUND 12 · LIVE", "ROUND 9 · CLOSED", "BACK TO LIVE", "$10.4 + $2.2 est / $100", "PAUSE", "STOP", "E-STOP", "×4", "event 12/33". All other text may be soft unreadable placeholder lines.

Mood: quiet instrument panel, autumn heartwood, warm firelit browns. The two bars must read instantly as the same component in two modes: live = controls present + est tail; history = transport present + controls gone.

## PROMPT — header 部件 · light "spring"（变体，仅换调色）

Same two-bar layout, light "spring" theme: canvas warm cream nudged slightly toward pale green #F1F0E2 — NOT white, NOT saturated green; bar surfaces one step greener #E9EAD6; primary text dark heartwood brown #251B10; hairlines #8A7A64; activity accent deep amber #8A5A14; E-STOP and human marks #A34620. Mood: early spring on warm paper.

## Header 审评清单

1. 双态一眼可辨：live 有控制无走带，history 有走带无控制？
2. E-STOP 与 PAUSE/STOP 之间有视觉断层，且是 rust 色、全图唯一 rust？
3. 走带是媒体图标语言（▶/×4/scrub 线），与文字按钮形状语言明显不同、位置不同？
4. est 斜纹尾只出现在 live 态；history 态是纯实付实心段？
5. "ROUND 9 · CLOSED" 徽章醒目（不会看着看着忘了在历史）？"BACK TO LIVE" 存在？
6. 状态词是主角，色点是静止小标点（无光晕无动画感）？
7. 右箭头在 LIVE 位处于灰态（已在最右，无更新一轮可去）？
8. 无 Live/Replay 切换开关残留？无 wordmark/config（它们在侧栏）？

## 变更记录

- v2（2026-07-21）：转部件分解流程；记录 round-1 三条用户裁决；
  三方合成 hero board 元素清单；开放问题 1/2 用户确认采纳；
  hero board 单部件出图提示词（dark 主版 + spring 奶油微绿变体）起草完成。
- v2.1（2026-07-21）：hero dark 首轮出图评审（6/9 过）。骨架采纳；修五处：
  ①检查点禁止绿✓/红‼分步状态渲染（伪造 per-gate 进度）→ 同款中性细线圆；
  ②fixing 水滴归 amber（rust 仅限"人该看"，全图 rust 元素限两处）；
  ③年轮去粗边框/箭头，细密木纹填满盘面；④轮终局改本轮小数字
  "5 merged · 3 pending · 1 needs human"，不与累计 24 重复；
  ⑤w3 水滴停检查点旁、PLANNING 不缩写、ESCALATE → NEEDS A HUMAN。
- v2.2（2026-07-21）：第二轮出图评审——以 17 号图为基准骨架（16 丢
  REVIEWERS 标注、检查点图标又赋了各自语义）。用户修订：①backlog 收窄
  至与规划列同宽，ready 数入标题括号，玻片列表候选/入围高亮区分；
  ②术语原则澄清（禁项目内行话、行业标准词优先），规划三节点改名
  GOAL PLAN & ALIGN / ARCH PLAN & REVIEW / VERIFY PLAN & APPROVAL；
  残留修正：w3 水滴须紧贴 CHECKS 左侧、三个分区标注必须齐全。
- v2.3（2026-07-21）：第三轮出图评审，用户四条修订：①backlog 入围玻片
  上浮到列首（选中块在前、候选在后）；②分区头改阶段词
  PLAN / IMPLEMENT / OUTCOME（角色词 producers/reviewers/mergers 移交
  hover/图例层，治理分离由几何承担）；③规划三节点缩短为
  GOAL & ALIGN / ARCH REVIEW / VERIFY；④检查点与规划列同款式——
  圆内 icon、圆外文字，CHECKS 改名 CI（识别性 icon，仍禁状态渲染）。
- v2.4（2026-07-21）：第四轮评审（24/25 号图已近预期）。升级出口重做：
  悬浮 "NEEDS A HUMAN"+虚线箭头+w3 感叹钉 → 一条 rust **实线支线**从
  CI/REVIEW 连接处向下长出（与 work lane 同款笔触），末端细线圆+人形
  icon+圆外 "NEEDS HUMAN"（对齐 needs-human label，修 "need human" 语法）；
  PR #99 水滴搬到支线上；CI/REVIEW 整体稍上移。rust 配额=仅此支线。
  追加：OUTCOME 区年轮下两节点补文字标注 SUMMARY / RETRO（同款式：
  圆内 icon、圆外文字；retro 为行业标准词，合术语原则）。
- v3（2026-07-21）：hero 冻结（26 号图）。header 三方合成方案落定：
  轮导航即模式（撤 Live/Replay toggle）、LIVE 常驻槽位、当前轮 v0.2
  不可回拖、三档运行控制（PAUSE/STOP/E-STOP，E-STOP→#293）、
  走带与引擎动词不共位置/图标语言铁律、#206 升格 header 硬前置。
  kill-switch 行为经代码核查确认 drain-first。header 双态对照出图
  提示词（dark 主版 + spring 变体）+ 8 项审评清单起草完成。
  工作区迁至 worktree design/dashboard-mockups，文件归位 docs/design/。
