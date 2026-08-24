/**
 * 実 Gmail 検証（2026-08-21）で確定した不具合の回帰テスト。
 *   1. 本文が <div> 区切りで改行が消え、宛名検知が死んでいた
 *   2. 履歴ゼロのスレッド返信では thread_new が一切効かなかった
 * 実行: node --test test/real-gmail-regressions.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RE = require('../src/risk-engine.js');

const addr = (email, name = '') => ({ email, name });
const EMPTY = { recipients: {}, domains: {}, combos: {}, pairAcks: {}, greetAcks: {}, threads: {} };

function mail(over = {}) {
    return Object.assign({
        to: [], cc: [], bcc: [],
        subject: 'ご確認のお願い', bodyText: '', attachments: [],
        fromEmail: 'me@example.com', threadParticipants: []
    }, over);
}
const types = r => r.anomalies.map(a => a.type);

/* --- 1. 宛名検知（改行が復元されたテキストで機能すること） --------- */

test('宛名: 改行入り本文（修正後の getBodyText 出力形式）で斉藤さん→sato@gmai.com を検知', () => {
    // 実 Gmail DOM「斉藤さん<div><br></div><div>本文</div>」を修正版 getBodyText が
    // 変換した結果と同じ形のテキスト
    const bodyText = '斉藤さん\n\nいつもお世話になっております。よろしくお願いいたします。\n';
    const r = RE.analyze(mail({
        to: [addr('sato@gmai.com')],
        bodyText
    }), EMPTY, {});
    assert.ok(types(r).some(t => t.startsWith('greeting_mismatch')),
        '斉藤さん宛の本文 + sato@ 宛先はミスマッチとして検知すべき');
});

test('宛名: 改行が無い連結テキスト（修正前の形式）では検知できないことの記録', () => {
    // 修正の必要性を示す証拠テスト: textContent 連結形式では構造的に検知不能
    const r = RE.analyze(mail({
        to: [addr('sato@gmai.com')],
        bodyText: '斉藤さんいつもお世話になっております。'
    }), EMPTY, {});
    assert.ok(!types(r).some(t => t.startsWith('greeting_mismatch')));
});

/* --- 1b. 宛名警告の「疑いの根拠」ゲート ----------------------------- */

test('宛名: 根拠ゼロ（無関係な宛先・履歴なし）では出ない', () => {
    // 斉藤さん宛の本文を yamada@ に送る。履歴に斉藤は居ない＝照合材料ゼロ
    // （趣味アドレスや共有窓口への宛名で毎回鳴らないための仕様）
    const r = RE.analyze(mail({
        to: [addr('yamada@x.co.jp')],
        bodyText: '斉藤さん\n\nお世話になっております。'
    }), EMPTY, { checkFirstRecipient: false, checkLookalike: false });
    assert.ok(!types(r).some(t => t.startsWith('greeting')));
});

test('宛名: 打ち間違いの根拠（saito↔sato）があれば出て、相手を明示する', () => {
    const r = RE.analyze(mail({
        to: [addr('sato@gmai.com')],
        bodyText: '斉藤さん\n\nお世話になっております。'
    }), EMPTY, { checkFirstRecipient: false, checkLookalike: false });
    const a = r.anomalies.find(x => x.type === 'greeting_mismatch');
    assert.ok(a, 'saito↔sato は打ち間違いの疑いとして検知すべき');
    assert.equal(a.params[1], 'sato@gmai.com');
});

test('宛名: 漢字表示名の近似（佐藤↔斉藤）も根拠になる', () => {
    const r = RE.analyze(mail({
        to: [addr('ss2020@x.co.jp', '佐藤')],
        bodyText: '斉藤様\n\nお世話になっております。'
    }), EMPTY, { checkFirstRecipient: false, checkLookalike: false });
    assert.ok(types(r).includes('greeting_mismatch'));
});

