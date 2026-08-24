/**
 * sync-codec の単体テスト。
 * 核心の主張:「当拡張の最大容量の学習データが chrome.storage.sync の上限内に、
 * 同期漏れなく収まる」ことを実測で保証する。
 * 実行: node --test test/sync-codec.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../src/sync-codec.js');

// chrome.storage.sync の実際の上限
const SYNC_TOTAL = 102400;
const SYNC_PER_ITEM = 8192;
const SYNC_MAX_ITEMS = 512;

function assertWithinSyncLimits(shards) {
    const keys = Object.keys(shards);
    assert.ok(keys.length <= SYNC_MAX_ITEMS, `項目数 ${keys.length} が 512 以内`);
    let total = 0;
    for (const k of keys) {
        const b = C.bytes(shards[k]);
        assert.ok(b <= SYNC_PER_ITEM, `項目 ${k} が ${b}B（8192以内）`);
        total += b + C.bytes(k);
    }
    assert.ok(total <= SYNC_TOTAL, `合計 ${total}B が 102400 以内`);
    return total;
}

/** 現実的な最大容量の DB を作る（宛先3000・combo/pairAck/greetAck各1000・スレッド500） */
function buildMaxDb() {
    const db = { recipients: {}, domains: {}, combos: {}, pairAcks: {}, greetAcks: {}, threads: {}, stats: { sends: 5000, dialogs: 400, autoPass: 4600 } };
    const domains = [];
    for (let d = 0; d < 400; d++) domains.push(`company${d}.co.jp`);
    const emails = [];
    for (let i = 0; i < 3000; i++) {
        const dm = domains[i % domains.length];
        const email = `user.name${i}@${dm}`;
        emails.push(email);
        db.recipients[email] = { c: (i % 50) + 1, t: 1000000 + i, n: '' };
        db.domains[dm] = { c: 10, t: 1 };
    }
    for (let i = 0; i < 1000; i++) db.combos[[domains[i % 400], domains[(i + 1) % 400]].sort().join('|')] = 1;
    for (let i = 0; i < 1000; i++) db.pairAcks[[emails[i], emails[i + 1]].sort().join('|')] = 1;
    for (let i = 0; i < 1000; i++) db.greetAcks[`さとう${i}|${emails[i]}`] = 1;
    for (let i = 0; i < 500; i++) db.threads['t' + i.toString(36)] = { r: [emails[i], emails[i + 1], emails[i + 2]], t: 1 };
    return { db, emails };
}

test('最大容量の DB が sync 上限内に収まり、漏れが出ない', () => {
    const { db } = buildMaxDb();
    const { shards, meta } = C.encode(db);
    const total = assertWithinSyncLimits(shards);
    // 漏れゼロ（トリムが発生していない）
    assert.equal(meta.dropped.recipients, 0, '宛先の漏れゼロ');
    assert.equal(meta.dropped.combos, 0);
    assert.equal(meta.dropped.pairAcks, 0);
    assert.equal(meta.dropped.greetAcks, 0);
    assert.equal(meta.dropped.threads, 0);
    assert.equal(meta.kept.recipients, 3000);
    console.log(`  最大DB: ${total}B / ${Object.keys(shards).length}項目（上限 102400B/512項目）`);
});

test('ラウンドトリップ: エンコード→デコードで宛先と回数が一致する', () => {
    const { db } = buildMaxDb();
    const { shards } = C.encode(db);
    const back = C.decode(shards);
    // 宛先の集合と回数が保存される（表示名は同期しない仕様）
    assert.equal(Object.keys(back.recipients).length, 3000);
    for (const email of Object.keys(db.recipients)) {
        assert.ok(back.recipients[email], `${email} が復元される`);
        assert.equal(back.recipients[email].c, db.recipients[email].c, `${email} の回数一致`);
    }
    // ドメインが導出される
    assert.ok(back.domains['company0.co.jp']);
    // combo/pairAck/greetAck/thread も件数が保存
    assert.equal(Object.keys(back.combos).length, Object.keys(db.combos).length);
    assert.equal(Object.keys(back.pairAcks).length, Object.keys(db.pairAcks).length);
    assert.equal(Object.keys(back.greetAcks).length, Object.keys(db.greetAcks).length);
    assert.equal(Object.keys(back.threads).length, Object.keys(db.threads).length);
    // stats
    assert.equal(back.stats.sends, 5000);
});

test('recency 順が保たれる（新しい宛先が先頭）', () => {
    const db = { recipients: {}, domains: {}, combos: {}, pairAcks: {}, greetAcks: {}, threads: {}, stats: {} };
    db.recipients['old@x.co.jp'] = { c: 1, t: 100, n: '' };
    db.recipients['new@x.co.jp'] = { c: 1, t: 999, n: '' };
    const back = C.decode(C.encode(db).shards);
    assert.ok(back.recipients['new@x.co.jp'].t > back.recipients['old@x.co.jp'].t,
        '新しい宛先の方が t が大きい（プルーニング時に残る）');
});

