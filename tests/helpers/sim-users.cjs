'use strict';

const { json, CS, readManagerCredentials } = require('./api-client.cjs');

/** Fixed personas used across simulation + UI tests. */
function buildPersonas() {
    const manager = readManagerCredentials();
    return {
        manager: { name: manager.name, pin: manager.pin, role: 'manager' },
        clerkA: { name: 'Playwright E2E', pin: 'pw-e2e-9f2a1c', role: 'clerk' },
        cs: { deviceToken: CS.deviceToken, role: 'cs' },
    };
}

const PERSONAS = buildPersonas();

/**
 * Authenticate all personas; returns map of role -> { ...persona, token }.
 * CS desk uses the isolated fixture's paired device token.
 */
async function authenticatePersonas() {
    const personas = buildPersonas();
    const out = { cs: { ...personas.cs, token: null } };
    for (const [key, p] of Object.entries(personas)) {
        if (key === 'cs') continue;
        const auth = await json('POST', '/api/mobile-auth', { name: p.name, pin: p.pin });
        if (!auth.token) throw new Error(`No token for ${p.name}`);
        out[key] = { ...p, token: auth.token };
    }
    return out;
}

function userContext(persona) {
    if (persona.deviceToken) return { deviceToken: persona.deviceToken };
    return { name: persona.name, pin: persona.pin, token: persona.token };
}

/** Seeded PRNG (mulberry32) for reproducible daily patterns. */
function createRng(seed = 20260519) {
    let s = seed >>> 0;
    return () => {
        s += 0x6D2B79F5;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

module.exports = { PERSONAS, authenticatePersonas, userContext, createRng };
