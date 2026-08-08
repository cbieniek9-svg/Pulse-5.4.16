'use strict';

const fs = require('fs');
const path = require('path');

let cached = null;

function templatePath() {
    return path.join(__dirname, '..', '..', 'store-templates', 'default', 'vendor-directory.json');
}

function loadVendorDirectoryTemplate() {
    if (cached) return cached;
    try {
        cached = JSON.parse(fs.readFileSync(templatePath(), 'utf8'));
    } catch (_) {
        cached = { contacts: [] };
    }
    return cached;
}

function resetVendorDirectoryTemplateCache() {
    cached = null;
}

function listVendorDirectoryContacts() {
    return (loadVendorDirectoryTemplate().contacts || []).filter((c) => c.vendor);
}

module.exports = {
    loadVendorDirectoryTemplate,
    resetVendorDirectoryTemplateCache,
    listVendorDirectoryContacts,
};
