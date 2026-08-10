'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { getAttachmentsDir } = require('./incident-investigations.cjs');
const {
    INCIDENT_TYPES,
    EVENT_TYPES,
    SUBSTANDARD_ACTS,
    SUBSTANDARD_CONDITIONS,
    ROOT_PERSONAL,
    ROOT_JOB,
    CORRECTIVE_AREAS,
    SUPPORTING_DOCS,
} = require('./incident-investigation-catalog.cjs');

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_X = 54;
const MARGIN_TOP = 54;
const MARGIN_BOTTOM = 54;
const CONTENT_WIDTH = PAGE_WIDTH - (MARGIN_X * 2);
const BODY = 10;
const SMALL = 9;
const TITLE = 16;
const SECTION = 12;
const LINE = 1.35;
const MUTED = rgb(0.35, 0.35, 0.35);
const RULE = rgb(0.75, 0.75, 0.75);
const MIN_TEXT_SIZE = 5.5;

const PERSON_TYPE_LABELS = {
    full_time: 'Full-time',
    part_time: 'Part-time',
    contractor: 'Contractor',
    customer: 'Customer',
};

const PROCESS_FIELDS = [
    { key: 'hazardAssessment', label: 'Hazard assessment completed' },
    { key: 'controlsImplemented', label: 'Controls implemented' },
    { key: 'jhaExists', label: 'JHA exists' },
    { key: 'jhaFollowed', label: 'JHA followed' },
];

const SIGNOFF_ROLES = [
    { key: 'lead', label: 'Lead investigator' },
    { key: 'safety_committee', label: 'Safety committee' },
    { key: 'senior_management', label: 'Senior management' },
];

function getValue(source, dottedKey) {
    return String(dottedKey || '').split('.').reduce((value, part) => {
        if (value == null) return undefined;
        return value[part];
    }, source);
}

/** StandardFonts are WinAnsi — strip characters outside Latin-1 printable range. */
function toWinAnsiSafe(text) {
    return String(text || '')
        .replace(/[^\u0009\u000A\u000D\u0020-\u007E\u00A0-\u00FF]/g, '?')
        .replace(/\s+/g, ' ')
        .trim();
}

function textValue(value) {
    if (value == null) return '';
    if (typeof value === 'object') return '';
    return toWinAnsiSafe(String(value));
}

function ynLabel(value) {
    const v = String(value || '').toLowerCase();
    if (v === 'yes') return 'Yes';
    if (v === 'no') return 'No';
    if (v === 'na') return 'N/A';
    return '—';
}

function formatDateTime(date, time, ampm) {
    const parts = [textValue(date), textValue(time), textValue(ampm)].filter(Boolean);
    return parts.join(' ') || '—';
}

function fitWithin(width, height, maxWidth, maxHeight) {
    const scale = Math.min(maxWidth / width, maxHeight / height, 1);
    return { width: width * scale, height: height * scale };
}

/** Shrink font until the full string fits. Never truncates. */
function fitSingleLine(font, text, size, maxWidth, minSize = MIN_TEXT_SIZE) {
    if (!text) return { text: '', size };
    if (!maxWidth || maxWidth <= 0) return { text, size };
    let fitSize = size;
    while (fitSize > minSize && font.widthOfTextAtSize(text, fitSize) > maxWidth) {
        fitSize -= 0.25;
    }
    return { text, size: fitSize };
}

/** Word-wrap the entire string (no truncation). */
function wrapAllText(font, text, size, maxWidth, { maxLines = Infinity, minSize = MIN_TEXT_SIZE } = {}) {
    if (!text) return { lines: [], size, overflow: '' };
    if (!maxWidth || maxWidth <= 0) return { lines: [text], size, overflow: '' };

    const words = text.split(/\s+/).filter(Boolean);
    const pack = (sz) => {
        const lines = [];
        let current = '';
        for (const word of words) {
            const chunks = [];
            if (font.widthOfTextAtSize(word, sz) <= maxWidth) {
                chunks.push(word);
            } else {
                let chunk = '';
                for (const ch of word) {
                    const next = chunk + ch;
                    if (chunk && font.widthOfTextAtSize(next, sz) > maxWidth) {
                        chunks.push(chunk);
                        chunk = ch;
                    } else {
                        chunk = next;
                    }
                }
                if (chunk) chunks.push(chunk);
            }
            for (const piece of chunks) {
                const next = current ? `${current} ${piece}` : piece;
                if (current && font.widthOfTextAtSize(next, sz) > maxWidth) {
                    lines.push(current);
                    current = piece;
                } else {
                    current = next;
                }
            }
        }
        if (current) lines.push(current);
        return lines;
    };

    let fitSize = size;
    let lines = pack(fitSize);
    while (fitSize > minSize && Number.isFinite(maxLines) && lines.length > maxLines) {
        fitSize -= 0.25;
        lines = pack(fitSize);
    }
    if (!Number.isFinite(maxLines) || lines.length <= maxLines) {
        return { lines, size: fitSize, overflow: '' };
    }
    return {
        lines: lines.slice(0, maxLines),
        size: fitSize,
        overflow: lines.slice(maxLines).join(' '),
    };
}

