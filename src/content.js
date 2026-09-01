/**
 * content.js — 送信操作の横取りと全体の制御。
 *
 * 誤送信の取りこぼしを防ぐための設計方針:
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
    const Gate = globalThis.PSG_ReviewGate;

    /** チェック通過済みのコンポーズ（次の 1 回の送信操作を素通しさせる） */
    const passed = new WeakSet();
    /** 判定処理中のコンポーズ（storage 読込の await 中に来る連打を同期的に弾く） */
    const inFlight = new WeakSet();
    let busy = false; // ダイアログ表示中
    let busyWatchdog = 0;
    function clearBusyWatchdog() { if (busyWatchdog) { clearTimeout(busyWatchdog); busyWatchdog = 0; } }
    /** 直近でダイアログをキャンセルした時刻（レビューのお願いをその直後に出さないため） */
    let lastCancelTs = 0;

    /**
     * レビューのお願い（src/review-gate.js の条件を満たすときだけ・生涯最大2回）。
     * 「異常なしの素通し送信」の直後にのみ呼ばれる。素通しトーストが消えてから、
     * 最新の状態で再判定して表示する。失敗しても送信フローには影響させない。
     */
    function maybeAskReview(settings) {
        if (!Gate || !UI.reviewToast || !Store.markReviewShown) return;
        setTimeout(async () => {
            try {
                const db = await Store.getHistory();
                const ok = Gate.shouldShow(Date.now(), db, {
                    anomalies: 0,
                    strictMode: settings.strictMode,
                    showToast: settings.showToast,
                    busy,
                    lastCancelTs
                });
                if (!ok) return;
                await Store.markReviewShown(); // 表示した時点で回数を消費（最大2回）
                const urls = Gate.urls();
                UI.reviewToast({
                    autoHideMs: Gate.CONFIG.autoHideMs,
                    // 1段目（はい/いまいち）を押した時点で確定（以後は出さない）。
                    // 2段目を操作せずタブを閉じても「無操作」扱いで再表示されることがないように
                    onEngage: () => Store.markReviewDone(),
                    onAction: (kind) => {
                        Store.markReviewDone(); // どの操作でも以後は出さない
                        if (kind === 'rate' && urls.review) window.open(urls.review, '_blank', 'noopener');
                        else if (kind === 'feedback') window.open(urls.feedback, '_blank', 'noopener');
                    }
                });
            } catch (e) { /* レビュー導線の不具合が送信体験に影響しないよう握りつぶす */ }
        }, Gate.CONFIG.showDelayMs);
    }

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
                maybeAskReview(settings);
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
                    onCancel: () => {
                        busy = false; clearBusyWatchdog();
                        lastCancelTs = Date.now(); // このタブでは即時反映
                        // 別タブ・リロード後にもクールダウンが効くよう storage にも記録
                        if (Store.markReviewCanceled) Store.markReviewCanceled();
                    }
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
