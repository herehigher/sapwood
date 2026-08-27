# sapwood

[![CI](https://github.com/herehigher/sapwood/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/herehigher/sapwood/actions/workflows/ci.yml?query=branch%3Amain)
[![npm version](https://img.shields.io/npm/v/sapwood)](https://www.npmjs.com/package/sapwood)
[![node >= 24](https://img.shields.io/badge/node-%E2%89%A524-blue)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.md) · 日本語 · [简体中文](README.zh-CN.md)

本文は README.md（[20b33268](https://github.com/herehigher/sapwood/blob/20b33268/README.md) 時点）の翻訳です。相違がある場合は英語版を正とします。

**自律的なコーディングに、ガバナンスを。**

- issue が入り → レビュー済みの PR が出る。
- producer ≠ reviewer ≠ merger。ガードされた組み込みツールファミリー内ではフェイルクローズ —
  ブランチ保護と別個のマージ担当者アイデンティティがデプロイ時の砦となる（[信頼モデルの前提条件](docs/guide/getting-started.md#trust-model-prerequisites)を参照）。
- sapwood は `sapwood` エンジン CLI を包む Claude Code プラグインバンドル（スラッシュ
  コマンド、スキル、ガードフック）である。プラグインをインストールする（推奨）か、npm
  から CLI 単体を実行する — どちらも完結した経路である。

<!-- source: docs/assets/hero-loop.mmd — regenerate per docs/assets/diagram-style.md -->
![ヒーローループ図](docs/assets/hero-loop.svg)
人間が issue を Ready にサインする。ワーカーが push する一方、フェイルクローズなガードがガードされた組み込みツール内での approve と merge を拒否する（ブランチ保護が最後の砦）。エンジンは PR を開くか採用し、CI と独立レビューをゲートとする — 指摘は修正上限の下でループバックし、収束しない場合は人間に対応を求めて停止する。

## クイックスタート

**要件**

- Node.js ≥ 24
- Claude Code CLI ≥ 2.1.209
- `project` スコープで認証済みの `gh`
- sapwood が動かせる ProjectV2 ボードを持つ GitHub リポジトリ

```
/plugin marketplace add herehigher/sapwood-plugin
/plugin install sapwood@sapwood
```

```yaml
board:
  owner: YOU
  repo: REPOSITORY
  projectNumber: PROJECT_NUMBER
```

```
npx sapwood@<version> validate
npx sapwood@<version> init
npx sapwood@<version> run --dry-run
```

`init` はラベル、ボードレーン、スターターファイル、そして（リポジトリ管理者権限があれば）
デプロイキーを用意する — ベストエフォートかつ冪等。`run --dry-run` は読み取り専用で、何も
書き込まない。

npm のみ: `npm i -g sapwood@alpha` で同じ CLI が使えるが、スラッシュコマンドはない。
プレリリース: 両チャンネルとも最初のタグ付きリリースで公開される。

[インストール](docs/guide/getting-started.md#install) と
[L1 レシピ](docs/guide/getting-started.md#l1--supervise-one-issue) を参照。

## なぜ sapwood か

sapwood は GitHub のバックログを、統治された自律性へと変える。信頼されたリポジトリを
優先し — どのワーカーも自分自身のレビューの鍵を握らない。木における sapwood（辺材）の
ように、生きている縁で育ち、心材へと硬化していく。

## 設計原則

- **producer ≠ reviewer ≠ merger** — ガードされた組み込みツールファミリーに対して
  プラグインが強制する。MCP／ホストの死角は文書化済み。ブランチ保護と別個のマージ
  担当者アイデンティティがデプロイ時の砦となる。
- **GitHub がプロセスの真実である** — ボード／issue／PR／チェックがキューである。
- **フェイルクローズであり、助言的ではない** — ブロックされた操作は拒否されるのであって、
  忠告されるのではない。
- **決定的なエンジン、モデルトークンは思考が必要な区間にのみ使う** —
  オーケストレーションは素の TypeScript である。
- **稀なエッジケースは `needs-human` に縮退し、決して機構を増やさない** — 低確率の
  エッジケースには新しいコードではなく人間が対応する。
- **可読でレジャー照合された支出記録** — 上限はレジャーと照合してチェックされる。決定的
  でないレビュー試行やサブエージェントのファンアウトは、レジャーに記録されないままでも
  よい（[コスト上限](docs/security/cost-ceilings.md)を参照）。

**3 つの真実の情報源:**

- **GitHub** — アクター横断の真実: ボード、ラベル、issue、PR。
- **SQLite** — エンジン自身の行動: ディスパッチ済み、観測済み、消費済み。
- **リポジトリのドキュメント** — 永続的な知識: 今何が真実か。

[永続化](docs/dev-guide/06-persistence.md) を参照。

## 何が違うのか

Claude Code は現在のワーカーランタイムである — sapwood はそれをヘッドレスセッションと
してディスパッチする。sapwood はコーディングエージェントの上に乗るループとガバナンス層
であり、それと競合するものではない。

| sapwood が主張すること | どんなハーネスにも問うべきこと |
| --- | --- |
| マージ権限: producer は決して merge を呼ばない。エンジンの自律マージはマージドライバーを経由する。それ以外は人間 — またはオーナーが明示的に許可したオペレーターセッション — がマージする。 | 誰が merge を呼べるのか、そして producer はそこに到達できるのか？ |
| 強制: ガードされた組み込みツールファミリー内でフェイルクローズ。サンドボックスではない。MCP／ホストの死角は文書化済み。 | どのツール表面が仲介されており、何が野放し（ambient）なのか？ |
| キューと退出: GitHub がプロセスの真実を保持する。痕跡はアンインストールやランナーマシンを超えて残る。 | キューはどこにあり、後に何が残るのか？ |
| 制御フロー: 決定的な TypeScript であり、モデルが決める遷移ではない。 | スケジューリングはコードなのか、それともモデルが言い抜けられるプロンプトなのか？ |
| 中断: ソフトバジェットでの引き継ぎ（再開可能）→ kill switch によるドレイン → 緊急停止（emergency stop）はハードキルし、実行中の WIP を犠牲にする。 | e-stop の際、実行中の作業はどうなるのか？ |

[`docs/security.md`](docs/security.md) を参照。

## アーキテクチャ

<!-- source: docs/assets/architecture.mmd — regenerate per docs/assets/diagram-style.md -->
![アーキテクチャレイヤー](docs/assets/architecture.svg)
GitHub がプロセスの真実を保持する。エンジンはディスパッチとレジャー記録された支出を
オーケストレーションし記録する。ワーカーは push できるが、フェイルクローズなガードが
ガードされた組み込みツール内での approve と merge を拒否する。レビュアーの判定が
merge をゲートする。人間はどの tick でも一時停止、ドレイン、停止ができる。

<!-- source: docs/assets/round-loop.mmd — regenerate per docs/assets/diagram-style.md -->
![ラウンドループ](docs/assets/round-loop.svg)
round はバッチを周辺工程で包んだものである: align、plan、round 予算とレーン上限の下
での execute、harvest、そして提案しかできない retro — それは人間がマージする PR を
通じて行われる。

ラウンドフェーズ: `aligning → architecting → plan_review → executing →
harvesting → retro → closed`。デフォルトのボードレーン: `Todo → Ready → In
Progress → Done`（名前は設定可能）。詳細:
[05](docs/dev-guide/05-core-modules.md) ·
[06](docs/dev-guide/06-persistence.md) ·
[ウォークスルー](docs/reference/loop-walkthrough.md)。

## 自律レベル

数値が低いほど安全で人間の労力が多く、高いほど自律的になる。

| レベル | 無人動作 | マージ | 監視 | 引き上げるには |
| --- | --- | --- | --- | --- |
| [L0 — 観察](docs/guide/getting-started.md#l0--observe) | なし — 読み取り専用 | 該当なし | — | L1 へ移行（単一 issue） |
| [L1 — 1 件の issue を監督](docs/guide/getting-started.md#l1--supervise-one-issue) | claim、push、PR を開く、レビュー（issue 1 件） | 人間 | 人間 | round driver を復元、人間がマージ |
| [L2 — 作業を委譲、マージ権は保持](docs/guide/getting-started.md#l2--delegate-work-keep-merge) | フルラウンド、レーン上限あり | 人間 | 人間 | review／CI を信頼し、マージモードを切り替える |
| [L3 — 統治された無人マージ](docs/guide/getting-started.md#l3--governed-unattended-merge) | フルラウンド、ゲート付きマージ | Conductor | 人間 | LLM ウォッチャーを追加 |
| L4 — LLM 監督下での実行 | フルラウンド、ゲート付きマージ（L3 と同様） | Conductor（または明示的に許可されたスーパーバイザー） | LLM | ラダーの頂点 |

L4 は L3 のエンジン権限を保持したまま、信頼された LLM スーパーバイザーを追加する。
そのスコープは監視、記録、催促、pause／kill switch の作動、そして理由付きでの
breaker park の解除であり — デフォルトでは merge を裁定することは決してない。オー
ナーはセッション開始時の明示的な許可によってそれを拡張できる。
`sapwood:human-merge-only` の PR は人間の判断のままである — エンジンのマージ
経路に対しては構造的に、許可されたオペレーターセッションに対してはポリシーとして
（[ガバナンスライン](docs/guide/supervision.md#governance-lines)を参照）。

人間による制御（pause／kill switch／e-stop）はすべてのレベルに適用される
（[人間による制御](docs/security.md#human-controls-three-tiers)）。L3／L4 には
[信頼モデルの前提条件](docs/guide/getting-started.md#trust-model-prerequisites)
が必要である。

## ステータス

main に実装済み、プレリリース: engine、guard、round オーケストレーター、
dashboard。リリースチェーン（catalog、npm publish）は進行中。
[CHANGELOG.md](CHANGELOG.md) の「Unreleased」と
[PLAN.md「Current milestone」](docs/PLAN.md#current-milestone) を参照。

## ドキュメント

- [`getting-started.md`](docs/guide/getting-started.md) — インストール、
  `sapwood init`、自律性のラダー。
- [`security.md`](docs/security.md) — 信頼／ガバナンスモデル。
- [`docs/README.md`](docs/README.md) — ドキュメントマップ。
- [`dev-guide/README.md`](docs/dev-guide/README.md) — コントリビューター向けツアー。

## 謝辞

着想を得たもの:

- [walkinglabs/learn-harness-engineering](https://github.com/walkinglabs/learn-harness-engineering) — ハーネスエンジニアリングに関するプロジェクトベースのコース: コーディングエージェントを信頼できるものにする環境、状態、検証、制御の仕組み。
- [alchaincyf/loop-engineering-orange-book](https://github.com/alchaincyf/loop-engineering-orange-book) — ループエンジニアリングに関する無料の中国語ガイド（橙皮书）: アーキテクチャ、コスト、実世界のエージェントループ;「エージェントに代わってプロンプトを出すシステムを設計せよ」。
- [cobusgreyling/loop-engineering](https://github.com/cobusgreyling/loop-engineering) — コーディングエージェントを取り巻く制御ループを設計するためのパターン、スターター、CLI（「プロンプトをやめ、ループを設計せよ」）。
- [@AnatoliKopadze — what a loop is](https://x.com/AnatoliKopadze/status/2068328135611822149) — 反復をループへと変える 3 要素としての検証・状態・停止条件；あるタスクにループを与えるべきかどうかを判定する 4 条件テスト。
- [@0xCodez — from prompter to loop designer](https://x.com/0xCodez/status/2064374643729773029) — 14 ステップのロードマップ: ループが元を取れるのはいつか、5 つの構成要素、そして merge や deploy の前の人間によるゲート。
- [@0xCodez — graph engineering](https://x.com/0xCodez/status/2079165300625330317) — 線形のエージェントチェーンからグラフへの 14 ステップのロードマップ: 契約を持つノード、データとしてのエッジ、サブエージェント群にまたがる fan-out／verify／converge。

これらはこの技芸に示唆を与えるものであり — 方法論的な先行研究であって、sapwood の
カテゴリーラベルではない。

## Contributing · Security · License

[CONTRIBUTING.md](CONTRIBUTING.md)（ワークフロー）と
[docs/dev-guide/](docs/dev-guide/README.md)（ツアー）を参照。セキュリティ:
[SECURITY.md](SECURITY.md)。

[MIT](LICENSE)。

メンテナ: [@kanhigher](https://x.com/kanhigher) — 質問やバグ報告は
[issues](https://github.com/herehigher/sapwood/issues) へ。
