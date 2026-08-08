'use strict';

(function (global) {
    function fmtTime(iso) {
        if (!iso) return '';
        try {
            return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (_) {
            return '';
        }
    }

    function laneLabel(lane) {
        if (lane === 'pinned') return 'PINNED';
        if (lane === 'ticker') return 'TICKER';
        if (lane === 'feed') return 'FEED';
        return String(lane || '').toUpperCase();
    }

    function priorityClass(priority) {
        if (priority === 'urgent') return 'comms-pri-urgent';
        if (priority === 'warn') return 'comms-pri-warn';
        return 'comms-pri-info';
    }

    function esc(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function filterForViewer(messages, opts = {}) {
        const { zone = null, showAll = false } = opts;
        if (showAll) return messages || [];
        return (messages || []).filter((m) => {
            const z = m.zone || '';
            if (!z || z === 'General') return true;
            if (!zone) return false;
            return z === zone;
        });
    }

    function zoneChip(zone) {
        const z = String(zone || '').trim();
        if (!z || z === 'General') return '';
        return `<span class="comms-zone-chip">${esc(z)}</span>`;
    }

    function renderFeedItem(msg, opts = {}) {
        const m = msg || {};
        const pri = priorityClass(m.priority);
        const meta = [
            laneLabel(m.lane),
            m.source === 'system' ? 'AUTO' : esc(m.posted_by || ''),
            fmtTime(m.posted_at),
        ].filter(Boolean).join(' · ');
        const actions = [];
        if (opts.canDismiss && m.msg_id) {
            actions.push(`<button type="button" class="comms-dismiss-btn" data-msg-id="${esc(m.msg_id)}">DISMISS</button>`);
        }
        if (opts.canPromote && m.msg_id && m.lane !== 'pinned') {
            actions.push(`<button type="button" class="comms-promote-btn" data-msg-id="${esc(m.msg_id)}">PIN</button>`);
        }
        const actionHtml = actions.length
            ? `<div class="comms-item-actions">${actions.join('')}</div>`
            : '';
        const chip = zoneChip(m.zone);
        return `<div class="comms-feed-item ${pri}" data-msg-id="${esc(m.msg_id)}">
            <div class="comms-feed-body">${chip}${esc(m.body)}</div>
            <div class="comms-feed-meta">${meta}</div>
            ${actionHtml}
        </div>`;
    }

    function renderPinnedBanner(messages) {
        const rows = (messages || []).filter(Boolean);
        if (!rows.length) return '';
        return rows.map((m) => {
            const urgent = m.priority === 'urgent';
            const chip = zoneChip(m.zone);
            return `<div class="comms-pinned ${urgent ? 'comms-pinned-urgent' : 'comms-pinned-warn'}">
                <span class="comms-pinned-label">${urgent ? 'CRITICAL' : 'PINNED'}</span>
                <span class="comms-pinned-body">${chip}${esc(m.body)}</span>
                <span class="comms-pinned-by">${esc(m.posted_by || '')}</span>
            </div>`;
        }).join('');
    }

    function tickerText(messages) {
        return (messages || [])
            .map((m) => m.body || m.message || '')
            .filter(Boolean)
            .map((body) => `NOTICE: ${body}`)
            .join(' | ');
    }

    global.TgpCommsCenter = {
        fmtTime,
        laneLabel,
        priorityClass,
        esc,
        filterForViewer,
        zoneChip,
        renderFeedItem,
        renderPinnedBanner,
        tickerText,
    };
}(typeof window !== 'undefined' ? window : global));
