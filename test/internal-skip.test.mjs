/**
 * 自社ドメイン宛スキップ（checkSkipInternal）の単体テスト。
 * 実行: node --test test/internal-skip.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RE = require('../src/risk-engine.js');

const addr = (email, name = '') => ({ email, name });
const EMPTY_HIST = { recipients: {}, domains: {}, combos: {}, pairAcks: {}, greetAcks: {}, threads: {} };

function mail(over = {}) {
    return Object.assign({
        to: [], cc: [], bcc: [],
        subject: '定例のご連絡',
        bodyText: 'お世話になっております。',
        attachments: [],
        fromEmail: 'me@mycompany.co.jp'
    }, over);
}

const types = r => r.anomalies.map(a => a.type);

test('自社ドメイン宛は初めてでも確認しない', () => {
    const r = RE.analyze(mail({ to: [addr('shinjin@mycompany.co.jp')] }), EMPTY_HIST, {});
    assert.deepEqual(types(r), []);
});

test('設定オフなら自社ドメイン宛も従来どおり確認する', () => {
    const r = RE.analyze(mail({ to: [addr('shinjin@mycompany.co.jp')] }), EMPTY_HIST,
        { checkSkipInternal: false });
    assert.ok(types(r).includes('first_recipients'));
});

test('From がフリーメールなら同一ドメインでも除外しない', () => {
    const r = RE.analyze(mail({
        fromEmail: 'me@gmail.com',
        to: [addr('someone@gmail.com')]
    }), EMPTY_HIST, {});
    assert.ok(types(r).includes('first_recipients'), 'gmail.com は「自社」ではない');
});

test('社内外混在: 外部の初回宛先だけ確認する', () => {
    const r = RE.analyze(mail({
        to: [addr('taro@customer-a.co.jp')],
        cc: [addr('boss@mycompany.co.jp')]
    }), EMPTY_HIST, {});
    const first = r.anomalies.find(a => a.type === 'first_recipients');
    assert.ok(first);
    assert.deepEqual(first.rows.map(x => x.email), ['taro@customer-a.co.jp']);
});

test('社内のみのメールは件名・To が空でも一切警告しない', () => {
    const r = RE.analyze(mail({
        subject: '',
        to: [],
        cc: [addr('boss@mycompany.co.jp')],
        bodyText: '資料を添付します。'
    }), EMPTY_HIST, {});
    assert.deepEqual(types(r), []);
});

test('社内の似たアドレス（known_lookalike）も確認しない', () => {
    const h = Object.assign({}, EMPTY_HIST, {
        recipients: {
            'k.sato@mycompany.co.jp': { c: 50, t: 1 },
            'm.sato@mycompany.co.jp': { c: 1, t: 1 }
        },
        domains: { 'mycompany.co.jp': { c: 51, t: 1 } }
    });
    const r = RE.analyze(mail({ to: [addr('m.sato@mycompany.co.jp')] }), h, {});
    assert.ok(!types(r).includes('known_lookalike'));
});

test('社内のみなら宛名ミスマッチも警告しない。混在なら警告する', () => {
    const h = Object.assign({}, EMPTY_HIST, {
        recipients: {
            'suzuki@mycompany.co.jp': { c: 5, t: 1, n: '鈴木' },
            'saito@customer-a.co.jp': { c: 5, t: 1, n: '斉藤' }
        },
        domains: { 'mycompany.co.jp': { c: 5, t: 1 }, 'customer-a.co.jp': { c: 5, t: 1 } }
    });
    // 社内のみ: 宛名「佐藤様」でも黙る
    const r1 = RE.analyze(mail({
        to: [addr('suzuki@mycompany.co.jp', '鈴木')],
        bodyText: '佐藤様\n\nお疲れ様です。'
    }), h, {});
    assert.ok(!types(r1).some(t => t.startsWith('greeting')));
    // 外部が混ざる: 従来どおり警告
    const r2 = RE.analyze(mail({
        to: [addr('saito@customer-a.co.jp', '斉藤')],
        cc: [addr('suzuki@mycompany.co.jp', '鈴木')],
        bodyText: '佐藤様\n\nお世話になっております。'
    }), h, {});
    assert.ok(types(r2).some(t => t.startsWith('greeting')));
});

test('学習は社内宛先も記録する（除外は確認だけ）', () => {
    const r = RE.analyze(mail({ to: [addr('shinjin@mycompany.co.jp')] }), EMPTY_HIST, {});
    assert.deepEqual(r.learn.recipients.map(x => x.email), ['shinjin@mycompany.co.jp']);
});
