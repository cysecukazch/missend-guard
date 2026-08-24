/**
 * 「既知宛先の取り違え」対策 3 ルールの単体テスト。
 * 実行: node --test test/mixup-rules.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RE = require('../src/risk-engine.js');

const addr = (email, name = '') => ({ email, name });

function historyWith({ recipients = {}, domains = [], combos = [], pairAcks = [], greetAcks = [], threads = {} } = {}) {
    const h = { recipients: {}, domains: {}, combos: {}, pairAcks: {}, greetAcks: {}, threads };
    for (const [email, spec] of Object.entries(recipients)) {
        h.recipients[email] = Object.assign({ c: 3, t: 1, n: '' }, spec);
    }
    for (const d of domains) h.domains[d] = { c: 3, t: 1 };
    for (const c of combos) h.combos[c] = 1;
    for (const p of pairAcks) h.pairAcks[p] = 1;
    for (const g of greetAcks) h.greetAcks[g] = 1;
    return h;
}

function baseMail(over = {}) {
    return Object.assign({
        to: [addr('sato@customer-a.co.jp', '佐藤')],
        cc: [], bcc: [],
        subject: 'お見積りの件',
        bodyText: 'いつもお世話になっております。',
        attachments: [],
        fromEmail: 'me@mycompany.co.jp'
    }, over);
}

const types = r => r.anomalies.map(a => a.type);

/* ---------------------------------------------------------------- */
/* ルール1: 既知同士の取り違え (known_lookalike)                      */
/* ---------------------------------------------------------------- */

test('既知でも「普段の宛先と酷似・低頻度」なら known_lookalike が出る', () => {
    const h = historyWith({
        recipients: {
            'sato@customer-a.co.jp': { c: 50, n: '佐藤' },
            'saito@customer-a.co.jp': { c: 1, n: '斉藤' }
        },
        domains: ['customer-a.co.jp']
    });
    const r = RE.analyze(baseMail({ to: [addr('saito@customer-a.co.jp', '斉藤')] }), h, {});
    assert.ok(types(r).includes('known_lookalike'));
    const a = r.anomalies.find(x => x.type === 'known_lookalike');
    assert.equal(a.rows[0].email, 'saito@customer-a.co.jp');
    assert.equal(a.rows[0].notes[0].params[0], 'sato@customer-a.co.jp');
    // 確認するとペアが学習対象になる
    assert.deepEqual(r.learn.pairAcks, ['saito@customer-a.co.jp|sato@customer-a.co.jp']);
});

test('ペア確認済みなら known_lookalike は出ない（自己沈静化）', () => {
    const h = historyWith({
        recipients: {
            'sato@customer-a.co.jp': { c: 50 },
            'saito@customer-a.co.jp': { c: 1 }
        },
        domains: ['customer-a.co.jp'],
        pairAcks: ['saito@customer-a.co.jp|sato@customer-a.co.jp']
    });
    const r = RE.analyze(baseMail({ to: [addr('saito@customer-a.co.jp')] }), h, {});
    assert.ok(!types(r).includes('known_lookalike'));
});

test('頻度が拮抗している似た宛先には出ない（判定不能なので黙る）', () => {
    const h = historyWith({
        recipients: {
            'sato@customer-a.co.jp': { c: 10 },
            'saito@customer-a.co.jp': { c: 9 }
        },
        domains: ['customer-a.co.jp']
    });
    const r = RE.analyze(baseMail({ to: [addr('saito@customer-a.co.jp')] }), h, {});
    assert.ok(!types(r).includes('known_lookalike'));
});

test('似た相手を同時に To に入れている場合は出ない', () => {
    const h = historyWith({
        recipients: {
            'sato@customer-a.co.jp': { c: 50 },
            'saito@customer-a.co.jp': { c: 1 }
        },
        domains: ['customer-a.co.jp']
    });
    const r = RE.analyze(baseMail({
        to: [addr('sato@customer-a.co.jp'), addr('saito@customer-a.co.jp')]
    }), h, {});
    assert.ok(!types(r).includes('known_lookalike'));
});

