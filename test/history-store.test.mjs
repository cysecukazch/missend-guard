/**
 * history-store の学習・忘却・巻き戻しの単体テスト（chrome スタブ使用）。
 * 実行: node --test test/history-store.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// --- 最小 chrome スタブ（local/sync 両対応・onChanged あり） ---
function installChrome() {
    const areas = { local: {}, sync: {} };
    const listeners = [];
    const mkArea = (name) => ({
        get: (q, cb) => setTimeout(() => {
            const d = areas[name]; let out = {};
            if (q == null) out = Object.assign({}, d);
            else if (Array.isArray(q)) q.forEach(k => { if (k in d) out[k] = d[k]; });
            else if (typeof q === 'object') Object.keys(q).forEach(k => out[k] = (k in d) ? d[k] : q[k]);
            else out[q] = d[q];
            cb(out);
        }, 0),
        set: (obj, cb) => { Object.assign(areas[name], obj); cb && setTimeout(cb, 0); },
        remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete areas[name][k]); cb && setTimeout(cb, 0); }
    });
    globalThis.chrome = {
        runtime: { lastError: null },
        storage: { local: mkArea('local'), sync: mkArea('sync'), onChanged: { addListener: (fn) => listeners.push(fn) } }
    };
    return areas;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// engine（DEFAULT_SETTINGS 参照）→ codec → store の順で読み込む
installChrome();
require('../src/risk-engine.js');
require('../src/sync-codec.js');
require('../src/history-store.js');
const Store = globalThis.PSG_Store;

const learn = (emails, over = {}) => Object.assign({
    recipients: emails.map(e => ({ email: e, name: '' })),
    domains: [...new Set(emails.map(e => e.split('@')[1]))],
    combo: null, pairAcks: [], greetAcks: [], threadKey: null, threadRecipients: []
}, over);

test('recordSend で宛先が学習され、forgetRecipient で忘れられる', async () => {
    await Store.clearHistory();
    await Store.recordSend(learn(['taro@x.co.jp', 'jiro@y.co.jp']), false);
    let db = await Store.getHistory();
    assert.ok(db.recipients['taro@x.co.jp']);
    assert.ok(db.recipients['jiro@y.co.jp']);

    const ok = await Store.forgetRecipient('taro@x.co.jp');
    assert.equal(ok, true);
    db = await Store.getHistory();
    assert.ok(!db.recipients['taro@x.co.jp'], 'taro は忘れられた');
    assert.ok(db.recipients['jiro@y.co.jp'], 'jiro は残る');
});

test('undoLastLearn で直近の送信学習が巻き戻る', async () => {
    await Store.clearHistory();
    await Store.recordSend(learn(['known@x.co.jp']), false); // 既存にしておく
    await Store.recordSend(learn(['known@x.co.jp', 'oops@evil.example']), false); // 2回目（誤送信想定）
    let db = await Store.getHistory();
    assert.equal(db.recipients['known@x.co.jp'].c, 2);
    assert.ok(db.recipients['oops@evil.example']);

    const ok = await Store.undoLastLearn();
    assert.equal(ok, true);
    db = await Store.getHistory();
    assert.ok(!db.recipients['oops@evil.example'], '新規に覚えた誤アドレスは消える');
    assert.equal(db.recipients['known@x.co.jp'].c, 1, '既存宛先の回数は 2→1 に戻る');
});

test('undoLastLearn はスレッド追加分も巻き戻す', async () => {
    await Store.clearHistory();
    const key = globalThis.PSG_RiskEngine.subjectKey('Re: プロジェクト案件A');
    await Store.recordSend(learn(['a@x.co.jp'], { threadKey: key, threadRecipients: ['a@x.co.jp'] }), false);
    await Store.recordSend(learn(['a@x.co.jp', 'stranger@z.jp'], { threadKey: key, threadRecipients: ['a@x.co.jp', 'stranger@z.jp'] }), true);
    await Store.undoLastLearn();
    const db = await Store.getHistory();
    assert.ok(!db.threads[key].r.includes('stranger@z.jp'), 'スレッドに追加された新顔が取り消される');
    assert.ok(db.threads[key].r.includes('a@x.co.jp'), '元メンバーは残る');
});

test('forgetRecipient は関連 pairAck/greetAck も除去する', async () => {
    await Store.clearHistory();
    await Store.recordSend(learn(['sato@x.co.jp']), false);
    await Store.recordSend(learn(['saito@x.co.jp'], {
        pairAcks: ['saito@x.co.jp|sato@x.co.jp'], greetAcks: ['佐藤|saito@x.co.jp']
    }), true);
    let db = await Store.getHistory();
    assert.ok(db.pairAcks['saito@x.co.jp|sato@x.co.jp']);
    await Store.forgetRecipient('saito@x.co.jp');
    db = await Store.getHistory();
    assert.ok(!db.pairAcks['saito@x.co.jp|sato@x.co.jp'], 'ペアackも消える');
    assert.ok(!db.greetAcks['佐藤|saito@x.co.jp'], '宛名ackも消える');
});

test('getStatus が状態オブジェクトを返す', async () => {
    const st = Store.getStatus();
    assert.ok(typeof st === 'object');
    assert.ok('syncState' in st);
});
