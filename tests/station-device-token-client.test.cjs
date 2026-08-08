'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const appRoot = path.resolve(__dirname, '..');
const modulePath = path.join(appRoot, 'client/src/lib/stationDeviceToken.js');

test('receiving and markdown capture only fragment action credentials', async (t) => {
    const originalWindow = global.window;
    t.after(() => { global.window = originalWindow; });

    for (const [purpose, route] of [['receiving', '/rec'], ['markdown', '/markdown']]) {
        await t.test(purpose, async () => {
            const stored = new Map();
            const historyUrls = [];
            global.window = {
                location: { href: `https://store.example${route}?safe=1#deviceToken=SECRET-${purpose}&view=work` },
                localStorage: {
                    getItem: (key) => stored.get(key) || null,
                    setItem: (key, value) => stored.set(key, value),
                },
                history: {
                    state: null,
                    replaceState: (_state, _title, url) => historyUrls.push(url),
                },
            };
            const station = await import(`${pathToFileURL(modulePath).href}?case=${purpose}-${Math.random()}`);
            assert.equal(station.captureStationDeviceTokenFromUrl(purpose), `SECRET-${purpose}`);
            assert.equal(station.getStationDeviceToken(purpose), `SECRET-${purpose}`);
            assert.deepEqual(historyUrls, [`${route}?safe=1#view=work`]);
            assert.equal(historyUrls[0].includes('SECRET'), false);
        });
    }
});

test('station action clients use the stored credential only for mutation requests', () => {
    const rec = fs.readFileSync(path.join(appRoot, 'client/src/rec/RecApp.jsx'), 'utf8');
    const markdown = fs.readFileSync(path.join(appRoot, 'client/src/markdown/MarkdownApp.jsx'), 'utf8');
    const actions = fs.readFileSync(path.join(appRoot, 'client/src/lib/actions.js'), 'utf8');
    for (const source of [rec, markdown]) {
        assert.match(source, /captureStationDeviceTokenFromUrl/);
        assert.match(source, /getStationDeviceToken/);
        assert.match(source, /deviceToken/);
    }
    assert.match(actions, /['"]x-device-token['"]/);
    assert.doesNotMatch(rec, /getSync\(deviceToken\)/);
    assert.doesNotMatch(markdown, /getSync\(deviceToken\)/);
});
