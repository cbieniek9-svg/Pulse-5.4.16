'use strict';

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { logManagerAudit } = require('../../lib/audit-log.cjs');
const {
    listInvestigations,
    createInvestigation,
    getInvestigation,
    updateInvestigation,
    submitInvestigation,
    reopenInvestigation,
    signInvestigationRole,
    getAttachmentsDir,
    addAttachment,
    getAttachment,
    deleteAttachment,
} = require('../../lib/incident-investigations.cjs');
const { buildInvestigationPdf } = require('../../lib/incident-investigation-pdf.cjs');
const { getStoreMeta } = require('../../constants/store-meta.cjs');
const { canAccessSafeInspections, isManagerRole } = require('../../lib/staff-permissions.cjs');

const ATTACHMENT_KINDS = new Set(['photo', 'sketch', 'pdf', 'other']);
const ALLOWED_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
]);

function safeStoredName(originalName) {
    const basename = path.basename(String(originalName || 'attachment'));
    const sanitized = basename.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '');
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${sanitized || 'attachment'}`;
}

function registerIncidentInvestigationRoutes(server, ctx) {
    const { wrap, fail, requireSession, db, getStoreDateStamp, broadcastUpdate } = ctx;

    const requireSafeAccess = (req, res) => {
        const session = requireSession(req, res, false);
        if (!session) return null;
        if (!canAccessSafeInspections(db, session)) {
            fail(res, 403, 'Manager login or Safety inspections permission required for /safe.');
            return null;
        }
        return session;
    };

    const requireSafeAccessMiddleware = (req, res, next) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        req.incidentInvestigationSession = session;
        next();
    };

    const upload = multer({
        storage: multer.diskStorage({
            destination(req, file, callback) {
                const investigation = getInvestigation(db, req.params.id);
                if (!investigation) {
                    const err = new Error('Investigation not found.');
                    err.status = 404;
                    return callback(err);
                }
                if (investigation.attachments.length >= 30) {
                    const err = new Error('An investigation can have at most 30 attachments.');
                    err.status = 400;
                    return callback(err);
                }
                const directory = getAttachmentsDir(req.params.id);
                fs.mkdirSync(directory, { recursive: true });
                callback(null, directory);
            },
            filename(req, file, callback) {
                callback(null, safeStoredName(file.originalname));
            },
        }),
        fileFilter(req, file, callback) {
            if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
                const err = new Error('Only JPEG, PNG, WebP, and PDF attachments are allowed.');
                err.status = 400;
                return callback(err);
            }
            callback(null, true);
        },
        limits: {
            fileSize: 10 * 1024 * 1024,
            files: 1,
        },
    });

    const uploadAttachment = (req, res, next) => {
        upload.single('file')(req, res, (err) => {
            if (!err) return next();
            if (err instanceof multer.MulterError) {
                return fail(
                    res,
                    400,
                    err.code === 'LIMIT_FILE_SIZE'
                        ? 'Attachment must be 10 MB or smaller.'
                        : err.message || 'Could not upload attachment.',
                );
            }
            fail(res, err.status || 400, err.message || 'Could not upload attachment.');
        });
    };

    server.get('/api/safety/investigations', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        const investigations = listInvestigations(db, {
            status: req.query?.status || '',
            limit: req.query?.limit,
        });
        res.json({ success: true, investigations });
    }));

    server.post('/api/safety/investigations', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        try {
            const settings = db.getSettings ? db.getSettings() : {};
            const investigation = createInvestigation(db, {
                actorName: session.name,
                serverTime: new Date().toISOString(),
                storeDateStamp: getStoreDateStamp(),
                retailName: getStoreMeta(settings).displayName,
            });
            logManagerAudit(db, {
                req,
                session,
                action: 'incident_investigation_created',
                targetType: 'incident_investigation',
                targetId: investigation.id,
                summary: `Started incident investigation ${investigation.incident_number}`,
            });
            if (typeof broadcastUpdate === 'function') {
                broadcastUpdate({ table: 'incident_investigations', action: 'insert', data: { id: investigation.id } });
            }
            res.json({ success: true, investigation });
        } catch (err) {
            fail(res, err.status || 500, err.message || 'Could not create investigation.');
        }
    }));

    server.get('/api/safety/investigations/:id', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        const investigation = getInvestigation(db, req.params.id);
        if (!investigation) return fail(res, 404, 'Investigation not found.');
        res.json({ success: true, investigation });
    }));

    server.patch('/api/safety/investigations/:id', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        try {
            const investigation = updateInvestigation(
                db,
                req.params.id,
                req.body || {},
                session.name,
                new Date().toISOString(),
            );
            logManagerAudit(db, {
                req,
                session,
                action: 'incident_investigation_updated',
                targetType: 'incident_investigation',
                targetId: investigation.id,
                summary: `Updated incident investigation ${investigation.incident_number}`,
            });
            if (typeof broadcastUpdate === 'function') {
                broadcastUpdate({ table: 'incident_investigations', action: 'update', id_col: 'id', id_val: req.params.id });
            }
            res.json({ success: true, investigation });
        } catch (err) {
            fail(res, err.status || 500, err.message || 'Could not save investigation.', err.code);
        }
    }));

    server.post('/api/safety/investigations/:id/submit', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        try {
            const before = getInvestigation(db, req.params.id);
            const isFirst = !before?.submitted_at;
            const investigation = submitInvestigation(db, req.params.id, session.name, new Date().toISOString());
            logManagerAudit(db, {
                req,
                session,
                action: 'incident_investigation_submitted',
                targetType: 'incident_investigation',
                targetId: investigation.id,
                summary: `Submitted incident investigation ${investigation.incident_number}`,
                metadata: { isFirst, postAmend: !isFirst },
            });
            if (typeof broadcastUpdate === 'function') {
                broadcastUpdate({ table: 'incident_investigations', action: 'update', id_col: 'id', id_val: req.params.id });
            }
            res.json({ success: true, investigation });
        } catch (err) {
            if (err.status === 400 && Array.isArray(err.missing)) {
                return res.status(400).json({ error: err.message, missing: err.missing });
            }
            fail(res, err.status || 500, err.message || 'Could not submit investigation.', err.code);
        }
    }));

    server.post('/api/safety/investigations/:id/reopen', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        try {
            const investigation = reopenInvestigation(db, req.params.id, session.name, {
                isManager: isManagerRole(session.role),
                serverTime: new Date().toISOString(),
            });
            logManagerAudit(db, {
                req,
                session,
                action: 'incident_investigation_reopened',
                targetType: 'incident_investigation',
                targetId: investigation.id,
                summary: `Reopened incident investigation ${investigation.incident_number}`,
            });
            if (typeof broadcastUpdate === 'function') {
                broadcastUpdate({ table: 'incident_investigations', action: 'update', id_col: 'id', id_val: req.params.id });
            }
            res.json({ success: true, investigation });
        } catch (err) {
            fail(res, err.status || 500, err.message || 'Could not reopen investigation.', err.code);
        }
    }));

    server.get('/api/safety/investigations/:id/export.pdf', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        const investigation = getInvestigation(db, req.params.id);
        if (!investigation) return fail(res, 404, 'Investigation not found.');
        try {
            const attachmentFiles = investigation.attachments.flatMap((attachment) => {
                const storedName = path.basename(String(attachment.stored_name || ''));
                if (!storedName || storedName !== attachment.stored_name) return [];
                const filePath = path.join(getAttachmentsDir(investigation.id), storedName);
                if (!fs.existsSync(filePath)) return [];
                return [{
                    mime: attachment.mime,
                    bytes: fs.readFileSync(filePath),
                    label: attachment.original_name,
                }];
            });
            const bytes = await buildInvestigationPdf({ investigation, attachmentFiles });
            const safeNumber = String(investigation.incident_number || investigation.id)
                .replace(/[^a-zA-Z0-9_-]/g, '_');
            const safeDate = String(investigation.incident_date || investigation.report_date || '')
                .replace(/[^0-9-]/g, '') || 'undated';
            logManagerAudit(db, {
                req,
                session,
                action: 'incident_investigation_exported',
                targetType: 'incident_investigation',
                targetId: investigation.id,
                summary: `Exported incident investigation ${investigation.incident_number}`,
            });
            res
                .status(200)
                .set('Content-Type', 'application/pdf')
                .set('Content-Disposition', `attachment; filename="Incident_Investigation_${safeNumber}_${safeDate}.pdf"`)
                .send(Buffer.from(bytes));
        } catch (err) {
            fail(res, err.status || 500, err.message || 'Could not export investigation PDF.');
        }
    }));

    server.post(
        '/api/safety/investigations/:id/attachments',
        requireSafeAccessMiddleware,
        uploadAttachment,
        wrap(async (req, res) => {
            const session = req.incidentInvestigationSession;
            const kind = String(req.body?.kind || req.query?.kind || '').trim();
            if (!ATTACHMENT_KINDS.has(kind)) {
                if (req.file) fs.unlinkSync(req.file.path);
                return fail(res, 400, 'Attachment kind must be photo, sketch, pdf, or other.');
            }
            if (!req.file) return fail(res, 400, 'Attachment file is required.');
            try {
                const attachment = addAttachment(db, req.params.id, {
                    kind,
                    originalName: req.file.originalname,
                    storedName: req.file.filename,
                    mime: req.file.mimetype,
                    sizeBytes: req.file.size,
                    actorName: session.name,
                    serverTime: new Date().toISOString(),
                });
                logManagerAudit(db, {
                    req,
                    session,
                    action: 'incident_investigation_attachment_added',
                    targetType: 'incident_investigation',
                    targetId: req.params.id,
                    summary: `Added attachment to investigation ${req.params.id}`,
                    metadata: { attachmentId: attachment.id, kind },
                });
                res.json({ success: true, attachment });
            } catch (err) {
                fs.unlinkSync(req.file.path);
                fail(res, err.status || 500, err.message || 'Could not save attachment.', err.code);
            }
        }),
    );

    server.get('/api/safety/investigations/:id/attachments/:attId', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        const attachment = getAttachment(db, req.params.id, req.params.attId);
        if (!attachment) return fail(res, 404, 'Attachment not found.');
        const filePath = path.join(getAttachmentsDir(req.params.id), attachment.stored_name);
        if (!fs.existsSync(filePath)) return fail(res, 404, 'Attachment file not found.');
        res.download(filePath, attachment.original_name);
    }));

    server.delete('/api/safety/investigations/:id/attachments/:attId', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        const attachment = getAttachment(db, req.params.id, req.params.attId);
        if (!attachment) return fail(res, 404, 'Attachment not found.');
        const filePath = path.join(getAttachmentsDir(req.params.id), attachment.stored_name);
        try {
            deleteAttachment(db, req.params.id, req.params.attId);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            logManagerAudit(db, {
                req,
                session,
                action: 'incident_investigation_attachment_deleted',
                targetType: 'incident_investigation',
                targetId: req.params.id,
                summary: `Deleted attachment from investigation ${req.params.id}`,
                metadata: { attachmentId: req.params.attId },
            });
            res.json({ success: true });
        } catch (err) {
            fail(res, err.status || 500, err.message || 'Could not delete attachment.', err.code);
        }
    }));

    server.post('/api/safety/investigations/:id/signatures/:role', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        try {
            const role = String(req.params.role || '');
            const updated = signInvestigationRole(
                db,
                req.params.id,
                role,
                req.body?.dataUrl,
                session.name,
                {
                    isManager: isManagerRole(session.role),
                    storeDate: getStoreDateStamp(),
                    serverTime: new Date().toISOString(),
                },
            );
            logManagerAudit(db, {
                req,
                session,
                action: 'incident_investigation_signed',
                targetType: 'incident_investigation',
                targetId: updated.id,
                summary: `Signed incident investigation ${updated.incident_number} as ${role}`,
                metadata: { role },
            });
            res.json({ success: true, investigation: updated });
        } catch (err) {
            fail(res, err.status || 500, err.message || 'Could not save signature.', err.code);
        }
    }));
}

module.exports = { registerIncidentInvestigationRoutes };