function selectedCatalogLabels(flags, catalog) {
    const selected = [];
    const map = flags && typeof flags === 'object' ? flags : {};
    for (const entry of catalog) {
        if (!map[entry.key]) continue;
        const prefix = entry.num != null ? `${entry.num}. ` : '';
        selected.push(`${prefix}${entry.label}`);
    }
    return selected;
}

function collectDescriptionText(investigation) {
    const lines = getValue(investigation, 'payload.descriptionLines');
    if (Array.isArray(lines)) {
        return lines.map((line) => textValue(line)).filter(Boolean).join(' ');
    }
    return textValue(lines);
}

function rowHasContent(row, keys) {
    if (!row || typeof row !== 'object') return false;
    return keys.some((key) => textValue(row[key]));
}

async function embedRasterImage(pdf, bytes, mime) {
    if (mime === 'image/jpeg' || mime === 'image/jpg') return pdf.embedJpg(bytes);
    if (mime === 'image/png') return pdf.embedPng(bytes);
    return null;
}

function createDoc(pdf, font, boldFont) {
    const state = {
        pdf,
        font,
        boldFont,
        page: null,
        y: 0,
    };

    function newPage() {
        state.page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        state.y = PAGE_HEIGHT - MARGIN_TOP;
    }

    function ensureSpace(height) {
        if (!state.page || state.y - height < MARGIN_BOTTOM) {
            newPage();
        }
    }

    function gap(amount = 8) {
        ensureSpace(amount);
        state.y -= amount;
    }

    function drawRule() {
        ensureSpace(10);
        state.page.drawLine({
            start: { x: MARGIN_X, y: state.y },
            end: { x: MARGIN_X + CONTENT_WIDTH, y: state.y },
            thickness: 0.75,
            color: RULE,
        });
        state.y -= 10;
    }

    function drawTextLine(text, {
        x = MARGIN_X,
        size = BODY,
        bold = false,
        color = rgb(0, 0, 0),
        maxWidth = CONTENT_WIDTH,
    } = {}) {
        const activeFont = bold ? boldFont : font;
        const fitted = fitSingleLine(activeFont, text, size, maxWidth);
        const lineH = fitted.size * LINE;
        ensureSpace(lineH);
        state.page.drawText(fitted.text, {
            x,
            y: state.y - fitted.size,
            size: fitted.size,
            font: activeFont,
            color,
        });
        state.y -= lineH;
    }

    function paragraph(text, { size = BODY, bold = false, color = rgb(0, 0, 0), indent = 0 } = {}) {
        const value = textValue(text);
        if (!value) {
            drawTextLine('—', { size, color: MUTED, x: MARGIN_X + indent });
            return;
        }
        const activeFont = bold ? boldFont : font;
        const width = CONTENT_WIDTH - indent;
        const packed = wrapAllText(activeFont, value, size, width, { maxLines: Infinity });
        for (const line of packed.lines) {
            drawTextLine(line, {
                x: MARGIN_X + indent,
                size: packed.size,
                bold,
                color,
                maxWidth: width,
            });
        }
    }

    function sectionTitle(title) {
        gap(14);
        ensureSpace(SECTION * LINE + 12);
        drawTextLine(title, { size: SECTION, bold: true });
        drawRule();
    }

    function kv(label, value) {
        const labelText = `${label}: `;
        const labelWidth = boldFont.widthOfTextAtSize(labelText, BODY);
        const activeValue = textValue(value) || '—';
        const packed = wrapAllText(font, activeValue, BODY, CONTENT_WIDTH - labelWidth, { maxLines: Infinity });
        packed.lines.forEach((line, index) => {
            ensureSpace(BODY * LINE);
            if (index === 0) {
                state.page.drawText(labelText, {
                    x: MARGIN_X,
                    y: state.y - BODY,
                    size: BODY,
                    font: boldFont,
                });
                state.page.drawText(line, {
                    x: MARGIN_X + labelWidth,
                    y: state.y - packed.size,
                    size: packed.size,
                    font,
                });
            } else {
                state.page.drawText(line, {
                    x: MARGIN_X + labelWidth,
                    y: state.y - packed.size,
                    size: packed.size,
                    font,
                });
            }
            state.y -= packed.size * LINE;
        });
    }

    function bullets(items, emptyMessage = 'None selected.') {
        if (!items.length) {
            paragraph(emptyMessage, { size: SMALL, color: MUTED });
            return;
        }
        for (const item of items) {
            paragraph(`• ${item}`, { size: BODY });
        }
    }

    function table(headers, rows, colWidths) {
        if (!rows.length) {
            paragraph('None recorded.', { size: SMALL, color: MUTED });
            return;
        }
        const drawRow = (cells, { bold = false, header = false } = {}) => {
            const activeFont = bold ? boldFont : font;
            const size = header ? SMALL : BODY;
            const packedCols = cells.map((cell, index) => (
                wrapAllText(activeFont, textValue(cell) || (header ? '' : '—'), size, colWidths[index] - 6, {
                    maxLines: Infinity,
                })
            ));
            const lineCount = Math.max(...packedCols.map((col) => Math.max(col.lines.length, 1)));
            const rowHeight = (lineCount * size * LINE) + 6;
            ensureSpace(rowHeight);
            let x = MARGIN_X;
            for (let col = 0; col < cells.length; col += 1) {
                const packed = packedCols[col];
                packed.lines.forEach((line, lineIndex) => {
                    state.page.drawText(line, {
                        x: x + 3,
                        y: state.y - size - (lineIndex * size * LINE),
                        size: packed.size,
                        font: activeFont,
                        color: header ? MUTED : rgb(0, 0, 0),
                    });
                });
                x += colWidths[col];
            }
            state.y -= rowHeight;
            state.page.drawLine({
                start: { x: MARGIN_X, y: state.y + 2 },
                end: { x: MARGIN_X + CONTENT_WIDTH, y: state.y + 2 },
                thickness: 0.4,
                color: RULE,
            });
        };
        drawRow(headers, { bold: true, header: true });
        for (const row of rows) drawRow(row);
    }

    newPage();
    return {
        state,
        gap,
        sectionTitle,
        kv,
        paragraph,
        bullets,
        table,
        drawTextLine,
        ensureSpace,
        newPage,
    };
}

