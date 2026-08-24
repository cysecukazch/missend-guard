/**
 * risk-engine の単体テスト。
 * 実行: node --test test/risk-engine.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RE = require('../src/risk-engine.js');

/* ---------------------------------------------------------------- */
/* ヘルパー                                                          */
/* ---------------------------------------------------------------- */

const addr = (email, name = '') => ({ email, name });

function historyWith({ recipients = [], domains = [], combos = [] } = {}) {
    const h = { recipients: {}, domains: {}, combos: {} };
    for (const r of recipients) h.recipients[r] = { c: 3, t: 1 };
    for (const d of domains) h.domains[d] = { c: 3, t: 1 };
    for (const c of combos) h.combos[c] = 1;
    return h;
}

function baseMail(over = {}) {
    return Object.assign({
        to: [addr('taro@customer-a.co.jp', '山田太郎')],
        cc: [], bcc: [],
        subject: 'お見積りの件',
        bodyText: 'いつもお世話になっております。',
        attachments: [],
        fromEmail: 'me@mycompany.co.jp'
    }, over);
}

const types = (result) => result.anomalies.map(a => a.type);

/* ---------------------------------------------------------------- */
/* parseAddress                                                      */
/* ---------------------------------------------------------------- */

test('parseAddress: 裸のアドレス', () => {
    assert.deepEqual(RE.parseAddress('Taro@Example.co.jp'),
        { email: 'taro@example.co.jp', name: '' });
});

test('parseAddress: 表示名付き', () => {
    assert.deepEqual(RE.parseAddress('"山田 太郎" <taro@example.co.jp>'),
        { email: 'taro@example.co.jp', name: '山田 太郎' });
});

test('parseAddress: 前後の空白と引用符なし表示名', () => {
    assert.deepEqual(RE.parseAddress('  山田太郎 <taro@example.co.jp>  '),
        { email: 'taro@example.co.jp', name: '山田太郎' });
});

test('parseAddress: 不正な入力は null', () => {
    assert.equal(RE.parseAddress('not-an-address'), null);
    assert.equal(RE.parseAddress(''), null);
    assert.equal(RE.parseAddress(null), null);
});

/* ---------------------------------------------------------------- */
/* levenshtein                                                       */
/* ---------------------------------------------------------------- */

test('levenshtein: 基本', () => {
    assert.equal(RE.levenshtein('gmail.com', 'gmail.com', 2), 0);
    assert.equal(RE.levenshtein('gmial.com', 'gmail.com', 2), 2); // 転置は置換2回分
    assert.equal(RE.levenshtein('sato', 'saito', 2), 1);
    assert.equal(RE.levenshtein('abc', 'xyz', 2), 3); // 上限超え → max+1
});

/* ---------------------------------------------------------------- */
/* analyze: 素通しと基本異常                                          */
/* ---------------------------------------------------------------- */

test('既知の宛先のみ → 異常なし', () => {
    const h = historyWith({ recipients: ['taro@customer-a.co.jp'], domains: ['customer-a.co.jp'] });
    const r = RE.analyze(baseMail(), h, {});
    assert.deepEqual(types(r), []);
});

test('宛先ゼロ → passThrough（Gmail 自身のエラーに任せる）', () => {
    const r = RE.analyze(baseMail({ to: [], cc: [], bcc: [] }), historyWith(), {});
    assert.equal(r.passThrough, true);
    assert.deepEqual(r.anomalies, []);
});

test('初めての宛先 → first_recipients。既知なら出ない', () => {
    const r1 = RE.analyze(baseMail(), historyWith(), {});
    assert.ok(types(r1).includes('first_recipients'));
    assert.equal(r1.anomalies.find(a => a.type === 'first_recipients').rows.length, 1);

    const h = historyWith({ recipients: ['taro@customer-a.co.jp'], domains: ['customer-a.co.jp'] });
    const r2 = RE.analyze(baseMail(), h, {});
    assert.ok(!types(r2).includes('first_recipients'));
});

test('件名空欄・To空欄・添付言及は警告しない（Gmail 本体の機能に委ねる）', () => {
    const h = historyWith({ recipients: ['taro@customer-a.co.jp'], domains: ['customer-a.co.jp'] });
    const r = RE.analyze(baseMail({
        subject: '',
        to: [], cc: [addr('taro@customer-a.co.jp')],
        bodyText: '資料を添付いたします。'
    }), h, {});
    assert.deepEqual(types(r), []);
});

/* ---------------------------------------------------------------- */
/* analyze: 取り違え検出                                              */
/* ---------------------------------------------------------------- */

test('同一ドメインの似たローカル部 → lookalike_recipient 注記', () => {
    const h = historyWith({
        recipients: ['sato@customer-a.co.jp'],
        domains: ['customer-a.co.jp']
    });
    const r = RE.analyze(baseMail({ to: [addr('saito@customer-a.co.jp')] }), h, {});
    const first = r.anomalies.find(a => a.type === 'first_recipients');
    assert.ok(first);
    const notes = first.rows[0].notes.map(n => n.type);
    assert.ok(notes.includes('lookalike_recipient'));
});

test('既知ドメインの typo → lookalike_domain 注記', () => {
    const h = historyWith({ domains: ['customer-a.co.jp'] });
    const r = RE.analyze(baseMail({ to: [addr('taro@customer-b.co.jp')] }), h, {});
    const first = r.anomalies.find(a => a.type === 'first_recipients');
    const notes = first.rows[0].notes.map(n => n.type);
    assert.ok(notes.includes('new_domain'));
    assert.ok(notes.includes('lookalike_domain')); // customer-a と 1 文字違い
});

