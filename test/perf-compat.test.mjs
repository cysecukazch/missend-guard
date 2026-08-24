/**
 * 性能・互換性の回帰テスト（2026-08-19 監査で発見した問題を固定）。
 * 実行: node --test test/perf-compat.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RE = require('../src/risk-engine.js');

const addr = (email, name = '') => ({ email, name });

/* ---------------------------------------------------------------- */
/* タブタイトルからの From 推定（件名にアドレスが含まれても汚染されない） */
/* ---------------------------------------------------------------- */

test('lastEmailIn: 件名にアドレスが含まれても末尾の自アカウントが勝つ', () => {
    assert.equal(
        RE.lastEmailIn('Fwd: 請求書 billing@vendor-corp.jp の件 - me@gmail.com - Gmail'),
        'me@gmail.com');
    // 攻撃的な件名（"- Gmail" を偽装）でも末尾が勝つ
    assert.equal(
        RE.lastEmailIn('x - evil@attacker.example - Gmail - me@gmail.com - Gmail'),
        'me@gmail.com');
});

test('lastEmailIn: アドレスが無ければ空文字', () => {
    assert.equal(RE.lastEmailIn('新規メッセージ'), '');
    assert.equal(RE.lastEmailIn(''), '');
});

test('lastEmailIn: 長大タイトルでもフリーズしない（末尾320字のみ走査）', () => {
    const t0 = process.hrtime.bigint();
    const r = RE.lastEmailIn('a'.repeat(500000) + ' - me@gmail.com - Gmail');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(r, 'me@gmail.com');
    assert.ok(ms < 20, `${ms.toFixed(1)}ms`);
});

/* ---------------------------------------------------------------- */
/* analyze() の送信時同期コスト（履歴3000件 × レア既知宛先50件）       */
/* ---------------------------------------------------------------- */

test('analyze: 履歴3000件+類似多発の50宛先でも 150ms 未満', () => {
    // 類似が多発する最悪形: 同一ドメインに同じ長さのローカル部が大量に並ぶ
    const hist = { recipients: {}, domains: {}, combos: {}, pairAcks: {}, greetAcks: {}, threads: {} };
    for (let i = 0; i < 3000; i++) {
        const email = `user${String(i).padStart(4, '0')}@corp.example`;
        hist.recipients[email] = { c: 10, t: 1 };
    }
    hist.domains['corp.example'] = { c: 3000, t: 1 };
    // 送信回数の少ないレア既知宛先 50 件（known_lookalike の探索対象）
    const to = [];
    for (let i = 0; i < 50; i++) {
        const email = `user${String(i).padStart(4, '0')}x@corp.example`; // 1文字違い
        hist.recipients[email] = { c: 1, t: 1 };
        to.push(addr(email));
    }
    const mail = {
        to, cc: [], bcc: [],
        subject: 'ご案内', bodyText: 'お世話になっております。',
        attachments: [], fromEmail: 'me@mycompany.co.jp'
    };
    // マシン負荷による変動に強いよう、3回計測のベストで判定する
    let best = Infinity, r = null;
    for (let i = 0; i < 3; i++) {
        const t0 = process.hrtime.bigint();
        r = RE.analyze(mail, hist, {});
        best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    assert.ok(r.anomalies.length > 0, '類似検知自体は機能していること');
    assert.ok(best < 150, `analyze に ${best.toFixed(1)}ms（監査前は 283ms）`);
});

test('analyze: 足切り後も検知結果は従来と同じ（sato/saito）', () => {
    const hist = { recipients: {
        'sato@customer-a.co.jp': { c: 50, t: 1 },
        'saito@customer-a.co.jp': { c: 1, t: 1 }
    }, domains: { 'customer-a.co.jp': { c: 51, t: 1 } }, combos: {}, pairAcks: {}, greetAcks: {}, threads: {} };
    const r = RE.analyze({
        to: [addr('saito@customer-a.co.jp')], cc: [], bcc: [],
        subject: 'ご確認', bodyText: '', attachments: [],
        fromEmail: 'me@mycompany.co.jp'
    }, hist, {});
    const a = r.anomalies.find(x => x.type === 'known_lookalike');
    assert.ok(a, '既知同士の取り違え検知が維持されていること');
    assert.equal(a.rows[0].notes[0].params[0], 'sato@customer-a.co.jp');
});

test('analyze: 長さ差3以上の既知アドレスは類似扱いされない（足切りの正しさ）', () => {
    const hist = { recipients: {
        'verylongaddress@customer-a.co.jp': { c: 50, t: 1 }
    }, domains: { 'customer-a.co.jp': { c: 50, t: 1 } }, combos: {}, pairAcks: {}, greetAcks: {}, threads: {} };
    const r = RE.analyze({
        to: [addr('abc@customer-a.co.jp')], cc: [], bcc: [],
        subject: 'ご確認', bodyText: '', attachments: [],
        fromEmail: 'me@mycompany.co.jp'
    }, hist, {});
    const first = r.anomalies.find(x => x.type === 'first_recipients');
    assert.ok(first);
    assert.ok(!first.rows[0].notes.some(n => n.type === 'lookalike_recipient'));
});