async function drawSignoffs(doc, pdf, investigation) {
    const { sectionTitle, kv, gap, ensureSpace, state, paragraph } = doc;
    sectionTitle('Sign-off');
    for (const role of SIGNOFF_ROLES) {
        const block = getValue(investigation, `signoffs.${role.key}`) || {};
        kv(role.label, textValue(block.name) || '—');
        kv('Date', textValue(block.date) || '—');
        const filename = textValue(block.signatureFile);
        if (!filename || !investigation.id) {
            paragraph('Signature: not provided', { size: SMALL, color: MUTED });
            gap(10);
            continue;
        }
        const safeFilename = path.basename(filename);
        if (safeFilename !== filename) {
            paragraph('Signature: unavailable', { size: SMALL, color: MUTED });
            gap(10);
            continue;
        }
        const imagePath = path.join(getAttachmentsDir(investigation.id), safeFilename);
        if (!fs.existsSync(imagePath)) {
            paragraph('Signature: file missing', { size: SMALL, color: MUTED });
            gap(10);
            continue;
        }
        try {
            const image = await embedRasterImage(pdf, fs.readFileSync(imagePath), 'image/png');
            if (!image) {
                paragraph('Signature: could not embed', { size: SMALL, color: MUTED });
                gap(10);
                continue;
            }
            const size = fitWithin(image.width, image.height, 200, 56);
            ensureSpace(size.height + 16);
            state.page.drawText('Signature:', {
                x: MARGIN_X,
                y: state.y - SMALL,
                size: SMALL,
                font: state.boldFont,
                color: MUTED,
            });
            state.y -= SMALL + 4;
            state.page.drawImage(image, {
                x: MARGIN_X,
                y: state.y - size.height,
                ...size,
            });
            state.y -= size.height + 12;
        } catch {
            paragraph('Signature: could not embed', { size: SMALL, color: MUTED });
            gap(10);
        }
    }
}