test('有名ドメインの typo (gmial.com) → lookalike_domain 注記', () => {
    const r = RE.analyze(baseMail({ to: [addr('x@gmial.com')] }), historyWith(), {});
    const first = r.anomalies.find(a => a.type === 'first_recipients');
    const note = first.rows[0].notes.find(n => n.type === 'lookalike_domain');
    assert.ok(note);
    assert.equal(note.params[0], 'gmail.com');
});

test('自ドメインへの送信は new_domain 扱いしない', () => {
    // checkSkipInternal はオフにして new_domain 注記のロジック自体を検証する
    const r = RE.analyze(baseMail({ to: [addr('boss@mycompany.co.jp')] }), historyWith(),
        { checkSkipInternal: false });
    const first = r.anomalies.find(a => a.type === 'first_recipients');
    const notes = first.rows[0].notes.map(n => n.type);
    assert.ok(!notes.includes('new_domain'));
});

/* ---------------------------------------------------------------- */
/* analyze: 組織の組み合わせ                                          */
/* ---------------------------------------------------------------- */

test('初めての外部ドメインの組み合わせ → new_combo。学習後は出ない', () => {
    const h = historyWith({
        recipients: ['a@customer-a.co.jp', 'b@customer-b.co.jp'],
        domains: ['customer-a.co.jp', 'customer-b.co.jp']
    });
    const mail = baseMail({
        to: [addr('a@customer-a.co.jp')],
        cc: [addr('b@customer-b.co.jp')]
    });
    const r1 = RE.analyze(mail, h, {});
    assert.ok(types(r1).includes('new_combo'));
    assert.equal(r1.learn.combo, 'customer-a.co.jp|customer-b.co.jp');

    // 学習済みなら出ない
    h.combos['customer-a.co.jp|customer-b.co.jp'] = 1;
    const r2 = RE.analyze(mail, h, {});
    assert.ok(!types(r2).includes('new_combo'));
});

test('BCC の宛先は組み合わせ判定に含めない', () => {
    const h = historyWith({
        recipients: ['a@customer-a.co.jp', 'b@customer-b.co.jp'],
        domains: ['customer-a.co.jp', 'customer-b.co.jp']
    });
    const r = RE.analyze(baseMail({
        to: [addr('a@customer-a.co.jp')],
        bcc: [addr('b@customer-b.co.jp')]
    }), h, {});
    assert.ok(!types(r).includes('new_combo'));
});

/* ---------------------------------------------------------------- */
/* analyze: BCC 推奨                                                  */
/* ---------------------------------------------------------------- */

test('To/Cc の外部宛先が閾値以上 → many_visible', () => {
    const emails = [];
    for (let i = 0; i < 5; i++) emails.push(addr(`user${i}@ext${i}.co.jp`));
    const h = historyWith({
        recipients: emails.map(e => e.email),
        domains: emails.map(e => e.email.split('@')[1]),
        combos: [emails.map(e => e.email.split('@')[1]).sort().join('|')]
    });
    const r = RE.analyze(baseMail({ to: emails }), h, { manyVisibleThreshold: 5 });
    assert.ok(types(r).includes('many_visible'));

    // BCC に入っていれば出ない
    const r2 = RE.analyze(baseMail({ to: [], bcc: emails }), h, { manyVisibleThreshold: 5 });
    assert.ok(!types(r2).includes('many_visible'));
});

/* ---------------------------------------------------------------- */
/* analyze: フリーメール From の外部判定（BCC 提案バグの回帰）          */
/* ---------------------------------------------------------------- */

test('gmail.com の From から gmail.com 宛7件 → many_visible が出る', () => {
    const emails = [];
    for (let i = 0; i < 7; i++) emails.push(addr(`user${i}@gmail.com`));
    const h = historyWith({ recipients: emails.map(e => e.email), domains: ['gmail.com'] });
    const r = RE.analyze(baseMail({
        fromEmail: 'me@gmail.com',
        to: emails
    }), h, { manyVisibleThreshold: 5 });
    assert.ok(types(r).includes('many_visible'),
        'フリーメールの From では同一ドメインも外部として数えるべき');
});

test('フリーメールのドメインは組織の組み合わせ判定に含めない', () => {
    const h = historyWith({
        recipients: ['a@customer-a.co.jp', 'b@gmail.com'],
        domains: ['customer-a.co.jp', 'gmail.com']
    });
    const r = RE.analyze(baseMail({
        to: [addr('a@customer-a.co.jp')],
        cc: [addr('b@gmail.com')]
    }), h, {});
    assert.ok(!types(r).includes('new_combo'), 'gmail.com は組織ではない');
});

/* ---------------------------------------------------------------- */
/* analyze: 学習ペイロードと設定                                       */
/* ---------------------------------------------------------------- */

test('learn には全宛先・全ドメインが入る（重複除去済み）', () => {
    const r = RE.analyze(baseMail({
        to: [addr('a@x.co.jp'), addr('a@x.co.jp'), addr('b@x.co.jp')],
        cc: [addr('c@y.co.jp')]
    }), historyWith(), {});
    assert.deepEqual(r.learn.recipients.map(x => x.email).sort(), ['a@x.co.jp', 'b@x.co.jp', 'c@y.co.jp']);
    assert.deepEqual(r.learn.domains.sort(), ['x.co.jp', 'y.co.jp']);
});

test('ルールを個別にオフにできる', () => {
    const r = RE.analyze(baseMail(), historyWith(), {
        checkFirstRecipient: false
    });
    assert.deepEqual(types(r), []);
});
