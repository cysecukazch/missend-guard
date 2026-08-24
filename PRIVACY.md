# プライバシーポリシー / Privacy Policy

**誤送信ガード for Gmail（Missend Guard）**

## 日本語

本拡張機能は、誤送信防止の判定のために以下のデータを扱います。

- 送信時の宛先メールアドレス・表示名・ドメイン、および送信回数
- 拡張機能の設定値

これらは **ご利用の端末の Chrome 内（`chrome.storage.local`）に保存**され、
開発者および第三者を含むいかなる外部サーバーにも送信されません
（要求する権限は `storage` のみです）。

- メールの本文・件名の文章そのものは、判定のために一時的に読み取るのみで保存しません。
  ただし、宛名不一致の警告を確認して送信した場合は、本文冒頭から抽出した宛名（氏名部分のみ）と
  宛先アドレスの組を「確認済み」として保存します。また、同一スレッドの判定のために、
  件名から算出した復元不能なハッシュ値のみを保存します
- 学習した宛先履歴は、設定画面からいつでも個別に削除（「忘れる」）または全消去できます
- 拡張機能を削除すると、保存データもすべて削除されます

**端末間同期について**: 端末間同期は**初期設定で有効**です。有効な間、学習データ
（宛先アドレス・ドメイン・送信回数・宛先の組み合わせ・確認済み情報・スレッド情報。
**表示名は同期されず、この端末内にのみ保存されます**）は
**ご自身の Google アカウントの Chrome 同期（`chrome.storage.sync`）** にも保存され、
同じアカウントでログインした別のPCと共有されます。これは Chrome 標準の同期機能を
利用するもので、データは Google のインフラ（ユーザー自身のアカウント）を経由します
（ブラウザの Chrome 同期を利用していない場合、データは端末内に留まります）。
**開発者や第三者へ送信されることはありません。** 設定「端末間で同期する」を
OFFにすると、以後データはこの端末内にのみ保存されます。

## English

This extension processes the following data solely to detect potential
misdirected emails:

- Recipient addresses / display names / domains and send counts
- Extension settings

All data is stored **in your browser (`chrome.storage.local`)** and is never
transmitted to any server operated by the developer or any third party (the
only requested permission is `storage`).

- Subject and body text themselves are read transiently for detection and are
  not stored. However, when you confirm a greeting-mismatch warning and send,
  the greeting name extracted from the top of the body (the name part only) is
  stored together with the recipient address as an acknowledgment. For thread
  detection, only an irreversible hash derived from the subject is stored
- Learned recipient history can be individually forgotten or fully erased at
  any time from the options page
- Uninstalling the extension deletes all stored data

**About cross-device sync**: Cross-device sync is **enabled by default**. While
enabled, learned data (recipient addresses, domains, send counts, recipient
combinations, acknowledgments, and thread info — **display names are never
synced and stay only on this device**) is also stored in **your own Google
account's Chrome Sync (`chrome.storage.sync`)** and shared with your other PCs
signed into the same account. This uses Chrome's built-in sync (data passes
through Google's infrastructure under your own account; if your browser's
Chrome sync is not in use, the data stays on this device). It is **never sent
to the developer or any third party.** Turn off "Sync across devices" in the
options to keep data only on this device from then on.

---
Google™ および Gmail™ は Google LLC の商標です。本拡張機能は Google によって
承認・提携されたものではありません。
