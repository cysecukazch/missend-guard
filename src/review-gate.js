/**
 * review-gate.js — レビューのお願い（トースト）の表示条件。
 *
 * 原則: この拡張の約束は「静かで、いつもは邪魔しない」。レビュー依頼も同じ原則に従う。
 *   - 出すのは「価値を実感できているはず」の利用者だけ（十分な利用実績 + 確認ダイアログを
 *     実際に通過した経験がある）
 *   - 出す瞬間は「異常なしの素通し送信の直後」だけ。送信をキャンセルした瞬間や
 *     確認ダイアログの最中には決して出さない（お試しでキャンセルした人にも出ない）
 *   - キャンセル直後はしばらく出さない（危険を回避した直後・お試し操作の直後を避ける）
 *   - 表示は生涯最大2回。ボタンを1回でも操作したら（「今後表示しない」を含め）二度と出ない
 *
 * 判定は純関数（shouldShow）。DOM・chrome API に依存せず、node で単体テストできる。
 */
(function (root) {
    'use strict';

    const DAY = 24 * 60 * 60 * 1000;

    const CONFIG = {
        minSends: 20,             // 累計送信がこの回数以上（お試し利用を除外）
        minDialogSends: 1,        // 確認ダイアログを通過した送信がこの回数以上（価値の実感）
        minAgeDays: 7,            // 導入からこの日数以上
        cancelCooldownMs: 30 * 60 * 1000, // ダイアログをキャンセルした後、この時間は出さない
        retryAfterDays: 14,       // 無操作で消えた場合の再表示は、この日数以上あけて1回だけ
        maxShows: 2,              // 生涯の最大表示回数（操作の有無によらず）
        showDelayMs: 3200,        // 素通しトースト(約2.6s)が消えてから出す
        autoHideMs: 15000         // 無操作なら自動で消える
    };

    /** 既定のレビュー状態（history-store の EMPTY にもこの形で入る） */
    const EMPTY_STATE = () => ({ installTs: 0, state: 'none', shownCount: 0, lastShownTs: 0, lastCancelTs: 0 });

    /**
     * レビュートーストを出してよいか。
     * @param now    現在時刻 (epoch ms)
     * @param db     履歴 DB（stats.sends / stats.dialogs / review を参照）
     * @param ctx    直前の状況:
     *   - anomalies:    今回の送信の異常件数（0 のときだけ許可）
     *   - strictMode:   厳格モード（毎回確認を選んだ人には出さない）
     *   - showToast:    通知オフの人には出さない（静かさの希望を尊重）
     *   - busy:         確認ダイアログ表示中は出さない
     *   - lastCancelTs: 直近でダイアログをキャンセルした時刻（0 なら無し）
     */
    function shouldShow(now, db, ctx) {
        const stats = (db && db.stats) || {};
        const review = Object.assign(EMPTY_STATE(), db && db.review);
        const c = ctx || {};

        // --- 瞬間の条件: 「静かな成功」の直後だけ ---
        if (c.anomalies > 0) return false;                    // 異常があった送信の後には出さない
        if (c.strictMode) return false;                       // 毎回確認派には出さない
        if (c.showToast === false) return false;              // 通知を切っている人には出さない
        if (c.busy) return false;                             // ダイアログ表示中は出さない
        // キャンセル時刻は「このタブのメモリ値」と「storage 永続値（別タブ・リロード後も共有）」の新しい方
        const cancelTs = Math.max(c.lastCancelTs || 0, review.lastCancelTs || 0);
        if (cancelTs && now - cancelTs < CONFIG.cancelCooldownMs) return false;

        // --- 実績の条件: 価値を実感できているはずの人だけ ---
        if ((stats.sends || 0) < CONFIG.minSends) return false;
        if ((stats.dialogs || 0) < CONFIG.minDialogSends) return false;
        if (!review.installTs || now - review.installTs < CONFIG.minAgeDays * DAY) return false;

        // --- 頻度の条件: 最大2回・操作済みなら二度と出さない ---
        if (review.state === 'done') return false;
        if (review.shownCount >= CONFIG.maxShows) return false;
        if (review.shownCount > 0 && now - review.lastShownTs < CONFIG.retryAfterDays * DAY) return false;

        return true;
    }

    /** レビュー・フィードバックの行き先 URL（開くだけ。データ送信はしない） */
    function urls() {
        let review = '';
        try {
            const id = chrome.runtime && chrome.runtime.id;
            if (id) review = 'https://chromewebstore.google.com/detail/' + id + '/reviews';
        } catch (e) { /* テスト環境では chrome が無い */ }
        return { review, feedback: 'https://github.com/cysecukazch/missend-guard/issues' };
    }

    const ReviewGate = { CONFIG, EMPTY_STATE, shouldShow, urls };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = ReviewGate; // Node (単体テスト)
    }
    root.PSG_ReviewGate = ReviewGate; // ブラウザ (content script)
})(typeof globalThis !== 'undefined' ? globalThis : this);