test('初見の宛先は known_lookalike ではなく first_recipients 側で扱う', () => {
    const h = historyWith({
        recipients: { 'sato@customer-a.co.jp': { c: 50 } },
        domains: ['customer-a.co.jp']
    });
    const r = RE.analyze(baseMail({ to: [addr('saito@customer-a.co.jp')] }), h, {});
    assert.ok(!types(r).includes('known_lookalike'));
    assert.ok(types(r).includes('first_recipients'));
});

/* ---------------------------------------------------------------- */
/* ルール2: 宛名ミスマッチ (greeting_mismatch)                        */
/* ---------------------------------------------------------------- */

test('本文「佐藤様」で宛先が斉藤のみ → suggest 付きミスマッチ', () => {
    const h = historyWith({
        recipients: {
            'sato@customer-a.co.jp': { c: 50, n: '佐藤' },
            'saito@customer-a.co.jp': { c: 30, n: '斉藤' }
        },
        domains: ['customer-a.co.jp'],
        pairAcks: ['saito@customer-a.co.jp|sato@customer-a.co.jp']
    });
    const r = RE.analyze(baseMail({
        to: [addr('saito@customer-a.co.jp', '斉藤')],
        bodyText: '佐藤様\n\nいつもお世話になっております。'
    }), h, {});
    const a = r.anomalies.find(x => x.type === 'greeting_mismatch_suggest');
    assert.ok(a);
    assert.equal(a.params[0], '佐藤');
    assert.equal(a.params[1], 'sato@customer-a.co.jp');
});

test('宛名と宛先が一致していれば出ない（表示名・ローマ字・異体字）', () => {
    const h = historyWith({
        recipients: { 'sato@customer-a.co.jp': { c: 5, n: '佐藤' } },
        domains: ['customer-a.co.jp']
    });
    // 表示名一致
    let r = RE.analyze(baseMail({ bodyText: '佐藤様\n\nお世話になります。' }), h, {});
    assert.ok(!types(r).join().includes('greeting'));
    // 表示名なし → ローカル部のローマ字一致
    r = RE.analyze(baseMail({
        to: [addr('sato@customer-a.co.jp')],
        bodyText: '佐藤様\n\nお世話になります。'
    }), h, {});
    assert.ok(!types(r).join().includes('greeting'));
    // 異体字（齋藤様 → saito@）
    r = RE.analyze(baseMail({
        to: [addr('saito@customer-b.co.jp', '斎藤')],
        bodyText: '齋藤様\n\nお世話になります。'
    }), historyWith({
        recipients: { 'saito@customer-b.co.jp': { c: 5, n: '斎藤' } },
        domains: ['customer-b.co.jp']
    }), {});
    assert.ok(!types(r).join().includes('greeting'));
});

test('「お疲れ様です」「皆様」「ご担当者様」「株式会社◯◯様」では出ない', () => {
    const h = historyWith({
        recipients: { 'sato@customer-a.co.jp': { c: 5, n: '佐藤' } },
        domains: ['customer-a.co.jp']
    });
    for (const body of [
        'お疲れ様です。佐藤です。',
        '皆様\n\nお知らせです。',
        'ご担当者様\n\nはじめまして。',
        '株式会社テスト様\n\nお世話になります。',
        '関係者様へのご連絡です。'
    ]) {
        const r = RE.analyze(baseMail({ bodyText: body }), h, {});
        assert.ok(!types(r).join().includes('greeting'), `false positive: ${body}`);
    }
});

test('greetAck 済みの宛名+宛先の組では出ない', () => {
    const h = historyWith({
        recipients: { 'saito@customer-a.co.jp': { c: 5, n: '斉藤' } },
        domains: ['customer-a.co.jp'],
        greetAcks: ['佐藤|saito@customer-a.co.jp']
    });
    const r = RE.analyze(baseMail({
        to: [addr('saito@customer-a.co.jp', '斉藤')],
        bodyText: '佐藤様\n\nお世話になります。'
    }), h, {});
    assert.ok(!types(r).join().includes('greeting'));
});

test('Dear Sato で宛先 saito のみ → ミスマッチ検出', () => {
    const h = historyWith({
        recipients: { 'saito@ex.com': { c: 5 } },
        domains: ['ex.com']
    });
    const r = RE.analyze(baseMail({
        to: [addr('saito@ex.com')],
        bodyText: 'Dear Sato,\n\nHope this finds you well.'
    }), h, {});
    assert.ok(types(r).some(t => t.startsWith('greeting_mismatch')));
});

