const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveInvoicePath, invoiceDirectory, invoiceBuffer } = require('../lib/files');
const seedDemoData = require('../scripts/seed-demo-data');

test('rechaza rutas externas y valida periodos antes de escribir', () => {
    for (const file of ['server.js', '../private.pdf', 'C:\\private.pdf', '/etc/private.pdf', 'uploads/invoices/../../../private.pdf', 'uploads/invoices/file.html']) {
        assert.throws(() => resolveInvoicePath(file));
    }
    assert.match(resolveInvoicePath('uploads/invoices/2026-11/test.pdf'), /test\.pdf$/);
    for (const period of ['../../private', '2026-13', '', null]) assert.throws(() => invoiceDirectory(period, 'sales'));
    assert.match(invoiceDirectory('2026-11', 'sales'), /2026-11$/);
});

test('rechaza contenido que solo se presenta como PDF', () => {
    assert.throws(() => invoiceBuffer('data:text/html;base64,PHNjcmlwdD4='));
    assert.throws(() => invoiceBuffer('data:application/pdf;base64,PHNjcmlwdD4='));
    assert.equal(invoiceBuffer('data:application/pdf;base64,JVBERi0xLjcK').subarray(0, 5).toString(), '%PDF-');
});

test('el generador nunca borra ni reemplaza una base existente', async () => {
    for (const marker of [{ value: 'anterior' }, null]) {
        const calls = [];
        const fake = {
            get(sql, params, cb) { calls.push(sql); cb(null, sql.includes('demo_seed_version') ? marker : { total: 1 }); },
            run() { throw new Error('No debe modificar una base existente'); }
        };
        assert.equal(await seedDemoData(fake), false);
        assert.ok(calls.length > 0);
    }
});
