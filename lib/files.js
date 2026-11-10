const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const INVOICE_UPLOAD_DIR = path.join(root, 'uploads', 'invoices');

function inside(base, target) {
    const relative = path.relative(base, target);
    return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

function resolveInvoicePath(stored) {
    if (typeof stored !== 'string' || path.isAbsolute(stored)) throw new Error('Ruta de adjunto no permitida.');
    const absolute = path.resolve(root, stored);
    if (!inside(INVOICE_UPLOAD_DIR, absolute) || path.extname(absolute).toLowerCase() !== '.pdf') throw new Error('Ruta de adjunto no permitida.');
    // Comprobar enlaces simbólicos y junctions, incluidos los directorios padres.
    let current = absolute;
    while (inside(root, current)) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('No se permiten enlaces en adjuntos.');
        current = path.dirname(current);
    }
    return absolute;
}

function invoiceDirectory(period, category) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period))) throw new Error('Periodo de adjunto inválido.');
    if (!['sales', 'expenses', 'inventory', undefined].includes(category)) throw new Error('Categoría inválida.');
    const dir = category === 'sales' ? path.join(INVOICE_UPLOAD_DIR, 'sales', period) : path.join(INVOICE_UPLOAD_DIR, period);
    resolveInvoicePath(path.relative(root, path.join(dir, 'validation.pdf')));
    return dir;
}

function invoiceBuffer(value) {
    const match = typeof value === 'string' && value.match(/^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) throw new Error('Solo se admiten adjuntos PDF en base64.');
    const buffer = Buffer.from(match[1], 'base64');
    if (buffer.length > 10 * 1024 * 1024 || buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('PDF inválido o mayor a 10 MB.');
    return buffer;
}

module.exports = { INVOICE_UPLOAD_DIR, resolveInvoicePath, invoiceDirectory, invoiceBuffer };