test('宛名: 過去の宛先に一致する相手がいれば suggest として出る（従来どおり）', () => {
    const hist = Object.assign({}, EMPTY, {
        recipients: { 'saito@client.co.jp': { c: 10, t: 1, n: '斉藤' } }
    });
    const r = RE.analyze(mail({
        to: [addr('yamada@x.co.jp')],
        bodyText: '斉藤さん\n\nお世話になっております。'
    }), hist, { checkFirstRecipient: false, checkLookalike: false });
    const a = r.anomalies.find(x => x.type === 'greeting_mismatch_suggest');
    assert.ok(a);
    assert.equal(a.params[1], 'saito@client.co.jp');
});

/* --- 2. スレッド参加者による初回検知 ------------------------------- */

test('thread: 履歴ゼロでも、スレッド参加者に居ない宛先の追加を検知する', () => {
    const r = RE.analyze(mail({
        subject: 'Re: 打ち合わせの件',
        to: [addr('partner@client.co.jp'), addr('stranger@other.co.jp')],
        threadParticipants: ['partner@client.co.jp', 'me@example.com']
    }), EMPTY, {});
    const a = r.anomalies.find(x => x.type === 'thread_new');
    assert.ok(a, '参加者に居ない stranger@ を検知すべき');
    assert.deepEqual(a.rows.map(x => x.email), ['stranger@other.co.jp']);
});

test('thread: スレッド参加者だけに返信するなら警告しない', () => {
    const r = RE.analyze(mail({
        subject: 'Re: 打ち合わせの件',
        to: [addr('partner@client.co.jp')],
        threadParticipants: ['partner@client.co.jp', 'me@example.com']
    }), EMPTY, {});
    assert.ok(!types(r).includes('thread_new'));
});

test('thread: 転送（Fwd:/転送:）は参加者ベースの判定をしない（毎回警告を防ぐ）', () => {
    for (const subject of ['Fwd: 打ち合わせの件', 'Fw: 打ち合わせの件', '転送: 打ち合わせの件']) {
        const r = RE.analyze(mail({
            subject,
            to: [addr('boss2@client.co.jp')],
            threadParticipants: ['partner@client.co.jp', 'me@example.com']
        }), EMPTY, {});
        assert.ok(!types(r).includes('thread_new'), `${subject} で誤警告`);
    }
});

test('thread: 学習履歴と参加者は統合される（履歴で確認済みなら参加者に居なくても警告しない）', () => {
    const key = RE.subjectKey('Re: 打ち合わせの件');
    const hist = Object.assign({}, EMPTY, {
        threads: { [key]: { r: ['stranger@other.co.jp'], t: 1 } }
    });
    const r = RE.analyze(mail({
        subject: 'Re: 打ち合わせの件',
        to: [addr('partner@client.co.jp'), addr('stranger@other.co.jp')],
        threadParticipants: ['partner@client.co.jp', 'me@example.com']
    }), hist, {});
    assert.ok(!types(r).includes('thread_new'), '一度確認した宛先は再警告しない');
});

test('thread: threadParticipants が無い従来入力でも既存挙動を維持', () => {
    const key = RE.subjectKey('Re: お見積りの件');
    const hist = Object.assign({}, EMPTY, {
        recipients: { 'a@x.co.jp': { c: 5, t: 1 }, 'b@y.co.jp': { c: 5, t: 1 } },
        threads: { [key]: { r: ['a@x.co.jp'], t: 1 } }
    });
    const m = {
        to: [addr('a@x.co.jp'), addr('b@y.co.jp')], cc: [], bcc: [],
        subject: 'Re: お見積りの件', bodyText: '', attachments: [],
        fromEmail: 'me@mycompany.co.jp'
        // threadParticipants 無し（旧形式の呼び出し）
    };
    const r = RE.analyze(m, hist, {});
    const a = r.anomalies.find(x => x.type === 'thread_new');
    assert.ok(a);
    assert.deepEqual(a.rows.map(x => x.email), ['b@y.co.jp']);
});