/* ---------------------------------------------------------------- */
/* ルール3: スレッド宛先変化 (thread_new)                             */
/* ---------------------------------------------------------------- */

test('同じ件名の過去送信に居なかった宛先が混じると thread_new', () => {
    const key = RE.subjectKey('Re: お見積りの件');
    const h = historyWith({
        recipients: {
            'sato@customer-a.co.jp': { c: 10 },
            'tanaka@customer-a.co.jp': { c: 10 },
            'saito@customer-b.co.jp': { c: 10 }
        },
        domains: ['customer-a.co.jp', 'customer-b.co.jp'],
        combos: ['customer-a.co.jp|customer-b.co.jp'],
        threads: { [key]: { r: ['sato@customer-a.co.jp', 'tanaka@customer-a.co.jp'], t: 1 } }
    });
    const r = RE.analyze(baseMail({
        subject: 'Re: お見積りの件',
        to: [addr('sato@customer-a.co.jp'), addr('tanaka@customer-a.co.jp')],
        cc: [addr('saito@customer-b.co.jp')]
    }), h, {});
    const a = r.anomalies.find(x => x.type === 'thread_new');
    assert.ok(a, '既知宛先だけでもスレッドに新顔なら検出すべき');
    assert.deepEqual(a.rows.map(x => x.email), ['saito@customer-b.co.jp']);
});

test('確認後は thread メンバーとして学習され、次回は出ない', () => {
    const key = RE.subjectKey('Re: お見積りの件');
    const h = historyWith({
        recipients: { 'sato@customer-a.co.jp': { c: 10 }, 'saito@customer-b.co.jp': { c: 10 } },
        domains: ['customer-a.co.jp', 'customer-b.co.jp'],
        combos: ['customer-a.co.jp|customer-b.co.jp'],
        threads: { [key]: { r: ['sato@customer-a.co.jp', 'saito@customer-b.co.jp'], t: 1 } }
    });
    const r = RE.analyze(baseMail({
        subject: 'RE: お見積りの件',  // 大文字・Re 多重でも同一キー
        to: [addr('sato@customer-a.co.jp')],
        cc: [addr('saito@customer-b.co.jp')]
    }), h, {});
    assert.ok(!types(r).includes('thread_new'));
});

test('宛先が全員入れ替わった場合（同名件名の別件）は出ない', () => {
    const key = RE.subjectKey('ご連絡の件');
    const h = historyWith({
        recipients: { 'x@a.co.jp': { c: 5 }, 'y@b.co.jp': { c: 5 } },
        domains: ['a.co.jp', 'b.co.jp'],
        threads: { [key]: { r: ['x@a.co.jp'], t: 1 } }
    });
    const r = RE.analyze(baseMail({
        subject: 'ご連絡の件',
        to: [addr('y@b.co.jp')]
    }), h, {});
    assert.ok(!types(r).includes('thread_new'));
});

test('subjectKey: Re/Fwd の除去・正規化・短件名の除外', () => {
    assert.equal(RE.subjectKey('Re: Fwd: 見積の件'), RE.subjectKey('見積の件'));
    assert.equal(RE.subjectKey('RE:  見積の件 '), RE.subjectKey('見積の件'));
    assert.notEqual(RE.subjectKey('見積の件'), RE.subjectKey('請求の件'));
    assert.equal(RE.subjectKey('件'), null);   // 短すぎる件名は対象外
    assert.equal(RE.subjectKey(''), null);
});

test('learn に threadKey とメンバーが入る', () => {
    const r = RE.analyze(baseMail({ subject: '新しい案件のご相談' }), historyWith({
        recipients: { 'sato@customer-a.co.jp': { c: 5 } },
        domains: ['customer-a.co.jp']
    }), {});
    assert.equal(r.learn.threadKey, RE.subjectKey('新しい案件のご相談'));
    assert.deepEqual(r.learn.threadRecipients, ['sato@customer-a.co.jp']);
});

/* ---------------------------------------------------------------- */
/* 敵対的レビューで確認された誤検知・見逃しの回帰テスト                 */
/* ---------------------------------------------------------------- */

