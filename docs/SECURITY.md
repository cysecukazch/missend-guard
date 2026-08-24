# セキュリティ監査レポート

対象: 誤送信ガード for Gmail（Missend Guard for Gmail）（Chrome 拡張, Manifest V3）
実施日: 2026-08-19 ／ 手法: 全ソース精読 + 多視点の敵対的レビュー（4視点×検証, node で実測再現）

## 脅威モデル

ユーザーが「受信した悪意あるメールに返信」する際、差出人が任意に設定できる
**表示名・メールアドレス・件名（Re:…）・本文引用**が、拡張の処理系（正規表現・
オブジェクトキー・UI 描画）に流入する。これを起点とした XSS・プロトタイプ汚染・
ReDoS・意図しない自動送信・情報漏洩を主眼に点検した。

## 設計レベルで安全と確認した点

- **XSS 耐性**: UI 描画は全経路 `textContent`（`el()`）。`innerHTML`/`insertAdjacentHTML`/
  `document.write` は皆無。SVG アイコンの `d` 属性は固定 enum のみ。攻撃者制御文字列が
  HTML として解釈される経路が存在しない。
- **外部通信ゼロ**: `fetch`/`XMLHttpRequest`/`WebSocket`/`sendBeacon`/`runtime.sendMessage`
  いずれも出荷コードに存在しない（監査で見つかった options.html の dev 用 XHR は撤去）。
- **権限最小**: `permissions` は `storage` のみ。`host_permissions`・`<all_urls>`・`tabs`・
  `webRequest` なし。content script は `mail.google.com` 限定。
  `web_accessible_resources` は `options/options.html`・`help/help.html` の2ページのみを
  `https://mail.google.com/*` に限定公開（ダイアログから設定・ヘルプを開く導線用。実行コードの露出なし）。
- **プロトタイプ汚染 到達不能**: 履歴マップのキーは必ず `@`・`|`・`.` を含むか `t` で始まり、
  メール/ドメインの文字クラス上 `__proto__`/`constructor`/`prototype` 単体キーを生成できない。
  回帰テストで `Object.prototype` 非汚染を固定（test/security.test.mjs）。
- **subjectKey / levenshtein**: 長大入力でも線形（`Re:`×60000 でも約3ms）。ReDoS ではない。

## 発見し修正した問題（すべて対応済み）

| # | 深刻度 | 内容 | 対応 |
|---|---|---|---|
| 1 | Low | メールアドレス正規表現が O(n²)。攻撃者が巨大件名を送る→被害者が返信送信時に `getFromEmail` が `document.title` にフォールバックし数秒フリーズ（64k字で約2.5s） | `parseAddress` に320字クランプ＋量指定子の有界化。`getFromEmail` はクランプ付き共有パーサ経由に変更。実DOM経路で同期ブロック **0ms** を実測確認 |
| 2 | Low | 同正規表現が宛先入力途中テキスト経由でも O(n²)。宛名パース正規表現 `^(.*?)<\s*([^<>]+?)\s*>\s*$` は「`<`＋巨大空白列」で O(n³)（3000字で約5.6s） | 同上のクランプ＋有界量指定子で線形化（64k字→0.1ms）。入力トークン数も200上限に |
| 3 | Low | 確認ダイアログが **open Shadow DOM**。ページ JS や他拡張の content script が `host.shadowRoot.textContent` から、当該メールに含まれない**履歴由来の候補アドレス**を読み取れた | Shadow を **closed** 化。本番では `host.shadowRoot` が null（隔離ワールドのためページ側からテストフラグも立てられない）。実効性を実測確認 |
| 4 | Low | `passThrough`（宛先ゼロ）分岐で `fireSend` 失敗時に `passed` フラグが残留し、次回の本物の送信が全チェックを素通しする | 失敗時に `passed` を取り消すクリーンアップを追加（`send()` と同一処理に統一） |
| 5 | Info | プライバシー表記「ネットワーク通信コードを一切含まない」が options.html の dev 用 XHR と不一致 | dev 用インラインスクリプト（XHR 含む）を撤去。表記が実態と一致 |

いずれも実運用の通常フローでは発火しにくい低リスクだが、公開前に根治した。

## 残存する既知の制限（設計上の受容）

- 予約送信（送信日時を設定）経路は未対応（機能面の制限。セキュリティ問題ではない）。
- content script は Gmail ページと DOM を共有するが、JS は隔離ワールドで分離される。
  グローバル `PSG_*` はページ main world から読めない。

## 回帰テスト

`test/security.test.mjs` に ReDoS 時間上限・クランプ後の正しさ・プロトタイプ非汚染を固定。
全テストが `npm test` で通過（2026-08-24 時点 106 件）。
