'use strict';

const { extractMarkdownScanText: extractLocal } = require('./markdown-ocr.cjs');

/**
 * Optional cloud OCR when TGP_OCR_MODE=cloud|auto and API key is set.
 * Falls back to local Scribe when auto and cloud fails.
 */
async function extractMarkdownScanTextCloud(filename, contentBase64) {
    const provider = String(process.env.TGP_OCR_PROVIDER || 'openai').toLowerCase();
    const apiKey = process.env.TGP_OCR_API_KEY || process.env.OPENAI_API_KEY || '';
    if (!apiKey) {
        const err = new Error('Cloud OCR requires TGP_OCR_API_KEY or OPENAI_API_KEY.');
        err.status = 503;
        throw err;
    }

    if (provider === 'openai') {
        const buf = Buffer.from(String(contentBase64 || ''), 'base64');
        if (!buf.length) throw Object.assign(new Error('Empty upload.'), { status: 400 });

        const mime = /\.png$/i.test(filename) ? 'image/png'
            : /\.jpe?g$/i.test(filename) ? 'image/jpeg'
                : 'application/pdf';

        const body = {
            model: process.env.TGP_OCR_MODEL || 'gpt-4o-mini',
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: 'Extract all text from this FIFO expiry / markdown log scan. Return plain text only, preserve rows and dates.',
                    },
                    {
                        type: 'image_url',
                        image_url: { url: `data:${mime};base64,${buf.toString('base64')}` },
                    },
                ],
            }],
            max_tokens: 4096,
        };

        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const detail = await res.text();
            const err = new Error(`Cloud OCR failed (${res.status}): ${detail.slice(0, 200)}`);
            err.status = res.status >= 500 ? 503 : 400;
            throw err;
        }
        const json = await res.json();
        return String(json?.choices?.[0]?.message?.content || '').trim();
    }

    const err = new Error(`Unsupported TGP_OCR_PROVIDER: ${provider}`);
    err.status = 400;
    throw err;
}

async function extractMarkdownScanText(filename, contentBase64) {
    const mode = String(process.env.TGP_OCR_MODE || 'local').toLowerCase();
    if (mode === 'cloud') {
        return extractMarkdownScanTextCloud(filename, contentBase64);
    }
    if (mode === 'auto') {
        try {
            return await extractMarkdownScanTextCloud(filename, contentBase64);
        } catch (e) {
            console.warn('[OCR] cloud failed, falling back to local:', e.message);
            return extractLocal(filename, contentBase64);
        }
    }
    return extractLocal(filename, contentBase64);
}

module.exports = {
    extractMarkdownScanText,
    extractMarkdownScanTextCloud,
};
