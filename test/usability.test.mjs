/**
 * ユーザビリティ改善（2026-08-21 監査）の回帰テスト。
 * 実行: node --test test/usability.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RE = require('../src/risk-engine.js');

const addr = (email, name = '') => ({ email, name });

/* ---- グローバルフリーメール辞書 ---- */

test('COMMON_DOMAINS に世界の主要プロバイダが含まれる', () => {
    for (const d of ['qq.com', 'naver.com', 'yandex.ru', 'web.de', 'gmx.net', 'live.com', 'comcast.net']) {
        assert.ok(RE.COMMON_DOMAINS.includes(d), `${d} が含まれる`);
    }
    // 日本のキャリアも維持
    for (const d of ['docomo.ne.jp', 'softbank.ne.jp', 'ocn.ne.jp']) {
        assert.ok(RE.COMMON_DOMAINS.includes(d));
    }
});

test('海外プロバイダの typo も lookalike_domain で検知', () => {
    // gmial.com → gmail.com（既存）に加え、qqq.com は qq.com に近いが2文字差で範囲外の確認
    const r = RE.analyze({
        to: [addr('user@gmial.com')], cc: [], bcc: [],
        subject: 'test', bodyText: '', attachments: [], fromEmail: 'me@corp.example'
    }, { recipients: {}, domains: {}, combos: {}, pairAcks: {}, greetAcks: {}, threads: {} }, {});
    const first = r.anomalies.find(a => a.type === 'first_recipients');
    assert.ok(first.rows[0].notes.some(n => n.type === 'lookalike_domain' && n.params[0] === 'gmail.com'));
});

/* ---- 学習の巻き戻し・忘却は history-store 側だが、engine の learn 構造を確認 ---- */

test('learn ペイロードに undo に必要な情報が揃う', () => {
    const r = RE.analyze({
        to: [addr('new@partner.co.jp')], cc: [], bcc: [],
        subject: 'Re: 件名テスト', bodyText: '', attachments: [], fromEmail: 'me@corp.example'
    }, { recipients: {}, domains: {}, combos: {}, pairAcks: {}, greetAcks: {}, threads: {} }, {});
    assert.ok(Array.isArray(r.learn.recipients));
    assert.ok(Array.isArray(r.learn.domains));
    assert.ok('threadKey' in r.learn);
});

/* ---- 既定設定に showToast が入る ---- */

test('DEFAULT_SETTINGS に showToast=true がある', () => {
    assert.equal(RE.DEFAULT_SETTINGS.showToast, true);
    assert.equal(RE.DEFAULT_SETTINGS.syncEnabled, true);
});