test('病的ケース（超長ローカル部を大量）でも上限内に収め、落とした件数を報告', () => {
    const db = { recipients: {}, domains: {}, combos: {}, pairAcks: {}, greetAcks: {}, threads: {}, stats: {} };
    // 64文字ローカル部 × 3000 = 素朴には 200KB 超
    const lp = 'x'.repeat(64);
    for (let i = 0; i < 3000; i++) db.recipients[`${lp}${i}@company${i % 50}.co.jp`] = { c: 1, t: i, n: '' };
    const { shards, meta } = C.encode(db);
    assertWithinSyncLimits(shards);            // 必ず上限内に収まる
    assert.ok(meta.dropped.recipients > 0, '収まらない分はトリムされる');
    assert.ok(meta.kept.recipients > 0, '新しい宛先は残る');
    // 落とした件数が meta に出る（＝黙って漏れない）
    console.log(`  病的ケース: 採用 ${meta.kept.recipients} / 除外 ${meta.dropped.recipients}`);
});

test('区切り文字を含む不正な宛先は安全に除外する', () => {
    const db = { recipients: {}, domains: {}, combos: {}, pairAcks: {}, greetAcks: {}, threads: {}, stats: {} };
    db.recipients['ok@x.co.jp'] = { c: 1, t: 2, n: '' };
    db.recipients['ba d@x.co.jp'] = { c: 1, t: 1, n: '' }; // スペース入り（異常）
    const { shards, meta } = C.encode(db);
    const back = C.decode(shards);
    assert.ok(back.recipients['ok@x.co.jp']);
    assert.ok(!back.recipients['ba d@x.co.jp']);
    assert.equal(meta.dropped.recipients, 1);
});

test('空 DB でも壊れない', () => {
    const { shards, meta } = C.encode({});
    assertWithinSyncLimits(shards);
    assert.equal(meta.kept.recipients, 0);
    const back = C.decode(shards);
    assert.deepEqual(Object.keys(back.recipients), []);
});

test('decode: 破損/欠損シャードでは null を返す（安全側）', () => {
    assert.equal(C.decode(null), null);
    assert.equal(C.decode({}), null);
    // メタが n=3 なのにシャードが欠けている
    assert.equal(C.decode({ psg_ymeta: JSON.stringify({ v: '1', n: 3 }), psg_y0: '1\n\nD \nE ' }), null);
});

test('各シャードは 8192B 未満・全体は 512 項目未満（境界の厳密確認）', () => {
    const { db } = buildMaxDb();
    const { shards } = C.encode(db);
    for (const k of Object.keys(shards)) {
        assert.ok(C.bytes(shards[k]) < 8192, `${k}: ${C.bytes(shards[k])}B`);
    }
    assert.ok(Object.keys(shards).length < 512);
});

/* ---- merge: 冪等性と統合 ---- */

test('merge: 2台の宛先が和集合になり、回数は max を採る', () => {
    const a = { recipients: { 'x@a.jp': { c: 10, t: 5, n: '' } }, domains: {}, combos: {}, pairAcks: {}, greetAcks: {}, threads: {} };
    const b = { recipients: { 'x@a.jp': { c: 3, t: 9, n: '田中' }, 'y@b.jp': { c: 1, t: 2, n: '' } }, domains: {}, combos: {}, pairAcks: {}, greetAcks: {}, threads: {} };
    const changed = C.merge(a, b);
    assert.ok(changed);
    assert.equal(a.recipients['x@a.jp'].c, 10);        // max(10,3)
    assert.equal(a.recipients['x@a.jp'].t, 9);         // max(5,9)
    assert.equal(a.recipients['x@a.jp'].n, '田中');     // 空だったので補完
    assert.ok(a.recipients['y@b.jp']);                 // 和集合
});

test('merge: 冪等（同じデータを再マージしても変化しない）', () => {
    const a = { recipients: { 'x@a.jp': { c: 5, t: 5, n: '' } }, domains: {}, combos: { 'a.jp|b.jp': 3 }, pairAcks: {}, greetAcks: {}, threads: { t1: { r: ['x@a.jp'], t: 1 } } };
    const b = JSON.parse(JSON.stringify(a));
    C.merge(a, b);
    const changedAgain = C.merge(a, b);
    assert.equal(changedAgain, false, '2回目のマージは変化なし');
});

test('merge: encode→decode→merge の一巡でデータが保たれる', () => {
    const src = { recipients: { 'sato@x.co.jp': { c: 20, t: 100, n: '佐藤' } }, domains: {}, combos: {}, pairAcks: {}, greetAcks: {}, threads: {}, stats: {} };
    const decoded = C.decode(C.encode(src).shards);
    const target = { recipients: {}, domains: {}, combos: {}, pairAcks: {}, greetAcks: {}, threads: {} };
    C.merge(target, decoded);
    assert.ok(target.recipients['sato@x.co.jp']);
    assert.equal(target.recipients['sato@x.co.jp'].c, 20);
});
