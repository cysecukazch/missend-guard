/**
 * セキュリティ回帰テスト。
 * 監査（2026-08-19）で発見・修正した ReDoS と入力クランプを固定する。
 * 実行: node --test test/security.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RE = require('../src/risk-engine.js');

function ms(fn) {
    const s = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - s) / 1e6;
}

/* ---- ReDoS: メールアドレス正規表現（旧: O(n²)） ---- */
test('parseAddress: @なしの長大文字列でもフリーズしない', () => {
    const s = 'a'.repeat(200000);
    const t = ms(() => RE.parseAddress(s));
    assert.equal(RE.parseAddress(s), null);
    assert.ok(t < 50, `200k字で ${t.toFixed(1)}ms（線形なら数ms以内）`);
});

/* ---- ReDoS: 宛名パース正規表現（旧: "<" + 空白列で O(n³)） ---- */
test('parseAddress: 閉じ">"なしの巨大空白列でもフリーズしない', () => {
    const s = 'a<' + ' '.repeat(64000);
    const t = ms(() => RE.parseAddress(s));
    assert.ok(t < 50, `64k空白で ${t.toFixed(1)}ms`);
});

test('parseAddress: 複数トークンでも増幅しない', () => {
    const bad = Array(1000).fill('a<' + ' '.repeat(1000)).join(',');
    const t = ms(() => { for (const p of bad.split(/[,;]+/)) RE.parseAddress(p); });
    assert.ok(t < 200, `1000トークンで ${t.toFixed(1)}ms`);
});

/* ---- クランプ後も正しくパースできる ---- */
test('parseAddress: クランプ後も正当なアドレスは壊れない', () => {
    assert.deepEqual(RE.parseAddress('Taro@Example.co.jp'),
        { email: 'taro@example.co.jp', name: '' });
    assert.deepEqual(RE.parseAddress('"山田 太郎" <taro@example.co.jp>'),
        { email: 'taro@example.co.jp', name: '山田 太郎' });
    assert.deepEqual(RE.parseAddress("o'brien+tag@sub.example.co.jp"),
        { email: "o'brien+tag@sub.example.co.jp", name: '' });
});

test('parseAddress: 超長ローカル部は64字上限で切り出し、通常アドレスは維持', () => {
    // ローカル部が長くても {1,64} 上限で末尾64字ぶんが拾われる（クラッシュしないこと）
    const huge = 'x'.repeat(300) + '@example.com';
    const r = RE.parseAddress(huge);
    assert.ok(r && r.email.endsWith('@example.com'));
    assert.ok(r.email.length <= 64 + '@example.com'.length);
    // 通常のアドレスは前後に余白があっても拾える
    assert.deepEqual(RE.parseAddress('  contact@example.com  '),
        { email: 'contact@example.com', name: '' });
});

/* ---- 件名 ReDoS（Re:×N が線形であること） ---- */
test('subjectKey: Re:×大量でもフリーズしない', () => {
    const s = 'Re:'.repeat(60000) + '本題です';
    const t = ms(() => RE.subjectKey(s));
    assert.ok(t < 100, `Re:×60000で ${t.toFixed(1)}ms`);
});

/* ---- 本文の宛名抽出が長大入力で安全 ---- */
test('extractGreetings: 長大本文でもフリーズしない', () => {
    const body = ('様'.repeat(1000) + '\n').repeat(100);
    const t = ms(() => RE.extractGreetings(body));
    assert.ok(t < 50, `長大本文で ${t.toFixed(1)}ms`);
});

/* ---- プロトタイプ汚染: 危険キーが履歴マップに侵入しないこと ---- */
test('analyze: __proto__/constructor を含むメールでも汚染されない', () => {
    // メールアドレスの文字クラスとキー構造上 __proto__ 単体キーは生成不能だが、
    // 念のため解析後に Object.prototype が汚れていないことを確認する
    const before = Object.prototype.polluted;
    const mail = {
        to: [{ email: '__proto__@evil.example', name: 'x' },
             { email: 'constructor@evil.example', name: 'y' }],
        cc: [], bcc: [], subject: 'テスト', bodyText: '', attachments: [],
        fromEmail: 'me@mycompany.co.jp'
    };
    const r = RE.analyze(mail, { recipients: {}, domains: {}, combos: {}, pairAcks: {}, greetAcks: {}, threads: {} }, {});
    assert.equal(Object.prototype.polluted, before);
    assert.equal(({}).polluted, undefined);
    // learn のキーに使われる email はそのまま（危険キーは @ を含むので通常プロパティ）
    assert.ok(Array.isArray(r.learn.recipients));
});
