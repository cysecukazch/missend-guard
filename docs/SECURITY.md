# セキュリティノート

対象: 誤送信ガード for Gmail（Missend Guard for Gmail）（Chrome 拡張, Manifest V3）
全ソースを精読し、多視点の敵対的セルフレビューで安全性を点検した記録です（node で実測再現）。

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

## 公開前のハードニング

公開前の内部レビューで洗い出した軽微な点（長大入力に対する処理時間の上限化、確認ダイアログの Shadow DOM を closed 化した分離強化、フェイルセーフ経路の整理、プライバシー表記と実装の突合など）はすべて修正し、回帰テストで固定しています。実運用の通常フローに影響する問題は確認されていません。

## 残存する既知の制限（設計上の受容）

- 予約送信（送信日時を設定）経路は未対応（機能面の制限。セキュリティ問題ではない）。
- content script は Gmail ページと DOM を共有するが、JS は隔離ワールドで分離される。
  グローバル `PSG_*` はページ main world から読めない。

## 回帰テスト

`test/security.test.mjs` に ReDoS 時間上限・クランプ後の正しさ・プロトタイプ非汚染を固定。
全テストが `npm test` で通過（2026-08-24 時点 106 件）。
