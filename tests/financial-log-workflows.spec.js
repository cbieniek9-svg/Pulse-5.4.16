import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { loginPortal } from './helpers/playwright-auth.js';

const MANAGER_A = { name: 'Playwright Manager A', pin: 'pw-manager-a-510' };
const MANAGER_B = { name: 'Playwright Manager B', pin: 'pw-manager-b-510' };

async function login(page, manager) {
    // Managers are excluded from the public staff dropdown (5.4.11); use typed-name mode.
    await loginPortal(page, '/financial', /ENTER/i, manager);
    await expect(page.getByText('Financial Log — Edmonton Wholesale Market Receiving Report')).toBeVisible();
}

async function logout(page) {
    await page.getByRole('button', { name: 'LOGOUT' }).click();
    await expect(page.locator('#auth-screen')).toBeVisible();
}

test.describe.serial('5.4.10 Receiving Book financial controls', () => {
    test('daily certification requires all six explicit manager assertions', async ({ page }) => {
        await login(page, MANAGER_A);
        await page.getByRole('button', { name: 'Daily', exact: true }).click();
        await page.getByRole('button', { name: 'Receiving', exact: true }).click();
        await page.locator('input[type="date"]').first().fill('2026-06-02');
        await expect(page.locator('input[value="ITEM-X"]')).toBeVisible();
        const controls = page.getByTestId('day-integrity-controls');
        await expect(controls).toBeVisible();
        const certify = controls.getByRole('button', { name: /Recertify day|Certify day/ });
        await expect(certify).toBeDisabled();
        for (const label of [
            'Receiving complete',
            'Invoices entered',
            'References verified',
            'Freight verified',
            'Receiver identified',
            'Exceptions documented',
        ]) {
            await controls.getByRole('checkbox', { name: label }).check();
        }
        await expect(certify).toBeEnabled();
        await expect(page.getByRole('button', { name: /Confirm legacy fixed allocation/i })).toHaveCount(0);
        await expect(page.getByRole('button', { name: /Confirm base cost only/i })).toHaveCount(0);
    });

    test('manager A submits, manager B approves and closes, Item X export stays authoritative', async ({ page }, testInfo) => {
        test.setTimeout(120_000);
        await login(page, MANAGER_A);
        await page.getByRole('combobox', { name: 'All periods' }).selectOption('2026-06-01');
        await expect(page.getByRole('button', { name: 'Set operational period' })).toBeEnabled();
        page.once('dialog', (dialog) => dialog.accept());
        await page.getByRole('button', { name: 'Set operational period' }).click();
        await expect(page.getByText('Operational period', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Period Close', exact: true }).click();
        await page.getByRole('button', { name: 'Receiving Totals', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Confirm invoice freight' })).toBeVisible();
        await expect(page.getByRole('button', { name: /Confirm legacy fixed allocation/i })).toHaveCount(0);
        await expect(page.getByRole('button', { name: /Confirm base cost only/i })).toHaveCount(0);
        page.once('dialog', (dialog) => dialog.accept('Invoice freight verified against invoices'));
        await page.getByRole('button', { name: 'Confirm invoice freight' }).click();

        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        await page.getByRole('button', { name: 'Period Checklist', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Submit for approval' })).toBeVisible();
        await page.getByRole('button', { name: 'Submit for approval' }).click();
        await expect(page.locator('.period-check-hint')).toContainText('Submitted by Playwright Manager A');

        page.once('dialog', async (dialog) => {
            expect(dialog.message()).toMatch(/different manager/i);
            await dialog.accept();
        });
        await page.getByRole('button', { name: 'Approve period' }).click();
        await expect(page.getByRole('button', { name: 'Approve period' })).toBeVisible();

        await logout(page);
        await login(page, MANAGER_B);
        await expect(page.getByRole('button', { name: 'Approve period' })).toBeVisible();
        const approveResponsePromise = page.waitForResponse((response) => (
            response.url().includes('/api/receiving/report/period/approve')
        ));
        await page.getByRole('button', { name: 'Approve period' }).click();
        const approveResponse = await approveResponsePromise;
        expect(approveResponse.status(), await approveResponse.text()).toBe(200);
        await expect(page.locator('.period-lock-banner').last()).toContainText('Approved by Playwright Manager B');
        page.once('dialog', (dialog) => dialog.accept());
        const closeResponsePromise = page.waitForResponse((response) => (
            response.url().includes('/api/receiving/report/period/close')
        ));
        await page.getByRole('button', { name: 'Close & lock period' }).click();
        const closeResponse = await closeResponsePromise;
        expect(closeResponse.status(), await closeResponse.text()).toBe(200);
        await expect(page.locator('.period-status-locked')).toHaveText('Locked');

        const exportResponsePromise = page.waitForResponse((response) => (
            response.url().includes('/api/export/edmonton-receiving-report-period')
        ));
        await page.getByRole('button', { name: 'Full workbook' }).click();
        const exportResponse = await exportResponsePromise;
        if (exportResponse.status() !== 200) throw new Error(await exportResponse.text());
        expect(exportResponse.status()).toBe(200);
        const token = await page.evaluate(() => sessionStorage.getItem('tgp_token'));
        const artifactResponse = await page.context().request.get(
            '/api/export/edmonton-receiving-report-period?date=2026-06-01',
            { headers: { 'x-session-token': token } },
        );
        if (artifactResponse.status() !== 200) throw new Error(await artifactResponse.text());
        expect(artifactResponse.status()).toBe(200);
        const output = testInfo.outputPath('pulse-5.4.10-item-x.xlsx');
        fs.writeFileSync(output, await artifactResponse.body());
        expect(fs.statSync(output).size).toBeGreaterThan(1000);

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(output);
        const itemRows = [];
        const numericValue = (value) => Number(
            value && typeof value === 'object' && 'result' in value ? value.result : value,
        );
        const workbookValues = [];
        workbook.eachSheet((sheet) => {
            sheet.eachRow((row) => {
                workbookValues.push(...row.values);
                if (row.values.some((value) => String(value || '').trim() === 'ITEM-X')) itemRows.push(row);
            });
        });
        expect(itemRows.length).toBeGreaterThan(0);
        expect(itemRows.some((row) => row.values.some((value) => numericValue(value) === 32.03))).toBeTruthy();
        expect(workbookValues.some((value) => numericValue(value) === 32.49)).toBeTruthy();
        const freight = workbook.getWorksheet('Pulse Freight Reconciliation');
        expect(freight).toBeTruthy();
        const freightValues = [];
        freight.eachRow((row) => freightValues.push(...row.values));
        expect(freightValues.some((value) => numericValue(value) === 0.46)).toBeTruthy();
        expect(path.basename(output)).toContain('pulse-5.4.10-item-x');
    });
});