test('回帰: 「仕様/同様/貴殿/様式」等の複合語では greeting を出さない', () => {
    const h = historyWith({
        recipients: { 'sato@customer-a.co.jp': { c: 20, n: '佐藤' } },
        domains: ['customer-a.co.jp']
    });
    for (const body of [
        '佐藤様\n\nいつもお世話になっております。仕様書を添付いたします。',
        '先日と同様に、見積書をお送りします。',
        '申請様式を提出してください。',
        '貴殿におかれましてはご健勝のことと存じます。',
        '営業部長会議の資料です。',
        '経理課長より承っております。'
    ]) {
        const r = RE.analyze(baseMail({ bodyText: body, attachments: ['spec.pdf'] }), h, {});
        assert.ok(!types(r).some(t => t.startsWith('greeting')), `false positive: ${body}`);
    }
});

test('回帰: 文中の第三者言及（鈴木様より/高橋様にも）では出ない', () => {
    const h = historyWith({
        recipients: {
            'yamada@client-c.co.jp': { c: 5, n: '山田' },
            'suzuki@partner.co.jp': { c: 40, n: '鈴木' },
            'takahashi@partner.co.jp': { c: 10, n: '高橋' }
        },
        domains: ['client-c.co.jp', 'partner.co.jp']
    });
    for (const body of [
        '山田様\n\n鈴木様よりご紹介いただき、初めてご連絡いたしました。',
        '山田様\n\n貴社の高橋様にもよろしくお伝えください。'
    ]) {
        const r = RE.analyze(baseMail({
            to: [addr('yamada@client-c.co.jp', '山田')], bodyText: body
        }), h, {});
        assert.ok(!types(r).some(t => t.startsWith('greeting')), `false positive: ${body}`);
    }
});

test('回帰: 社名宛名・カタカナ社名・Dear all・未知の社名では出ない', () => {
    const h = historyWith({
        recipients: {
            'info@tanaka-shoji.co.jp': { c: 20 },
            'sales@softbank-biz.co.jp': { c: 10 },
            'a@ex.com': { c: 5 }, 'b@ex.com': { c: 5 }
        },
        domains: ['tanaka-shoji.co.jp', 'softbank-biz.co.jp', 'ex.com']
    });
    const cases = [
        { to: [addr('info@tanaka-shoji.co.jp')], body: '田中商事様\n\nお世話になります。' },
        { to: [addr('sales@softbank-biz.co.jp')], body: 'ソフトバンク様\n\nお世話になります。' },
        { to: [addr('a@ex.com'), addr('b@ex.com')], body: 'Dear all,\n\nPlease find below.' },
        { to: [addr('info@tanaka-shoji.co.jp')], body: '楽天様\n\nお世話になります。' } // 辞書外の社名 → 判定不能で黙る
    ];
    for (const c of cases) {
        const r = RE.analyze(baseMail({ to: c.to, bodyText: c.body }), h, {});
        assert.ok(!types(r).some(t => t.startsWith('greeting')), `false positive: ${c.body}`);
    }
});

test('回帰: 田中様→info@tanaka-shoji.co.jp はドメイン照合で一致（出ない）', () => {
    const h = historyWith({
        recipients: { 'info@tanaka-shoji.co.jp': { c: 20 } },
        domains: ['tanaka-shoji.co.jp']
    });
    const r = RE.analyze(baseMail({
        to: [addr('info@tanaka-shoji.co.jp')],
        bodyText: '田中様\n\nお世話になります。'
    }), h, {});
    assert.ok(!types(r).some(t => t.startsWith('greeting')));
});

test('回帰: 伊藤様→saito@ を部分文字列一致で見逃さない（suggest は ito@）', () => {
    const h = historyWith({
        recipients: {
            'saito@x.co.jp': { c: 50, n: '' },
            'ito@x.co.jp': { c: 5, n: '伊藤' }
        },
        domains: ['x.co.jp'],
        pairAcks: ['ito@x.co.jp|saito@x.co.jp']
    });
    const r = RE.analyze(baseMail({
        to: [addr('saito@x.co.jp')],
        bodyText: '伊藤様\n\nお世話になっております。'
    }), h, {});
    const a = r.anomalies.find(x => x.type === 'greeting_mismatch_suggest');
    assert.ok(a, '伊藤様→saito@ は検出すべき');
    assert.equal(a.params[1], 'ito@x.co.jp', '表示名一致の ito@ を回数の多い部分一致より優先すべき');
});

