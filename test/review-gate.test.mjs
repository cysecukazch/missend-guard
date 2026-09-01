/**
 * レビューのお願い（review-gate）の表示条件テスト。
 * 「お試しでキャンセルした人」「まだ価値を実感していない人」に出ないこと、
 * 生涯最大2回・操作後は二度と出ないことを境界値で固定する。
 * 実行: node --test test/review-gate.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RG = require('../src/review-gate.js');

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const NOW = 1_750_000_000_000; // 固定の現在時刻

/** すべての条件を満たす既定のDB（各テストで一部だけ崩す） */
function db(over = {}) {
    return {
        stats: Object.assign({ sends: 50, dialogs: 3, autoPass: 47 }, over.stats),
        review: Object.assign(
            { installTs: NOW - 30 * DAY, state: 'none', shownCount: 0, lastShownTs: 0 },
            over.review)
    };
}
/** 「異常なしの素通し送信の直後」という既定の状況 */
function ctx(over = {}) {
    return Object.assign(
        { anomalies: 0, strictMode: false, showToast: true, busy: false, lastCancelTs: 0 },
        over);
}

test('全条件を満たせば表示する', () => {
    assert.equal(RG.shouldShow(NOW, db(), ctx()), true);
});

/* --- 実績の条件 --- */

test('累計送信の境界: 19回は出ない・20回で出る', () => {
    assert.equal(RG.shouldShow(NOW, db({ stats: { sends: 19, dialogs: 3 } }), ctx()), false);
    assert.equal(RG.shouldShow(NOW, db({ stats: { sends: 20, dialogs: 3 } }), ctx()), true);
});

test('確認ダイアログを一度も通過していなければ出ない（価値が実証されていない）: 0回は出ない・1回で出る', () => {
    assert.equal(RG.shouldShow(NOW, db({ stats: { sends: 100, dialogs: 0 } }), ctx()), false);
    assert.equal(RG.shouldShow(NOW, db({ stats: { sends: 100, dialogs: 1 } }), ctx()), true);
});

test('導入日数の境界: 7日未満は出ない・7日ちょうどで出る', () => {
    assert.equal(RG.shouldShow(NOW, db({ review: { installTs: NOW - 7 * DAY + MIN } }), ctx()), false);
    assert.equal(RG.shouldShow(NOW, db({ review: { installTs: NOW - 7 * DAY } }), ctx()), true);
});

test('旧バージョンからの移行直後（installTs 未記録）は出ない（安全側）', () => {
    assert.equal(RG.shouldShow(NOW, db({ review: { installTs: 0 } }), ctx()), false);
    assert.equal(RG.shouldShow(NOW, { stats: { sends: 50, dialogs: 3 } }, ctx()), false); // review 自体が無いDB
});

/* --- 瞬間の条件（「役に立ったタイミング」の厳密化） --- */

test('キャンセル直後は出ない（お試し操作・危険回避直後を避ける）: 30分の境界', () => {
    assert.equal(RG.shouldShow(NOW, db(), ctx({ lastCancelTs: NOW - 29 * MIN })), false);
    assert.equal(RG.shouldShow(NOW, db(), ctx({ lastCancelTs: NOW - 30 * MIN })), true); // 30分ちょうどで解除
    assert.equal(RG.shouldShow(NOW, db(), ctx({ lastCancelTs: NOW - 31 * MIN })), true);
});

test('キャンセルの記録は storage 経由（別タブ・リロード後）でも効く', () => {
    // このタブのメモリ値は 0 でも、db.review.lastCancelTs にキャンセルが残っていれば出ない
    const canceled = db({ review: { installTs: NOW - 30 * DAY, lastCancelTs: NOW - 10 * MIN } });
    assert.equal(RG.shouldShow(NOW, canceled, ctx({ lastCancelTs: 0 })), false);
    // メモリ値と storage 値の新しい方が使われる
    const oldStorage = db({ review: { installTs: NOW - 30 * DAY, lastCancelTs: NOW - 60 * MIN } });
    assert.equal(RG.shouldShow(NOW, oldStorage, ctx({ lastCancelTs: NOW - 5 * MIN })), false);
    assert.equal(RG.shouldShow(NOW, oldStorage, ctx({ lastCancelTs: 0 })), true); // 両方古ければ出る
});

test('異常があった送信の後には出ない', () => {
    assert.equal(RG.shouldShow(NOW, db(), ctx({ anomalies: 1 })), false);
});

test('ダイアログ表示中は出ない', () => {
    assert.equal(RG.shouldShow(NOW, db(), ctx({ busy: true })), false);
});

test('厳格モード（毎回確認派）には出ない', () => {
    assert.equal(RG.shouldShow(NOW, db(), ctx({ strictMode: true })), false);
});

test('通知をオフにしている人には出ない（静かさの希望を尊重）', () => {
    assert.equal(RG.shouldShow(NOW, db(), ctx({ showToast: false })), false);
});

/* --- 頻度の条件 --- */

test('操作済み（state=done）なら二度と出ない', () => {
    assert.equal(RG.shouldShow(NOW, db({ review: { installTs: NOW - 30 * DAY, state: 'done' } }), ctx()), false);
});

test('無操作1回のあとの再表示: 14日未満は出ない・14日ちょうどから出る', () => {
    const shown13d = db({ review: { installTs: NOW - 60 * DAY, shownCount: 1, lastShownTs: NOW - 13 * DAY } });
    const shown14d = db({ review: { installTs: NOW - 60 * DAY, shownCount: 1, lastShownTs: NOW - 14 * DAY } });
    const shown15d = db({ review: { installTs: NOW - 60 * DAY, shownCount: 1, lastShownTs: NOW - 15 * DAY } });
    assert.equal(RG.shouldShow(NOW, shown13d, ctx()), false);
    assert.equal(RG.shouldShow(NOW, shown14d, ctx()), true);
    assert.equal(RG.shouldShow(NOW, shown15d, ctx()), true);
});

test('生涯最大2回: 2回表示済みなら操作の有無によらず出ない', () => {
    const shown2 = db({ review: { installTs: NOW - 90 * DAY, shownCount: 2, lastShownTs: NOW - 60 * DAY } });
    assert.equal(RG.shouldShow(NOW, shown2, ctx()), false);
});

/* --- URL --- */

test('フィードバック URL は GitHub issues。テスト環境ではレビュー URL は空', () => {
    const u = RG.urls();
    assert.equal(u.feedback, 'https://github.com/cysecukazch/missend-guard/issues');
    assert.equal(u.review, ''); // chrome が無い環境では空（呼び出し側が隠す）
});
