/**
 * content.js — 送信操作の横取りと全体の制御。
 *
 * 既存拡張（送信ボタンを隠して偽ボタンを置く方式）の弱点への対策:
 *   - Ctrl/⌘+Enter のキーボード送信もすり抜けない（capture 段階で横取り）
 *   - Gmail の DOM を改変しない（クラス名変更に強く、壊れても Gmail 自体は無傷）
 *   - 「送信してアーカイブ」ボタンにも対応
 *
 * イベントは window の capture 段階で最初に受け取るため、Gmail 側の
 * リスナー登録順に関係なく必ず先行できる。
 */
(function () {
    'use strict';

    const RE = globalThis.PSG_RiskEngine;
    const Dom = globalThis.PSG_GmailDom;
    const Store = globalThis.PSG_Store;
    const UI = globalThis.PSG_UI;

    /** チェック通過済みのコンポーズ（次の 1 回の送信操作を素通しさせる） */
    const passed = new WeakSet();
    /** 判定処理中のコンポーズ（storage 読込の await 中に来る連打を同期的に弾く） */
    const inFlight = new WeakSet();
    let busy = false; // ダイアログ表示中
    let busyWatchdog = 0;
    function clearBusyWatchdog() { if (busyWatchdog) { clearTimeout(busyWatchdog); busyWatchdog = 0; } }

    /** 実際に Gmail の送信を発火させる */
    function fireSend(sendBtn) {
        if (!sendBtn || !sendBtn.isConnected) return false;
        const opts = { bubbles: true, cancelable: true, composed: true, view: window };
        sendBtn.dispatchEvent(new MouseEvent('mousedown', opts));
        sendBtn.dispatchEvent(new MouseEvent('mouseup', opts));
        sendBtn.click();
        return true;
    }

    /** 送信意図を検出したときの本体処理 */
    async function onSendIntent(compose, sendBtn, ev) {
        // 通過済みフラグの消費（send() からのプログラム的クリック）を最優先で判定する
        if (passed.has(compose)) {
            passed.delete(compose);
            return;
        }

        // ダイアログ表示中、または storage 読込中の連打（クリック/Ctrl+Enter）は
        // 二重送信・二重記録になるため同期的に弾く
        if (busy || inFlight.has(compose)) {
            ev.preventDefault();
            ev.stopPropagation();
            return;
        }
        inFlight.add(compose);

        ev.preventDefault();
        ev.stopPropagation();

        try {
            const mail = Dom.readMail(compose);
            const db = await Store.getHistory();
            const settings = await Store.getSettings();
            const result = RE.analyze(mail, db, settings);

            // 宛先ゼロ: Gmail 自身のエラー表示に任せる
            if (result.passThrough) {
                passed.add(compose);
                // 送信を発火できなければ passed を必ず取り消す（フラグ残留で
                // 次回の本物の送信が無確認で素通しするのを防ぐ）
                if (!fireSend(sendBtn)) {
                    const btn = Dom.findSendButton(compose);
                    if (btn) fireSend(btn); else passed.delete(compose);
                }
                return;
            }

            // 宛先が読めなかった場合のフェイルセーフ:
            // チップは無いのに Gmail は送れてしまう、という事態を避けるため確認を挟む
            if (result.recipients.length === 0) {
                result.anomalies.push({ type: 'read_failed', params: [] });
            }

            const send = () => {
                passed.add(compose);
                if (!fireSend(sendBtn)) {
                    // ボタンが消えていた場合は探し直す
                    const btn = Dom.findSendButton(compose);
                    if (btn) fireSend(btn); else passed.delete(compose);
                }
                if (settings.learnEnabled) {
                    Store.recordSend(result.learn, result.anomalies.length > 0);
                }
            };

            // 異常なし（かつ厳格モードでない）→ 素通し + さりげない通知
            // 宛先を通知に表示して「最後の目視」の機会を残す（クリックは不要）
            if (result.anomalies.length === 0 && !settings.strictMode) {
                send();
                if (settings.showToast !== false) {
                    const first = result.recipients[0];
                    const extra = result.recipients.length - 1;
                    UI.toast(extra > 0
                        ? UI.msg('toastOkMore', [first.email, String(extra)])
                        : UI.msg('toastOkTo', [first.email]));
                }
                return;
            }

            // 異常あり or 厳格モード → 確認ダイアログ
            // 描画で例外が起きても全コンポーズの送信が恒久ロックしないよう保護する
            busy = true;
            clearBusyWatchdog();
            busyWatchdog = setTimeout(() => { busy = false; }, 5 * 60 * 1000); // 最終手段の解除
            try {
                UI.openDialog({
                    anomalies: result.anomalies,
                    recipients: result.recipients,
                    mail,
                    sends: (db.stats && db.stats.sends) || 0,
                    learnEnabled: settings.learnEnabled,
                    onSend: () => { busy = false; clearBusyWatchdog(); send(); },
                    onCancel: () => { busy = false; clearBusyWatchdog(); }
                });
            } catch (e) {
                // ダイアログを出せなかった → ロックせず通常送信にフォールバック
                busy = false; clearBusyWatchdog();
                send();
            }
        } finally {
            inFlight.delete(compose);
        }
    }

    /* ------------------------------------------------------------------ */
    /* イベント横取り                                                       */
    /* ------------------------------------------------------------------ */

    window.addEventListener('click', (ev) => {
        const btn = Dom.asSendButton(ev.target);
        if (!btn) return;
        const compose = Dom.findCompose(btn);
        if (!compose) return;
        onSendIntent(compose, btn, ev);
    }, true);

    window.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' || !(ev.ctrlKey || ev.metaKey)) return;
        if (ev.isComposing) return; // IME 変換中の Enter は送信ショートカットではない
        const compose = Dom.findCompose(ev.target);
        if (!compose) return;
        const btn = Dom.findSendButton(compose);
        if (!btn) return; // 送信ボタンが見つからない画面ではキーも素通し
        onSendIntent(compose, btn, ev);
    }, true);
})();