async function appendImageAttachment(pdf, attachment, font) {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const label = textValue(attachment.label) || 'Image attachment';
    page.drawText(`Appendix attachment: ${label}`, { x: MARGIN_X, y: 744, size: 12, font });
    const image = await embedRasterImage(pdf, attachment.bytes, attachment.mime);
    if (!image) {
        page.drawText('WebP preview is unavailable in this PDF renderer.', {
            x: MARGIN_X, y: 710, size: 10, font, color: MUTED,
        });
        return;
    }
    const size = fitWithin(image.width, image.height, CONTENT_WIDTH, 650);
    page.drawImage(image, {
        x: (PAGE_WIDTH - size.width) / 2,
        y: 54 + ((650 - size.height) / 2),
        ...size,
    });
}

function appendPdfAttachmentList(pdf, attachments, font) {
    if (!attachments.length) return;
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.drawText('PDF attachments', { x: MARGIN_X, y: 744, size: 14, font });
    attachments.forEach((attachment, index) => {
        page.drawText(`• ${textValue(attachment.label) || `PDF attachment ${index + 1}`}`, {
            x: 72,
            y: 712 - (index * 18),
            size: 10,
            font,
        });
    });
}

function renderReport(doc, investigation) {
    const payload = investigation.payload || {};
    const { drawTextLine, gap, sectionTitle, kv, paragraph, bullets, table } = doc;

    drawTextLine('TGP Incident Investigation Report', { size: TITLE, bold: true });
    gap(4);
    drawTextLine('Generated report (Appendix B field schema)', { size: SMALL, color: MUTED });
    gap(12);

    kv('Incident number', investigation.incident_number || investigation.id);
    kv('Status', investigation.status || 'draft');
    kv('Date/time of report', formatDateTime(
        investigation.report_date,
        investigation.report_time,
        investigation.report_ampm,
    ));
    kv('Retail name', investigation.retail_name);
    kv('Person involved', investigation.person_involved);

    const personTypes = Object.entries(investigation.person_types || {})
        .filter(([, on]) => on)
        .map(([key]) => PERSON_TYPE_LABELS[key] || key);
    kv('Person type', personTypes.join(', ') || '—');
    kv('Incident date/time', formatDateTime(
        investigation.incident_date,
        investigation.incident_time,
        investigation.incident_ampm,
    ));

    const witnesses = Array.isArray(investigation.witnesses) ? investigation.witnesses : [];
    const witnessText = witnesses
        .map((w, index) => {
            const name = textValue(w?.name);
            const contact = textValue(w?.contact);
            if (!name && !contact) return '';
            return `${index + 1}. ${[name, contact].filter(Boolean).join(' — ')}`;
        })
        .filter(Boolean);
    kv('Witnesses', witnessText.join('; ') || '—');

    sectionTitle('Type of incident');
    const incidentTypes = selectedCatalogLabels(payload.incidentTypes, INCIDENT_TYPES);
    if (textValue(payload.incidentTypeOther)) {
        incidentTypes.push(`Other: ${textValue(payload.incidentTypeOther)}`);
    }
    bullets(incidentTypes);

    sectionTitle('Description of incident');
    paragraph(collectDescriptionText(investigation) || '—');

    sectionTitle('Process');
    const process = payload.process || {};
    for (const field of PROCESS_FIELDS) {
        kv(field.label, ynLabel(process[field.key]));
    }
    kv('Equipment / materials', process.equipmentMaterials);

    sectionTitle('Type of event');
    bullets(selectedCatalogLabels(payload.eventTypes, EVENT_TYPES));

    sectionTitle('Immediate / direct causes — substandard acts');
    const acts = selectedCatalogLabels(payload.substandardActs, SUBSTANDARD_ACTS);
    if (textValue(payload.substandardActsOther)) {
        acts.push(`Other: ${textValue(payload.substandardActsOther)}`);
    }
    bullets(acts);

    sectionTitle('Immediate / direct causes — substandard conditions');
    const conditions = selectedCatalogLabels(payload.substandardConditions, SUBSTANDARD_CONDITIONS);
    if (textValue(payload.substandardConditionsOther)) {
        conditions.push(`Other: ${textValue(payload.substandardConditionsOther)}`);
    }
    bullets(conditions);

    sectionTitle('How immediate causes contributed');
    table(
        ['I/D #', 'Explanation'],
        (payload.immediateContributions || [])
            .filter((row) => rowHasContent(row, ['idNum', 'explanation']))
            .map((row) => [row.idNum, row.explanation]),
        [54, CONTENT_WIDTH - 54],
    );

    sectionTitle('Basic / root causes — personal factors');
    const personal = selectedCatalogLabels(payload.rootPersonal, ROOT_PERSONAL);
    if (textValue(payload.rootPersonalOther)) {
        personal.push(`Other: ${textValue(payload.rootPersonalOther)}`);
    }
    bullets(personal);

    sectionTitle('Basic / root causes — job / system factors');
    const job = selectedCatalogLabels(payload.rootJob, ROOT_JOB);
    if (textValue(payload.rootJobOther)) {
        job.push(`Other: ${textValue(payload.rootJobOther)}`);
    }
    bullets(job);

    sectionTitle('How immediate causes relate to root causes');
    table(
        ['I/D #', 'B/R #', 'Explanation'],
        (payload.rootLinks || [])
            .filter((row) => rowHasContent(row, ['idNum', 'brNum', 'explanation']))
            .map((row) => [row.idNum, row.brNum, row.explanation]),
        [48, 48, CONTENT_WIDTH - 96],
    );

    sectionTitle('Corrective action areas');
    const corrective = selectedCatalogLabels(payload.correctiveAreas, CORRECTIVE_AREAS);
    if (textValue(payload.correctiveOther)) {
        corrective.push(`Other: ${textValue(payload.correctiveOther)}`);
    }
    bullets(corrective);

    sectionTitle('Corrective contribution links');
    table(
        ['I/D #', 'B/R #', 'CA #', 'Explanation'],
        (payload.correctiveLinks || [])
            .filter((row) => rowHasContent(row, ['idNum', 'brNum', 'caNum', 'explanation']))
            .map((row) => [row.idNum, row.brNum, row.caNum, row.explanation]),
        [42, 42, 42, CONTENT_WIDTH - 126],
    );

    sectionTitle('Action log');
    table(
        ['Action required', 'Responsible person', 'Due date'],
        (payload.actionLog || [])
            .filter((row) => rowHasContent(row, ['action', 'person', 'dueDate']))
            .map((row) => [row.action, row.person, row.dueDate]),
        [CONTENT_WIDTH - 220, 130, 90],
    );

    sectionTitle('Supporting documents');
    const docs = SUPPORTING_DOCS.map((entry) => {
        const row = (payload.supportingDocs || {})[entry.key] || {};
        return [
            entry.label,
            ynLabel(row.utilized),
            ynLabel(row.copyAttached),
        ];
    });
    table(['Document', 'Utilized', 'Copy attached'], docs, [CONTENT_WIDTH - 180, 90, 90]);
}

async function buildInvestigationPdf({ investigation, attachmentFiles = [] }) {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
    const doc = createDoc(pdf, font, boldFont);

    renderReport(doc, investigation || {});
    await drawSignoffs(doc, pdf, investigation || {});

    const pdfAttachments = [];
    for (const attachment of attachmentFiles) {
        if (!attachment?.bytes) continue;
        if (attachment.mime === 'application/pdf') {
            pdfAttachments.push(attachment);
            continue;
        }
        if (['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(attachment.mime)) {
            try {
                await appendImageAttachment(pdf, attachment, font);
            } catch {
                const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
                page.drawText(`Could not embed image attachment: ${textValue(attachment.label)}`, {
                    x: MARGIN_X, y: 744, size: 10, font,
                });
            }
        }
    }
    appendPdfAttachmentList(pdf, pdfAttachments, font);
    return pdf.save({ useObjectStreams: false });
}

module.exports = {
    buildInvestigationPdf,
    getValue,
    fitSingleLine,
    wrapAllText,
    collectDescriptionText,
};