test('回帰: 佐藤様→taro.sato@（セグメント一致）は出ない', () => {
    const h = historyWith({
        recipients: { 'taro.sato@x.co.jp': { c: 5 } },
        domains: ['x.co.jp']
    });
    const r = RE.analyze(baseMail({
        to: [addr('taro.sato@x.co.jp')],
        bodyText: '佐藤様\n\nお世話になります。'
    }), h, {});
    assert.ok(!types(r).some(t => t.startsWith('greeting')));
});

test('回帰: Dear Professor Smith は smith を抽出（essor ではない）', () => {
    assert.deepEqual(RE.extractGreetings('Dear Professor Smith,\n\nHello.'), ['smith']);
    assert.deepEqual(RE.extractGreetings('Dear all,\n\nHello.'), []);
});

test('回帰: 連名「佐藤様、田中様」は両方抽出', () => {
    assert.deepEqual(RE.extractGreetings('佐藤様、田中様\n\nお世話になります。'), ['佐藤', '田中']);
});

test('回帰: known_lookalike は類似する全ペアを一度に学習する（連続ダイアログ防止）', () => {
    const h = historyWith({
        recipients: {
            'k.sato@x.co.jp': { c: 50 },
            'y.sato@x.co.jp': { c: 30 },
            't.sato@x.co.jp': { c: 10 },
            'm.sato@x.co.jp': { c: 1 }
        },
        domains: ['x.co.jp']
    });
    const mail = baseMail({ to: [addr('m.sato@x.co.jp')], bodyText: 'お世話になります。' });
    const r1 = RE.analyze(mail, h, {});
    assert.ok(types(r1).includes('known_lookalike'));
    assert.equal(r1.learn.pairAcks.length, 3, '類似3ペアすべて学習対象になるべき');
    // 学習を適用すると以後は出ない
    for (const k of r1.learn.pairAcks) h.pairAcks[k] = 1;
    const r2 = RE.analyze(mail, h, {});
    assert.ok(!types(r2).includes('known_lookalike'));
});

test('回帰: 定型件名+共通の内部CCで新規客先に thread_new を出さない', () => {
    const key = RE.subjectKey('ご請求書送付の件');
    const h = historyWith({
        recipients: {
            'keiri@client-a.co.jp': { c: 5 },
            'boss@mycompany.co.jp': { c: 99 },
            'keiri@client-b.co.jp': { c: 5 }
        },
        domains: ['client-a.co.jp', 'client-b.co.jp', 'mycompany.co.jp'],
        threads: { [key]: { r: ['keiri@client-a.co.jp', 'boss@mycompany.co.jp'], t: 1 } }
    });
    const r = RE.analyze(baseMail({
        subject: 'ご請求書送付の件',
        to: [addr('keiri@client-b.co.jp')],
        cc: [addr('boss@mycompany.co.jp')]
    }), h, {});
    assert.ok(!types(r).includes('thread_new'), '外部宛先が全入れ替えなら別件とみなすべき');
});

/* ---------------------------------------------------------------- */
/* 設定でオフにできる                                                 */
/* ---------------------------------------------------------------- */

test('3ルールとも設定でオフにできる', () => {
    const key = RE.subjectKey('Re: お見積りの件');
    const h = historyWith({
        recipients: {
            'sato@customer-a.co.jp': { c: 50, n: '佐藤' },
            'saito@customer-a.co.jp': { c: 1, n: '斉藤' }
        },
        domains: ['customer-a.co.jp'],
        threads: { [key]: { r: ['sato@customer-a.co.jp'], t: 1 } }
    });
    const r = RE.analyze(baseMail({
        subject: 'Re: お見積りの件',
        to: [addr('sato@customer-a.co.jp'), addr('saito@customer-a.co.jp', '斉藤')],
        bodyText: '田中様\n\nお世話になります。'
    }), h, { checkKnownLookalike: false, checkGreeting: false, checkThreadDelta: false });
    assert.ok(!types(r).some(t => t === 'known_lookalike' || t.startsWith('greeting') || t === 'thread_new'));
});
