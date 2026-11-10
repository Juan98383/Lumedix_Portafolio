const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const app = express();
const port = Number(process.env.PORT) || 3100;
const host = '127.0.0.1';

const { INVOICE_UPLOAD_DIR, resolveInvoicePath, invoiceBuffer, invoiceDirectory } = require('./lib/files');
const databasePath = path.join(__dirname, 'data', 'lumedix-demo.db');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const seedDemoData = require('./scripts/seed-demo-data');

function ensureInvoiceUploadDir(period, category) {
    const dir = invoiceDirectory(period, category);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** Guarda PDF en disco; en BD solo se guarda la ruta relativa (no base64). */
function persistInvoiceFile(invoiceFile, meta) {
    if (!invoiceFile) return null;
    if (typeof invoiceFile === 'string' && !invoiceFile.startsWith('data:')) {
        const abs = resolveInvoicePath(invoiceFile);
        return fs.existsSync(abs) ? path.relative(__dirname, abs).replace(/\\/g, '/') : null;
    }
    const buf = invoiceBuffer(invoiceFile);
    const dir = ensureInvoiceUploadDir(meta.period, meta.category);
    const safeInv = String(meta.invoice_number || 'sin-numero').replace(/[^\w.-]+/g, '_');
    const safeSupp = String(meta.party_id || meta.supplier_id || 'prov').replace(/[^\w.-]+/g, '_');
    const filename = `${safeSupp}_${safeInv}_${Date.now()}.pdf`;
    const fullPath = path.join(dir, filename);
    fs.writeFileSync(fullPath, buf);
    return path.relative(__dirname, fullPath).replace(/\\/g, '/');
}

app.disable('x-powered-by');
app.use((req, res, next) => {
    const expected = 'http://127.0.0.1:' + port;
    if (req.headers.host !== '127.0.0.1:' + port && req.headers.host !== 'localhost:' + port) return res.status(403).json({ error: 'Host no permitido.' });
    const origin = req.headers.origin;
    if ((origin && origin !== expected && origin !== 'http://localhost:' + port) || req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Origen no permitido.' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
});
app.use(express.json({ limit: '15mb' }));
app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding']) && !req.is('application/json')) return res.status(415).json({ error: 'Se requiere application/json.' });
    next();
});

app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'El PDF supera el tamaño permitido (máx. 15 MB en envío). Reduzca el archivo o reinicie el servidor.' });
    }
    next(err);
});

app.use('/api', (req, res, next) => {
    const body = req.body || {};
    for (const key of ['month', 'period']) {
        if (body[key] != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(body[key]))) return res.status(400).json({ error: 'Periodo inválido.' });
    }
    if (body.date != null && (typeof body.date !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(body.date) || !Number.isFinite(Date.parse(body.date)) || new Date(body.date).toISOString().slice(0,10) !== body.date)) return res.status(400).json({ error: 'Fecha inválida.' });
    next();
});

// Solo se exponen los archivos públicos necesarios de cada dependencia.
const vendorFiles = {
    '/vendor/jspdf.js': 'jspdf/dist/jspdf.umd.min.js',
    '/vendor/autotable.js': 'jspdf-autotable/dist/jspdf.plugin.autotable.min.js',
    '/vendor/xlsx.js': 'xlsx/dist/xlsx.full.min.js',
    '/vendor/chart.js': 'chart.js/dist/chart.umd.min.js',
    '/vendor/fontawesome/css/all.min.css': '@fortawesome/fontawesome-free/css/all.min.css'
};
for (const [url, relative] of Object.entries(vendorFiles)) app.get(url, (req, res) => res.sendFile(path.join(__dirname, 'node_modules', relative)));
app.use('/vendor/fontawesome/webfonts', express.static(path.join(__dirname, 'node_modules/@fortawesome/fontawesome-free/webfonts'), { dotfiles: 'deny', index: false }));

app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));

const db = new sqlite3.Database(databasePath, (err) => {
    if (err) {
        console.error(err.message);
    }
    console.log('Connected to the SQLite database.');
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
    });
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve(this);
    });
});

// Helper to verify that a period (YYYY-MM) is open
const checkPeriodOpen = async (month) => {
    const row = await dbGet(`SELECT status FROM periods WHERE month = ?`, [month]);
    if (!row) throw new Error(`Periodo ${month} no existe.`);
    if (row.status !== 'ABIERTO') throw new Error(`Periodo ${month} está cerrado.`);
};

// Helper to get current period (YYYY-MM)
const getCurrentPeriod = () => {
    const d = new Date();
    return d.toISOString().slice(0,7);
};

let hasSaleIdColumn = false;

const MOVEMENT_OPTIONAL_COLUMNS = [
    { name: 'supplier_id', sql: 'INTEGER' },
    { name: 'supplier_name', sql: 'TEXT' },
    { name: 'invoice_number', sql: 'TEXT' },
    { name: 'iva_percent', sql: 'REAL DEFAULT 0' },
    { name: 'iva_amount', sql: 'REAL DEFAULT 0' },
    { name: 'invoice_file', sql: 'TEXT' },
    { name: 'sale_id', sql: 'INTEGER' }
];

async function ensureInventoryMovementColumns() {
    const cols = await dbAll('PRAGMA table_info(inventory_movements)');
    const existing = new Set(cols.map(c => c.name));
    for (const col of MOVEMENT_OPTIONAL_COLUMNS) {
        if (!existing.has(col.name)) {
            await dbRun(`ALTER TABLE inventory_movements ADD COLUMN ${col.name} ${col.sql}`);
            existing.add(col.name);
        }
    }
    hasSaleIdColumn = existing.has('sale_id');
}

async function ensureSaleIdColumn() {
    await ensureInventoryMovementColumns();
}

const EXPENSE_OPTIONAL_COLUMNS = [
    { name: 'period', sql: 'TEXT' },
    { name: 'category', sql: 'TEXT' },
    { name: 'supplier_id', sql: 'INTEGER' },
    { name: 'supplier_name', sql: 'TEXT' },
    { name: 'invoice_number', sql: 'TEXT' },
    { name: 'payment_method', sql: 'TEXT' },
    { name: 'observation', sql: 'TEXT' },
    { name: 'expense_batch_id', sql: 'TEXT' },
    { name: 'line_description', sql: 'TEXT' },
    { name: 'quantity', sql: 'REAL DEFAULT 1' },
    { name: 'unit_price', sql: 'REAL DEFAULT 0' },
    { name: 'iva_percent', sql: 'REAL DEFAULT 0' },
    { name: 'iva_amount', sql: 'REAL DEFAULT 0' },
    { name: 'invoice_file', sql: 'TEXT' }
];

async function ensureExpenseColumns() {
    const cols = await dbAll('PRAGMA table_info(expenses)');
    const existing = new Set(cols.map(c => c.name));
    for (const col of EXPENSE_OPTIONAL_COLUMNS) {
        if (!existing.has(col.name)) {
            await dbRun(`ALTER TABLE expenses ADD COLUMN ${col.name} ${col.sql}`);
            existing.add(col.name);
        }
    }
}

function expenseLineTotals(quantity, unitPrice, ivaPercent) {
    const qty = Number(quantity) || 0;
    const price = Number(unitPrice) || 0;
    const pct = Number(ivaPercent) || 0;
    const subtotal = qty * price;
    const ivaAmount = subtotal * (pct / 100);
    return { subtotal, iva_percent: pct, iva_amount: ivaAmount, total: subtotal + ivaAmount };
}

const SALES_OPTIONAL_COLUMNS = [
    { name: 'period', sql: 'TEXT' },
    { name: 'observation', sql: "TEXT DEFAULT ''" },
    { name: 'retention_percent', sql: 'REAL DEFAULT 0' },
    { name: 'iva_percent', sql: 'REAL DEFAULT 0' },
    { name: 'iva_amount', sql: 'REAL DEFAULT 0' },
    { name: 'sale_batch_id', sql: 'TEXT' },
    { name: 'sale_invoice_number', sql: 'TEXT' },
    { name: 'dian_invoice_file', sql: 'TEXT' }
];

async function ensureInventoryColumns() {
    const existing = new Set((await dbAll('PRAGMA table_info(inventory)')).map(c => c.name));
    for (const [name, sql] of Object.entries({ code: 'TEXT', category: 'TEXT', purchase_price: 'REAL', sale_price: 'REAL', min_stock: 'INTEGER', status: "TEXT DEFAULT 'Activo'" })) {
        if (!existing.has(name)) await dbRun(`ALTER TABLE inventory ADD COLUMN ${name} ${sql}`);
    }
}

async function ensureSalesColumns() {
    const cols = await dbAll('PRAGMA table_info(sales)');
    const existing = new Set(cols.map(c => c.name));
    for (const col of SALES_OPTIONAL_COLUMNS) {
        if (!existing.has(col.name)) {
            await dbRun(`ALTER TABLE sales ADD COLUMN ${col.name} ${col.sql}`);
            existing.add(col.name);
        }
    }
}

function saleLineTotals(quantity, price, ivaPercent) {
    const qty = Number(quantity) || 0;
    const unitPrice = Number(price) || 0;
    const pct = Number(ivaPercent) || 0;
    const subtotal = qty * unitPrice;
    const ivaAmount = subtotal * (pct / 100);
    return { subtotal, iva_percent: pct, iva_amount: ivaAmount, total: subtotal + ivaAmount };
}

async function backfillSaleIds() {
    if (!hasSaleIdColumn) return;
    const sales = await dbAll('SELECT id, product_id, period, date, quantity FROM sales');
    for (const s of sales) {
        const period = s.period || String(s.date).slice(0, 7);
        await dbRun(
            `UPDATE inventory_movements SET sale_id = ?
             WHERE sale_id IS NULL AND type = 'SALIDA' AND reason = 'Venta'
               AND product_id = ? AND date = ? AND quantity = ? AND period = ?`,
            [s.id, s.product_id, s.date, s.quantity, period]
        );
    }
}


db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT,
        name TEXT,
        category TEXT,
        min_stock INTEGER,
        status TEXT DEFAULT 'Activo',
        supplier TEXT,
        price REAL,
        stock INTEGER,
        expiry_date TEXT
    )`);

    // Intentar agregar nuevas columnas por si la tabla ya existe

    db.run(`CREATE TABLE IF NOT EXISTS inventory_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period TEXT,
        date TEXT,
        product_id INTEGER,
        type TEXT,
        reason TEXT,
        quantity INTEGER,
        unit_cost REAL,
        total REAL,
        observation TEXT,
        FOREIGN KEY(product_id) REFERENCES inventory(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client TEXT,
        product_id INTEGER,
        product_name TEXT,
        price REAL,
        quantity INTEGER,
        total REAL,
        payment_method TEXT,
        date TEXT,
        FOREIGN KEY(product_id) REFERENCES inventory(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        description TEXT,
        amount REAL,
        date TEXT
    )`);

    // --- Periods Table ---
    db.run(`CREATE TABLE IF NOT EXISTS periods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        month TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('ABIERTO','CERRADO')),
        closedAt TEXT,
        reopenedAt TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        identification TEXT UNIQUE,
        contact TEXT,
        phone TEXT,
        email TEXT,
        address TEXT,
        city TEXT,
        observation TEXT,
        supplier_type TEXT DEFAULT 'inventory',
        status TEXT DEFAULT 'Activo',
        createdAt TEXT,
        updatedAt TEXT
    )`);

    db.all("PRAGMA table_info(suppliers)", [], (err, columns) => {
        if (!err && columns && !columns.find(c => c.name === 'supplier_type')) {
            db.run(`ALTER TABLE suppliers ADD COLUMN supplier_type TEXT DEFAULT 'inventory'`);
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        identification TEXT UNIQUE,
        contact TEXT,
        phone TEXT,
        email TEXT,
        address TEXT,
        city TEXT,
        observation TEXT,
        status TEXT DEFAULT 'Activo',
        createdAt TEXT,
        updatedAt TEXT
    )`);

    // Migraciones para inventory_movements

    // Migraciones para expenses

    // Migracion para sales

    db.run(`CREATE TABLE IF NOT EXISTS company_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`, () => {});

    // --- Period Opening Balance Table ---
    db.run(`CREATE TABLE IF NOT EXISTS period_opening_balance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period TEXT NOT NULL UNIQUE,
        opening_cash REAL DEFAULT 0,
        opening_bank REAL DEFAULT 0,
        opening_merchandise_value REAL DEFAULT 0,
        opening_other_assets REAL DEFAULT 0,
        opening_total REAL DEFAULT 0,
        createdAt TEXT,
        updatedAt TEXT
    )`, () => {
        db.run(`ALTER TABLE period_opening_balance ADD COLUMN opening_bank REAL DEFAULT 0`, (err) => {
            // Silently ignore if column already exists
        });
    });

    // Ensure current month exists and is abierto
    const currentMonth = getCurrentPeriod();
    db.run(`INSERT OR IGNORE INTO periods (month, status) VALUES (?, 'ABIERTO')`, [currentMonth]);

    // --- Periods API ---
    // Get all periods
    app.get('/api/periods', (req, res) => {
        db.all(`SELECT * FROM periods ORDER BY month DESC`, [], (err, rows) => {
            if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
            res.json(rows);
        });
    });

    // Get specific period by month (YYYY-MM)

    // Sync opening balance of a period from previous month's closing balance
    // Called automatically when user switches to a period
    app.post('/api/periods/:month/sync-opening', async (req, res) => {
        const month = req.params.month;
        try {
            // Find the most recent period before this month
            const prevRow = await dbGet(`SELECT month FROM periods WHERE month < ? ORDER BY month DESC LIMIT 1`, [month]);
            if (!prevRow) {
                return res.json({ synced: false, reason: 'No previous period found' });
            }

            const prevMonth = prevRow.month;
            const endingBalances = await calculateEndingBalances(prevMonth);

            // Check if opening balance for this period was manually set by user
            const existing = await dbGet(`SELECT * FROM period_opening_balance WHERE period = ?`, [month]);

            // Only auto-sync if not manually set (opening_total = 0 or row doesn't exist)
            // We always update to keep it fresh — user can override via the UI button
            const prevOpening = await dbGet(
                `SELECT opening_merchandise_value, opening_other_assets FROM period_opening_balance WHERE period = ?`,
                [prevMonth]
            );
            const merch = prevOpening?.opening_merchandise_value || 0;
            const other = prevOpening?.opening_other_assets || 0;

            const newCash = endingBalances.ending_cash;
            const newBank = endingBalances.ending_bank;
            const total = newCash + newBank + merch + other;
            const now = new Date().toISOString();

            await dbRun(
                `INSERT INTO period_opening_balance (period, opening_cash, opening_bank, opening_merchandise_value, opening_other_assets, opening_total, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(period) DO UPDATE SET
                    opening_cash = excluded.opening_cash,
                    opening_bank = excluded.opening_bank,
                    opening_total = excluded.opening_total,
                    updatedAt = ?`,
                [month, newCash, newBank, merch, other, total, now, now, now]
            );

            res.json({ synced: true, opening_cash: newCash, opening_bank: newBank, from_period: prevMonth });
        } catch (err) {
            console.error('Error syncing opening balance:', err);
            res.status(500).json({ error: 'No se pudo completar la operación.' });
        }
    });

    app.get('/api/periods/:month', (req, res) => {
        const period = req.params.month;
        db.get(`SELECT * FROM periods WHERE month = ?`, [period], (err, row) => {
            if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
            if (!row) return res.status(404).json({ error: 'Periodo no encontrado' });
            res.json(row);
        });
    });

    const calculateEndingBalances = async (period) => {
        // 1. Get opening balances of the period
        const opening = await dbGet(`SELECT opening_cash, opening_bank FROM period_opening_balance WHERE period = ?`, [period]) || { opening_cash: 0, opening_bank: 0 };
        
        // 2. Query cash sales (payment_method = 'Efectivo')
        const salesCashRow = await dbGet(`SELECT COALESCE(SUM(total), 0) as total FROM sales WHERE period = ? AND payment_method = 'Efectivo'`, [period]);
        
        // 3. Query bank sales (payment_method != 'Efectivo')
        const salesBankRow = await dbGet(`SELECT COALESCE(SUM(total), 0) as total FROM sales WHERE period = ? AND payment_method != 'Efectivo'`, [period]);
        
        // 4. Query cash expenses (payment_method = 'Efectivo')
        const expCashRow = await dbGet(`SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE period = ? AND payment_method = 'Efectivo'`, [period]);
        
        // 5. Query bank expenses (payment_method != 'Efectivo')
        const expBankRow = await dbGet(`SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE period = ? AND payment_method != 'Efectivo'`, [period]);
        
        // 6. Query merchandise purchases (always bank)
        const purchasesRow = await dbGet(`SELECT COALESCE(SUM(total), 0) as total FROM inventory_movements WHERE period = ? AND type = 'ENTRADA' AND reason = 'Compra'`, [period]);
        
        const ending_cash = (opening.opening_cash || 0) + (salesCashRow?.total || 0) - (expCashRow?.total || 0);
        const ending_bank = (opening.opening_bank || 0) + (salesBankRow?.total || 0) - (expBankRow?.total || 0) - (purchasesRow?.total || 0);
        
        return { ending_cash, ending_bank };
    };

    // Create a new period (default ABIERTO)
    app.post('/api/periods', async (req, res) => {
        const { month } = req.body;
        if (!month) return res.status(400).json({ error: 'Month is required' });
        try {
            // Find the most recent period before the new month
            const prevRow = await dbGet(`SELECT month FROM periods WHERE month < ? ORDER BY month DESC LIMIT 1`, [month]);
            
            // Insert the new period
            await dbRun(`INSERT INTO periods (month, status) VALUES (?, 'ABIERTO')`, [month]);
            
            let initialCash = 0;
            let initialBank = 0;
            let initialMerch = 0;
            let initialOther = 0;
            
            if (prevRow) {
                const prevMonth = prevRow.month;
                const endingBalances = await calculateEndingBalances(prevMonth);
                initialCash = endingBalances.ending_cash;
                initialBank = endingBalances.ending_bank;
                
                // Let's also get the previous period's other assets and merchandise value
                const prevOpening = await dbGet(`SELECT opening_merchandise_value, opening_other_assets FROM period_opening_balance WHERE period = ?`, [prevMonth]);
                if (prevOpening) {
                    initialMerch = prevOpening.opening_merchandise_value || 0;
                    initialOther = prevOpening.opening_other_assets || 0;
                }
            }
            
            // Save starting balances for the new period
            const total = initialCash + initialBank + initialMerch + initialOther;
            const now = new Date().toISOString();
            await dbRun(
                `INSERT INTO period_opening_balance (period, opening_cash, opening_bank, opening_merchandise_value, opening_other_assets, opening_total, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [month, initialCash, initialBank, initialMerch, initialOther, total, now, now]
            );
            
            res.json({ month, status: 'ABIERTO' });
        } catch (err) {
            console.error('Error creating period:', err);
            res.status(500).json({ error: 'No se pudo completar la operación.' });
        }
    });

    // Close a period
    app.put('/api/periods/:month/close', (req, res) => {
        const month = req.params.month;
        
        db.get(`SELECT COUNT(*) as count FROM periods WHERE month < ? AND status = 'ABIERTO'`, [month], (err, row) => {
            if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
            if (row.count > 0) {
                return res.status(400).json({ error: 'No puedes cerrar este período porque existen períodos anteriores abiertos. Cierra primero los períodos anteriores.' });
            }

            const closedAt = new Date().toISOString();
            db.run(`UPDATE periods SET status = 'CERRADO', closedAt = ? WHERE month = ?`, [closedAt, month], function(err) {
                if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
                res.json({ changes: this.changes, month, status: 'CERRADO' });
            });
        });
    });

    // Reopen a period (sequential, not cascade)
    app.put('/api/periods/:month/open', (req, res) => {
        const month = req.params.month;
        
        db.get(`SELECT COUNT(*) as count FROM periods WHERE month > ? AND status = 'CERRADO'`, [month], (err, row) => {
            if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
            if (row.count > 0) {
                return res.status(400).json({ error: 'No puedes reabrir este período porque existen períodos posteriores cerrados. Reabre primero los períodos más recientes.' });
            }

            const reopenedAt = new Date().toISOString();
            db.run(`UPDATE periods SET status = 'ABIERTO', reopenedAt = ? WHERE month = ?`, [reopenedAt, month], function(err) {
                if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
                res.json({ changes: this.changes, month, status: 'ABIERTO' });
            });
        });
    });
    // Delete a period
    app.delete('/api/periods/:month', (req, res) => {
        const month = req.params.month;
        db.get(`SELECT COUNT(*) as count FROM inventory_movements WHERE period = ?`, [month], (err, row) => {
            if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
            if (row.count > 0) {
                return res.status(400).json({ error: 'No se puede eliminar el período porque tiene movimientos de inventario asociados.' });
            }
            db.get(`SELECT COUNT(*) as count FROM sales WHERE period = ?`, [month], (err, row2) => {
                if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
                if (row2.count > 0) {
                    return res.status(400).json({ error: 'No se puede eliminar el período porque tiene ventas asociadas.' });
                }
                db.get(`SELECT COUNT(*) as count FROM expenses WHERE period = ?`, [month], (err, row3) => {
                    if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
                    if (row3.count > 0) {
                        return res.status(400).json({ error: 'No se puede eliminar el período porque tiene gastos asociados.' });
                    }
                    db.run(`DELETE FROM period_opening_balance WHERE period = ?`, [month], (balanceErr) => {
                        if (balanceErr) return res.status(500).json({ error: balanceErr.message });
                        db.run(`DELETE FROM periods WHERE month = ?`, [month], function(err) {
                            if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
                            res.json({ changes: this.changes, month });
                        });
                    });
                });
            });
        });
    });

});

// --- Inventory API ---
app.get('/api/inventory', (req, res) => {
    db.all("SELECT * FROM inventory", [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
        res.json(rows);
    });
});

app.post('/api/inventory', async (req, res) => {
    const { code, name, category, min_stock, status } = req.body;
    // Verify period is open
    const currentPeriod = getCurrentPeriod();
    try { await checkPeriodOpen(currentPeriod); } catch (error) { return res.status(400).json({ error: error.message }); }
    db.run(`INSERT INTO inventory (code, name, category, min_stock, status) VALUES (?, ?, ?, ?, ?)`,
    [code, name, category, min_stock, status], function(err) {
        if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
        res.json({ id: this.lastID });
    });
});

app.put('/api/inventory/:id', async (req, res) => {
    const { code, name, category, min_stock, status } = req.body;
    // Verify period is open
    const currentPeriod = getCurrentPeriod();
    try { await checkPeriodOpen(currentPeriod); } catch (error) { return res.status(400).json({ error: error.message }); }
    db.run(`UPDATE inventory SET code = ?, name = ?, category = ?, min_stock = ?, status = ? WHERE id = ?`,
    [code, name, category, min_stock, status, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
        res.json({ changes: this.changes });
    });
});

app.delete('/api/inventory/:id', async (req, res) => {
    // Verify period is open
    const currentPeriod = getCurrentPeriod();
    try { await checkPeriodOpen(currentPeriod); } catch (error) { return res.status(400).json({ error: error.message }); }
    db.run(`DELETE FROM inventory WHERE id = ?`, req.params.id, function(err) {
        if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
        res.json({ changes: this.changes });
    });
});

// --- Company settings (treasury) ---
app.get('/api/settings/opening-cash', async (req, res) => {
    try {
        const row = await dbGet(`SELECT value FROM company_settings WHERE key = 'opening_cash_balance'`);
        res.json({ amount: row ? Number(row.value) || 0 : 0 });
    } catch (e) {
        res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
});

app.put('/api/settings/opening-cash', async (req, res) => {
    const amount = Number(req.body.amount);
    if (isNaN(amount) || amount < 0) {
        return res.status(400).json({ error: 'Indique un saldo en banco válido (número ≥ 0).' });
    }
    try {
        await dbRun(
            `INSERT INTO company_settings (key, value) VALUES ('opening_cash_balance', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            [String(amount)]
        );
        res.json({ success: true, amount });
    } catch (e) {
        res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
});

// --- Expenses API ---
app.get('/api/expenses', (req, res) => {
    db.all('SELECT * FROM expenses ORDER BY date DESC, id DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
        res.json(rows);
    });
});

app.post('/api/expenses', async (req, res) => {
    const {
        description, amount, date, category, supplier_id, supplier_name,
        invoice_number, invoice_file, payment_method, observation, items
    } = req.body;
    if (!date) return res.status(400).json({ error: 'La fecha es obligatoria.' });
    if (!category) return res.status(400).json({ error: 'La categoría es obligatoria.' });

    const targetPeriod = date.slice(0, 7);
    const batchId = `EX-${Date.now()}`;
    const lineItems = Array.isArray(items) && items.length
        ? items
        : [{
            description: description || 'Gasto',
            quantity: 1,
            unit_price: Number(amount) || 0,
            iva_percent: 0
        }];

    try {
        await ensureExpenseColumns();
        await checkPeriodOpen(targetPeriod);
        await dbRun('BEGIN TRANSACTION');

        for (const item of lineItems) {
            const desc = (item.description || item.line_description || '').trim();
            const qty = Number(item.quantity) || 0;
            const price = Number(item.unit_price) || 0;
            const ivaPct = Number(item.iva_percent) || 0;
            if (!desc) {
                await dbRun('ROLLBACK');
                return res.status(400).json({ error: 'Cada línea debe tener concepto o producto.' });
            }
            if (qty <= 0) {
                await dbRun('ROLLBACK');
                return res.status(400).json({ error: 'La cantidad debe ser mayor a cero.' });
            }
            const line = expenseLineTotals(qty, price, ivaPct);
            await dbRun(
                `INSERT INTO expenses (description, amount, date, period, category, supplier_id, supplier_name,
                 invoice_number, invoice_file, payment_method, observation, expense_batch_id, line_description, quantity, unit_price, iva_percent, iva_amount)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    desc, line.total, date, targetPeriod, category, supplier_id || null, supplier_name || null,
                    invoice_number || null, persistInvoiceFile(invoice_file, { period: targetPeriod, category: 'expenses', invoice_number, party_id: supplier_id }) || null,
                    payment_method || null, observation || null, batchId, desc,
                    qty, price, line.iva_percent, line.iva_amount
                ]
            );
        }

        await dbRun('COMMIT');
        res.json({ success: true, expense_batch_id: batchId, message: 'Gasto registrado.' });
    } catch (e) {
        try { await dbRun('ROLLBACK'); } catch (_) {}
        res.status(400).json({ error: e.message });
    }
});

app.put('/api/expenses/:id', async (req, res) => {
    const {
        description, amount, date, category, supplier_id, supplier_name,
        invoice_number, invoice_file, payment_method, observation, items
    } = req.body;
    if (!date) return res.status(400).json({ error: 'La fecha es obligatoria.' });

    const targetPeriod = date.slice(0, 7);
    try {
        await ensureExpenseColumns();
        const exp = await dbGet('SELECT * FROM expenses WHERE id = ?', [req.params.id]);
        if (!exp) return res.status(404).json({ error: 'Gasto no encontrado' });
        await checkPeriodOpen(exp.period);
        await checkPeriodOpen(targetPeriod);

        const batchId = exp.expense_batch_id || String(exp.id);
        const lineItems = Array.isArray(items) && items.length
            ? items
            : [{
                description: description || exp.description,
                quantity: 1,
                unit_price: Number(amount) || Number(exp.amount) || 0,
                iva_percent: Number(exp.iva_percent) || 0
            }];

        await dbRun('BEGIN TRANSACTION');
        await dbRun('DELETE FROM expenses WHERE expense_batch_id = ? OR (expense_batch_id IS NULL AND id = ?)', [batchId, req.params.id]);

        for (const item of lineItems) {
            const desc = (item.description || '').trim();
            const qty = Number(item.quantity) || 0;
            const price = Number(item.unit_price) || 0;
            const ivaPct = Number(item.iva_percent) || 0;
            if (!desc || qty <= 0) {
                await dbRun('ROLLBACK');
                return res.status(400).json({ error: 'Cada línea debe tener concepto y cantidad válida.' });
            }
            const line = expenseLineTotals(qty, price, ivaPct);
            await dbRun(
                `INSERT INTO expenses (description, amount, date, period, category, supplier_id, supplier_name,
                 invoice_number, invoice_file, payment_method, observation, expense_batch_id, line_description, quantity, unit_price, iva_percent, iva_amount)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    desc, line.total, date, targetPeriod, category, supplier_id !== undefined ? supplier_id : exp.supplier_id, supplier_name !== undefined ? supplier_name : exp.supplier_name,
                    invoice_number ?? exp.invoice_number,
                    persistInvoiceFile(invoice_file ?? exp.invoice_file, { period: targetPeriod, category: 'expenses', invoice_number: invoice_number ?? exp.invoice_number, party_id: supplier_id ?? exp.supplier_id }) || null,
                    payment_method !== undefined ? payment_method : exp.payment_method, observation !== undefined ? observation : exp.observation,
                    batchId, desc, qty, price, line.iva_percent, line.iva_amount
                ]
            );
        }

        await dbRun('COMMIT');
        res.json({ success: true, message: 'Gasto actualizado.' });
    } catch (e) {
        try { await dbRun('ROLLBACK'); } catch (_) {}
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/expenses/:id', async (req, res) => {
    try {
        const exp = await dbGet('SELECT * FROM expenses WHERE id = ?', [req.params.id]);
        if (!exp) return res.status(404).json({ error: 'Gasto no encontrado' });
        await checkPeriodOpen(exp.period);

        if (exp.expense_batch_id) {
            await dbRun('DELETE FROM expenses WHERE expense_batch_id = ?', [exp.expense_batch_id]);
        } else {
            await dbRun('DELETE FROM expenses WHERE id = ?', [req.params.id]);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// --- Inventory Movements API ---
app.get('/api/inventory_movements', (req, res) => {
    db.all("SELECT * FROM inventory_movements ORDER BY date DESC, id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
        res.json(rows);
    });
});

app.get('/api/inventory_movements/:id/invoice-file', async (req, res) => {
    try {
        const mov = await dbGet(
            'SELECT invoice_file, invoice_number FROM inventory_movements WHERE id = ?',
            [req.params.id]
        );
        if (!mov || !mov.invoice_file) {
            return res.status(404).json({ error: 'No hay factura PDF adjunta.' });
        }
        const stored = mov.invoice_file;
        if (stored.startsWith('data:')) {
            const match = stored.match(/^data:(application\/pdf);base64,(.+)$/s);
            if (!match) return res.status(400).json({ error: 'Archivo adjunto inválido.' });
            const buf = invoiceBuffer(stored);
            res.setHeader('Content-Type', match[1] || 'application/pdf');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="Factura_${mov.invoice_number || req.params.id}.pdf"`
            );
            return res.send(buf);
        }
        const abs = resolveInvoicePath(stored);
        if (!fs.existsSync(abs)) {
            return res.status(404).json({ error: 'El archivo PDF no se encuentra en el servidor.' });
        }
        return res.download(abs, `Factura_${mov.invoice_number || req.params.id}.pdf`);
    } catch (e) {
        return res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
});

// --- Suppliers API ---
app.get('/api/suppliers', (req, res) => {
    db.all("SELECT * FROM suppliers ORDER BY name ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
        res.json(rows);
    });
});

app.post('/api/suppliers', (req, res) => {
    const { name, identification, contact, phone, email, address, city, observation, supplier_type, status } = req.body;
    const now = new Date().toISOString();
    db.run(`INSERT INTO suppliers (name, identification, contact, phone, email, address, city, observation, supplier_type, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, identification, contact, phone, email, address, city, observation, supplier_type || 'inventory', status || 'Activo', now, now], function(err) {
            if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
            res.json({ id: this.lastID });
    });
});

app.put('/api/suppliers/:id', (req, res) => {
    const { name, identification, contact, phone, email, address, city, observation, supplier_type, status } = req.body;
    const now = new Date().toISOString();
    db.run(`UPDATE suppliers SET name = ?, identification = ?, contact = ?, phone = ?, email = ?, address = ?, city = ?, observation = ?, supplier_type = ?, status = ?, updatedAt = ? WHERE id = ?`,
        [name, identification, contact, phone, email, address, city, observation, supplier_type || 'inventory', status, now, req.params.id], function(err) {
            if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
            res.json({ changes: this.changes });
    });
});

app.delete('/api/suppliers/:id', (req, res) => {
    // Verificar si el proveedor tiene movimientos asociados
    db.get(`SELECT COUNT(*) as count FROM inventory_movements WHERE supplier_id = ?`, [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
        if (row.count > 0) {
            return res.status(400).json({ error: 'Este proveedor tiene compras asociadas. Puedes marcarlo como inactivo, pero no eliminarlo.' });
        }
        db.run(`DELETE FROM suppliers WHERE id = ?`, req.params.id, function(err) {
            if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
            res.json({ changes: this.changes });
        });
    });
});

app.get('/api/expenses/:id/invoice-file', async (req, res) => {
    try {
        await ensureExpenseColumns();
        const expense = await dbGet('SELECT invoice_file, invoice_number FROM expenses WHERE id = ?', [req.params.id]);
        if (!expense || !expense.invoice_file) {
            return res.status(404).json({ error: 'No hay soporte PDF adjunto para este gasto.' });
        }
        const stored = expense.invoice_file;
        if (typeof stored === 'string' && stored.startsWith('data:')) {
            const match = stored.match(/^data:(application\/pdf);base64,(.+)$/s);
            if (!match) return res.status(400).json({ error: 'Archivo adjunto inválido.' });
            const buf = invoiceBuffer(stored);
            res.setHeader('Content-Type', match[1] || 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="Soporte_Gasto_${expense.invoice_number || req.params.id}.pdf"`);
            return res.send(buf);
        }
        const abs = resolveInvoicePath(stored);
        if (!fs.existsSync(abs)) {
            return res.status(404).json({ error: 'El archivo PDF no se encuentra en el servidor.' });
        }
        return res.download(abs, `Soporte_Gasto_${expense.invoice_number || req.params.id}.pdf`);
    } catch (e) {
        return res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
});

app.get('/api/clients', (req, res) => {
    db.all("SELECT * FROM clients ORDER BY name ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
        res.json(rows);
    });
});

app.post('/api/clients', (req, res) => {
    const { name, identification, contact, phone, email, address, city, observation, status } = req.body;
    const now = new Date().toISOString();
    db.run(`INSERT INTO clients (name, identification, contact, phone, email, address, city, observation, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, identification, contact, phone, email, address, city, observation, status || 'Activo', now, now], function(err) {
            if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
            res.json({ id: this.lastID });
    });
});

app.put('/api/clients/:id', (req, res) => {
    const { name, identification, contact, phone, email, address, city, observation, status } = req.body;
    const now = new Date().toISOString();
    db.run(`UPDATE clients SET name = ?, identification = ?, contact = ?, phone = ?, email = ?, address = ?, city = ?, observation = ?, status = ?, updatedAt = ? WHERE id = ?`,
        [name, identification, contact, phone, email, address, city, observation, status, now, req.params.id], function(err) {
            if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
            res.json({ changes: this.changes });
    });
});

app.delete('/api/clients/:id', (req, res) => {
    db.run(`DELETE FROM clients WHERE id = ?`, req.params.id, function(err) {
        if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
        res.json({ changes: this.changes });
    });
});

// --- Dashboard API ---
app.get('/api/dashboard', (req, res) => {
    const period = req.query.period;
    let stats = {
        total_sales: 0,
        total_expenses: 0,
        net_utility: 0,
        cogs: 0,
        gross_profit: 0,
        operating_profit: 0
    };

    let salesSql = 'SELECT SUM(total) as ts FROM sales';
    let expSql = 'SELECT SUM(amount) as te FROM expenses';
    let params = [];

    if (period) {
        salesSql += ' WHERE period = ?';
        expSql += ' WHERE period = ?';
        params = [period];
    }

    db.get(salesSql, params, (err, sRow) => {
        stats.total_sales = sRow && sRow.ts ? sRow.ts : 0;

        db.get(expSql, params, (err, eRow) => {
            stats.total_expenses = eRow && eRow.te ? eRow.te : 0;
            stats.net_utility = stats.total_sales - stats.total_expenses;
            stats.operating_profit = stats.net_utility;
            stats.gross_profit = stats.total_sales;
            stats.cogs = 0;
            res.json(stats);
        });
    });
});

app.post('/api/invoices/save', async (req, res) => {
    const {
        period,
        date,
        invoice_number,
        supplier_id,
        supplier_name,
        observation,
        items,
        is_edit,
        old_invoice_number,
        old_supplier_id,
        old_date,
        invoice_file
    } = req.body;

    if (!date) return res.status(400).json({ error: 'La fecha es obligatoria.' });
    if (!invoice_number) return res.status(400).json({ error: 'El número de factura es obligatorio.' });
    if (!supplier_id) return res.status(400).json({ error: 'El proveedor es obligatorio.' });
    if (!items || items.length === 0) return res.status(400).json({ error: 'Debe agregar al menos un producto a la factura.' });

    const targetPeriod = date.slice(0, 7);
    try {
        await ensureInventoryMovementColumns();
        await checkPeriodOpen(targetPeriod);

        // 1. Obtener los movimientos antiguos si es edición
        let oldMovs = [];
        let finalInvoiceFile = invoice_file;

        if (is_edit && old_invoice_number && old_supplier_id) {
            oldMovs = await dbAll(
                "SELECT * FROM inventory_movements WHERE invoice_number = ? AND supplier_id = ? AND type = 'ENTRADA' AND reason = 'Compra' AND (? IS NULL OR date = ?)",
                [old_invoice_number, old_supplier_id, old_date || null, old_date || null]
            );
            if (oldMovs.length > 0) {
                // Verificar que el período original está abierto
                for (const movement of oldMovs) await checkPeriodOpen(movement.period);
                // Preservar la factura anterior si no se subió una nueva
                if (!finalInvoiceFile) {
                    finalInvoiceFile = oldMovs[0].invoice_file;
                }
            }
        }

        if (finalInvoiceFile) {
            try {
                finalInvoiceFile = persistInvoiceFile(finalInvoiceFile, {
                    period: targetPeriod,
                    invoice_number,
                    supplier_id
                });
            } catch (fileErr) {
                return res.status(400).json({ error: `No se pudo guardar el PDF: ${fileErr.message}` });
            }
            if (!finalInvoiceFile) {
                return res.status(400).json({ error: 'El archivo PDF no es válido.' });
            }
        }

        await dbRun("BEGIN TRANSACTION");

        // 2. Calcular el cambio neto de stock por producto
        const netChanges = {};
        
        // Sumar nuevas cantidades
        for (const item of items) {
            const pId = String(item.product_id);
            netChanges[pId] = (netChanges[pId] || 0) + parseInt(item.quantity);
        }

        // Restar cantidades antiguas
        for (const mov of oldMovs) {
            const pId = String(mov.product_id);
            netChanges[pId] = (netChanges[pId] || 0) - parseInt(mov.quantity);
        }

        // 3. Validar si la reducción de stock resulta en stock negativo
        for (const pId of Object.keys(netChanges)) {
            const netChange = netChanges[pId];
            if (netChange < 0) {
                const row = await dbGet(
                    `SELECT SUM(CASE WHEN type='ENTRADA' THEN quantity ELSE -quantity END) as stock FROM inventory_movements WHERE product_id = ?`,
                    [pId]
                );
                const currentStock = row && row.stock ? row.stock : 0;
                
                if (currentStock + netChange < 0) {
                    await dbRun("ROLLBACK");
                    const prodRow = await dbGet("SELECT name FROM inventory WHERE id = ?", [pId]);
                    const prodName = prodRow ? prodRow.name : `ID ${pId}`;
                    return res.status(400).json({ 
                        error: `No se puede guardar la factura porque el producto "${prodName}" quedaría con stock negativo. Stock actual: ${currentStock}, reducción requerida: ${Math.abs(netChange)}.` 
                    });
                }
            }
        }

        // 4. Si todo está bien, borrar los antiguos movimientos (si es edición)
        if (is_edit && old_invoice_number && old_supplier_id) {
            await dbRun(
                "DELETE FROM inventory_movements WHERE invoice_number = ? AND supplier_id = ? AND type = 'ENTRADA' AND reason = 'Compra' AND (? IS NULL OR date = ?)",
                [old_invoice_number, old_supplier_id, old_date || null, old_date || null]
            );
        }

        // 5. Insertar los nuevos movimientos sin la columna invoice_file
        for (const item of items) {
            const subtotal = item.quantity * item.unit_cost;
            const finalIva = item.iva_amount || 0;
            const total = subtotal + finalIva;
            // Insertar movimiento sin invoice_file
            await dbRun(`INSERT INTO inventory_movements 
                (period, date, product_id, type, reason, quantity, unit_cost, total, observation, supplier_id, supplier_name, invoice_number, iva_percent, iva_amount, invoice_file)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    targetPeriod,
                    date,
                    item.product_id,
                    'ENTRADA',
                    'Compra',
                    item.quantity,
                    item.unit_cost,
                    total,
                    observation || '',
                    supplier_id,
                    supplier_name || '',
                    invoice_number,
                    item.iva_percent || 0,
                    finalIva,
                    finalInvoiceFile || null
                ]);
        }

        for (const pId of Object.keys(netChanges)) {
            await syncInventoryStock(pId);
        }

        await dbRun("COMMIT");
        res.json({ success: true });

    } catch (error) {
        try {
            await dbRun("ROLLBACK");
        } catch(e) {
            console.error("Error doing rollback:", e);
        }
        console.error("Error saving invoice:", error);
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/inventory_movements', async (req, res) => {
    const { date, product_id, type, reason, quantity, unit_cost, total, observation, supplier_id, supplier_name, invoice_number, iva_percent, iva_amount, invoice_file } = req.body;
    const targetPeriod = date.slice(0, 7);
    try {
        await ensureInventoryMovementColumns();
        await checkPeriodOpen(targetPeriod);
        const qty = Number(quantity);
        if (type === 'SALIDA') {
            const stock = await getProductStock(product_id);
            if (stock < qty) {
                return res.status(400).json({ error: `Stock insuficiente. Disponible: ${stock}` });
            }
        }
        let storedInvoiceFile = null;
        if (invoice_file) {
            storedInvoiceFile = persistInvoiceFile(invoice_file, {
                period: targetPeriod,
                invoice_number,
                supplier_id
            });
        }
        const result = await dbRun(
            `INSERT INTO inventory_movements (period, date, product_id, type, reason, quantity, unit_cost, total, observation, supplier_id, supplier_name, invoice_number, iva_percent, iva_amount, invoice_file)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [targetPeriod, date, product_id, type, reason, qty, unit_cost, total, observation, supplier_id, supplier_name, invoice_number, iva_percent || 0, iva_amount || 0, storedInvoiceFile]
        );
        await syncInventoryStock(product_id);
        res.json({ id: result.lastID });
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }
});

app.put('/api/inventory_movements/:id', async (req, res) => {
    const { date, quantity, unit_cost, total, observation, iva_percent, iva_amount } = req.body;
    if (!date || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0) return res.status(400).json({ error: 'Fecha y cantidad válidas son obligatorias.' });
    const targetPeriod = date.slice(0, 7);
    try {
        // Fetch existing movement
        const mov = await dbGet(`SELECT * FROM inventory_movements WHERE id = ?`, [req.params.id]);
        if (!mov) return res.status(404).json({ error: 'Movimiento no encontrado' });
        // Ensure old period is open
        await checkPeriodOpen(mov.period);
        // Ensure new period is open
        await checkPeriodOpen(targetPeriod);

        if (mov.sale_id) return res.status(400).json({ error: 'Edite este movimiento desde Ventas para mantener la venta y el inventario sincronizados.' });
        if (mov.type === 'SALIDA') {
            const available = await getProductStock(mov.product_id) + Number(mov.quantity);
            if (Number(quantity) > available) return res.status(400).json({ error: 'Stock insuficiente para la salida.' });
        }
        // Stock validation for ENTRADA reduction
        if (mov.type === 'ENTRADA' && quantity < mov.quantity) {
            const row = await dbGet(`SELECT SUM(CASE WHEN type='ENTRADA' THEN quantity ELSE -quantity END) as stock FROM inventory_movements WHERE product_id = ? AND period <= ?`, [mov.product_id, mov.period]);
            const currentStock = row?.stock || 0;
            const diff = mov.quantity - quantity;
            if (currentStock < diff) {
                return res.status(400).json({ error: `No se puede reducir la cantidad porque resultaría en stock negativo. Stock actual: ${currentStock}` });
            }
        }

        const reason = req.body.reason;
        await dbRun(`UPDATE inventory_movements SET date = ?, period = ?, quantity = ?, unit_cost = ?, total = ?, observation = ?, iva_percent = ?, iva_amount = ?, reason = COALESCE(?, reason) WHERE id = ?`,
            [date, targetPeriod, quantity, unit_cost, total, observation, iva_percent || 0, iva_amount || 0, reason, req.params.id]);
        await syncInventoryStock(mov.product_id);
        res.json({ success: true });
    } catch (e) {
        const status = e.message.includes('Periodo') ? 400 : 500;
        return res.status(status).json({ error: e.message });
    }
});

app.delete('/api/inventory_movements/:id', async (req, res) => {
    try {
        const mov = await dbGet(`SELECT * FROM inventory_movements WHERE id = ?`, [req.params.id]);
        if (!mov) return res.status(404).json({ error: 'Movimiento no encontrado' });
        await checkPeriodOpen(mov.period);

        if (mov.type === 'SALIDA' && mov.reason === 'Venta') {
            return res.status(400).json({
                error: 'Los movimientos de venta en el Kardex son informativos. Elimine o edite la venta desde el módulo Ventas.'
            });
        }

        if (mov.type === 'ENTRADA') {
            const currentStock = await getProductStock(mov.product_id);
            const qty = Number(mov.quantity);
            if (currentStock < qty) {
                const salidas = await dbGet(
                    `SELECT COALESCE(SUM(quantity), 0) AS total FROM inventory_movements
                     WHERE product_id = ? AND type = 'SALIDA' AND id != ?`,
                    [mov.product_id, mov.id]
                );
                return res.status(400).json({
                    error: `No se puede eliminar esta entrada de ${qty} uds. Stock actual: ${currentStock} uds. ` +
                           `Hay ${salidas?.total || 0} uds en salidas/ventas registradas. ` +
                           `Elimine primero las salidas en el Kardex o use "Limpiar huérfanos" si son ventas ya borradas.`
                });
            }
        }

        await dbRun(`DELETE FROM inventory_movements WHERE id = ?`, [req.params.id]);
        await syncInventoryStock(mov.product_id);
        res.json({ success: true, message: 'Movimiento eliminado e inventario actualizado.' });
    } catch (e) {
        const status = e.message.includes('Periodo') ? 400 : 500;
        return res.status(status).json({ error: e.message });
    }
});

// --- Clients API ---
async function getProductStock(productId) {
    const row = await dbGet(
        `SELECT COALESCE(SUM(CASE WHEN type='ENTRADA' THEN quantity ELSE -quantity END), 0) AS stock
         FROM inventory_movements WHERE product_id = ?`,
        [productId]
    );
    return Number(row?.stock) || 0;
}

async function syncInventoryStock(productId) {
    const stock = await getProductStock(productId);
    await dbRun(`UPDATE inventory SET stock = ? WHERE id = ?`, [stock, productId]);
    return stock;
}

async function findSaleMovement(sale) {
    if (hasSaleIdColumn) {
        const mov = await dbGet(
            `SELECT * FROM inventory_movements WHERE sale_id = ? AND type = 'SALIDA' LIMIT 1`,
            [sale.id]
        );
        if (mov) return mov;
    }
    return dbGet(
        `SELECT * FROM inventory_movements
         WHERE type = 'SALIDA' AND reason = 'Venta' AND product_id = ? AND period = ? AND date = ? AND quantity = ?
         ORDER BY id DESC LIMIT 1`,
        [sale.product_id, sale.period, sale.date, sale.quantity]
    );
}

async function removeSaleMovementAndReturns(sale) {
    const mov = await findSaleMovement(sale);
    if (mov) {
        await dbRun(`DELETE FROM inventory_movements WHERE id = ?`, [mov.id]);
    }
    await dbRun(
        `DELETE FROM inventory_movements
         WHERE type = 'ENTRADA' AND reason = 'Devolución venta'
           AND product_id = ? AND period = ? AND date = ? AND quantity = ?`,
        [sale.product_id, sale.period, sale.date, sale.quantity]
    );
}

async function createSaleMovement(saleId, salePeriod, date, productId, quantity, price) {
    await ensureSaleIdColumn();
    const qty = Number(quantity);
    const unitPrice = Number(price);
    const total = qty * unitPrice;
    const result = await dbRun(
        `INSERT INTO inventory_movements
         (period, date, product_id, type, reason, quantity, unit_cost, total, observation,
          supplier_id, supplier_name, invoice_number, iva_percent, iva_amount, sale_id)
         VALUES (?, ?, ?, 'SALIDA', 'Venta', ?, ?, ?, ?, NULL, NULL, NULL, 0, 0, ?)`,
        [salePeriod, date, productId, qty, unitPrice, total, `Venta #${saleId}`, saleId]
    );
    return result.lastID;
}

async function getAvailableStockForSaleEdit(productId, excludeSaleId = null) {
    const current = await getProductStock(productId);
    if (!excludeSaleId) return current;
    const sale = await dbGet(`SELECT product_id, quantity FROM sales WHERE id = ?`, [excludeSaleId]);
    if (sale && Number(sale.product_id) === Number(productId)) {
        return current + Number(sale.quantity);
    }
    return current;
}

async function cleanupOrphanMovements() {
    await ensureInventoryMovementColumns();

    // Eliminar devoluciones erróneas del sistema antiguo (duplicaban el kardex)
    const devolResult = await dbRun(
        `DELETE FROM inventory_movements WHERE reason = 'Devolución venta'`
    );

    // Eliminar SALIDAS de venta sin venta correspondiente en la tabla sales
    const salidaResult = await dbRun(
        `DELETE FROM inventory_movements
         WHERE type = 'SALIDA' AND reason = 'Venta'
         AND NOT EXISTS (
           SELECT 1 FROM sales s
           WHERE s.product_id = inventory_movements.product_id
             AND s.quantity = inventory_movements.quantity
             AND s.date = inventory_movements.date
             AND (s.period = inventory_movements.period OR substr(s.date, 1, 7) = inventory_movements.period)
         )`
    );

    await backfillSaleIds();

    const productIds = await dbAll(
        `SELECT DISTINCT product_id AS id FROM inventory_movements
         UNION SELECT id FROM inventory`
    );
    for (const row of productIds) {
        if (row?.id) await syncInventoryStock(row.id);
    }
    return {
        orphanSalidasRemoved: salidaResult.changes || 0,
        orphanDevolucionesRemoved: devolResult.changes || 0
    };
}

app.post('/api/inventory/reconcile', async (req, res) => {
    try {
        const result = await cleanupOrphanMovements();
        res.json({ success: true, ...result });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
});

// Sales API
app.get('/api/sales', (req, res) => {
    const period = req.query.period;
    let sql = `SELECT * FROM sales`;
    const params = [];
    if (period) {
        sql += ` WHERE period = ?`;
        params.push(period);
    }
    sql += ` ORDER BY date DESC, id DESC`;
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
        res.json(rows);
    });
});

app.post('/api/sales', async (req, res) => {
    const { client, items, payment_method, date, period, sale_invoice_number, dian_invoice_file, observation, retention_percent } = req.body;
    if (!client || !items || !items.length) {
        return res.status(400).json({ error: 'Client and items are required.' });
    }
    const saleDate = date || new Date().toISOString().slice(0, 10);
    const salePeriod = period || saleDate.slice(0, 7);
    const saleBatchId = `SB-${Date.now()}`;
    const affectedProducts = new Set();
    const createdSaleIds = [];

    try {
        await ensureSalesColumns();
        await checkPeriodOpen(salePeriod);
        let storedDianFile = null;
        if (dian_invoice_file) {
            try {
                storedDianFile = persistInvoiceFile(dian_invoice_file, {
                    period: salePeriod,
                    invoice_number: sale_invoice_number || saleBatchId,
                    party_id: `client_${client}`,
                    category: 'sales'
                });
            } catch (fileErr) {
                return res.status(400).json({ error: `No se pudo guardar el PDF DIAN: ${fileErr.message}` });
            }
            if (!storedDianFile) {
                return res.status(400).json({ error: 'El archivo PDF DIAN no es válido.' });
            }
        }

        await dbRun('BEGIN TRANSACTION');

        for (const item of items) {
            const productId = item.product_id;
            const quantity = Number(item.quantity);
            const price = Number(item.price);
            const ivaPercent = Number(item.iva_percent) || 0;
            if (!productId || quantity <= 0) {
                await dbRun('ROLLBACK');
                return res.status(400).json({ error: 'Producto y cantidad válidos son requeridos.' });
            }

            const currentStock = await getProductStock(productId);
            if (currentStock < quantity) {
                await dbRun('ROLLBACK');
                const prod = await dbGet(`SELECT name FROM inventory WHERE id = ?`, [productId]);
                const name = prod ? prod.name : `ID ${productId}`;
                return res.status(400).json({
                    error: `Stock insuficiente para "${name}". Stock actual: ${currentStock}, solicitado: ${quantity}.`
                });
            }

            const line = saleLineTotals(quantity, price, ivaPercent);
            const retention = Number(retention_percent) || 0;
            if (!Number.isFinite(quantity) || !Number.isFinite(price) || price < 0 || !Number.isFinite(ivaPercent) || ivaPercent < 0 || retention < 0 || retention > 100) throw new Error('Cantidades, precios, IVA o retenciones inválidos.');
            line.total -= line.subtotal * retention / 100;
            const saleResult = await dbRun(
                `INSERT INTO sales (client, product_id, product_name, price, quantity, total, payment_method, date, period, iva_percent, iva_amount, sale_batch_id, sale_invoice_number, dian_invoice_file, observation, retention_percent)
                 VALUES (?, ?, (SELECT name FROM inventory WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [client, productId, productId, price, quantity, line.total, payment_method, saleDate, salePeriod, line.iva_percent, line.iva_amount, saleBatchId, sale_invoice_number || null, storedDianFile, observation || '', retention]
            );
            const saleId = saleResult.lastID;
            createdSaleIds.push(saleId);
            await createSaleMovement(saleId, salePeriod, saleDate, productId, quantity, price);
            affectedProducts.add(productId);
        }

        for (const productId of affectedProducts) {
            await syncInventoryStock(productId);
        }

        await dbRun('COMMIT');
        res.json({
            success: true,
            message: 'Venta registrada e inventario actualizado.',
            sale_ids: createdSaleIds,
            observation: observation || ''
        });
    } catch (err) {
        try { await dbRun('ROLLBACK'); } catch (_) {}
        console.error(err);
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/sales/:id', async (req, res) => {
    const { client, payment_method, date, quantity, product_id, price, iva_percent, iva_amount, sale_invoice_number, dian_invoice_file, observation, retention_percent } = req.body;
    try {
        await ensureSalesColumns();
        const sale = await dbGet(`SELECT * FROM sales WHERE id = ?`, [req.params.id]);
        if (!sale) return res.status(404).json({ error: 'Venta no encontrada' });

        // An observation-only edit must not recalculate or rewrite other sale fields.
        if (Object.keys(req.body).length === 1 && Object.prototype.hasOwnProperty.call(req.body, 'observation')) {
            if (observation !== null && typeof observation !== 'string') return res.status(400).json({ error: 'La observación debe ser texto.' });
            const savedObservation = observation ?? '';
            const invoiceLines = sale.sale_batch_id
                ? await dbAll('SELECT id, period FROM sales WHERE sale_batch_id = ?', [sale.sale_batch_id])
                : [sale];
            for (const invoiceLine of invoiceLines) await checkPeriodOpen(invoiceLine.period);
            if (sale.sale_batch_id) {
                await dbRun('UPDATE sales SET observation = ? WHERE sale_batch_id = ?', [savedObservation, sale.sale_batch_id]);
            } else {
                await dbRun('UPDATE sales SET observation = ? WHERE id = ?', [savedObservation, sale.id]);
            }
            return res.json({ success: true, observation: savedObservation });
        }

        const newDate = date || sale.date;
        const newPeriod = newDate.slice(0, 7);
        const newQty = quantity !== undefined ? Number(quantity) : Number(sale.quantity);
        const newProductId = product_id !== undefined ? Number(product_id) : Number(sale.product_id);
        const newPrice = price !== undefined ? Number(price) : Number(sale.price);
        const newIvaPercent = iva_percent !== undefined ? Number(iva_percent) : Number(sale.iva_percent) || 0;
        const line = saleLineTotals(newQty, newPrice, newIvaPercent);
        const newIvaAmount = line.iva_amount;
        const newRetention = retention_percent !== undefined ? Number(retention_percent) : Number(sale.retention_percent) || 0;
        if (![newQty, newPrice, newIvaPercent, newIvaAmount, newRetention].every(Number.isFinite) || newPrice < 0 || newIvaPercent < 0 || newIvaAmount < 0 || newRetention < 0 || newRetention > 100) return res.status(400).json({ error: 'Valores de venta inválidos.' });
        const newTotal = line.subtotal + newIvaAmount - line.subtotal * newRetention / 100;
        const newClient = client !== undefined ? client : sale.client;
        const newPayment = payment_method !== undefined ? payment_method : sale.payment_method;
        const newObservation = observation !== undefined ? observation : sale.observation || '';

        await checkPeriodOpen(sale.period);
        await checkPeriodOpen(newPeriod);
        if (newQty <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a cero.' });

        let storedDianFile = sale.dian_invoice_file;
        if (dian_invoice_file) {
            try {
                storedDianFile = persistInvoiceFile(dian_invoice_file, {
                    period: newPeriod,
                    invoice_number: sale_invoice_number || sale.sale_invoice_number || sale.sale_batch_id || sale.id,
                    party_id: `client_${client}`,
                    category: 'sales'
                });
            } catch (fileErr) {
                return res.status(400).json({ error: `No se pudo guardar el PDF DIAN: ${fileErr.message}` });
            }
        }
        const newInvoiceNumber = sale_invoice_number !== undefined ? sale_invoice_number : sale.sale_invoice_number;

        await dbRun('BEGIN TRANSACTION');

        const productChanged = newProductId !== Number(sale.product_id);
        const qtyChanged = newQty !== Number(sale.quantity);
        const batchId = sale.sale_batch_id || String(sale.id);

        if (productChanged) {
            const available = await getAvailableStockForSaleEdit(newProductId, sale.id);
            if (available < newQty) {
                await dbRun('ROLLBACK');
                const prod = await dbGet(`SELECT name FROM inventory WHERE id = ?`, [newProductId]);
                return res.status(400).json({
                    error: `Stock insuficiente para "${prod?.name || newProductId}". Disponible: ${available}.`
                });
            }
            await removeSaleMovementAndReturns(sale);
            await dbRun(
                `UPDATE sales SET client = ?, product_id = ?, product_name = (SELECT name FROM inventory WHERE id = ?),
                 price = ?, quantity = ?, total = ?, payment_method = ?, date = ?, period = ?, iva_percent = ?, iva_amount = ?,
                 sale_invoice_number = ?, dian_invoice_file = ? WHERE id = ?`,
                [newClient, newProductId, newProductId, newPrice, newQty, newTotal, newPayment, newDate, newPeriod, newIvaPercent, newIvaAmount, newInvoiceNumber, storedDianFile, req.params.id]
            );
            if (sale.sale_batch_id) {
                await dbRun(
                    `UPDATE sales SET client = ?, payment_method = ?, sale_invoice_number = ?, dian_invoice_file = ? WHERE sale_batch_id = ? AND id != ?`,
                    [newClient, newPayment, newInvoiceNumber, storedDianFile, batchId, req.params.id]
                );
            }
            await createSaleMovement(sale.id, newPeriod, newDate, newProductId, newQty, newPrice);
            await syncInventoryStock(sale.product_id);
            await syncInventoryStock(newProductId);
        } else if (qtyChanged || newPrice !== Number(sale.price) || newDate !== sale.date) {
            const available = await getAvailableStockForSaleEdit(newProductId, sale.id);
            if (available < newQty) {
                await dbRun('ROLLBACK');
                const prod = await dbGet(`SELECT name FROM inventory WHERE id = ?`, [newProductId]);
                return res.status(400).json({
                    error: `Stock insuficiente. Disponible para esta venta: ${available}, solicitado: ${newQty}.`
                });
            }
            const mov = await findSaleMovement(sale);
            if (mov) {
                await dbRun(
                    `UPDATE inventory_movements SET quantity = ?, unit_cost = ?, total = ?, date = ?, period = ?, product_id = ?
                     WHERE id = ?`,
                    [newQty, newPrice, newTotal, newDate, newPeriod, newProductId, mov.id]
                );
            } else {
                await createSaleMovement(sale.id, newPeriod, newDate, newProductId, newQty, newPrice);
            }
            await dbRun(
                `UPDATE sales SET client = ?, product_id = ?, product_name = (SELECT name FROM inventory WHERE id = ?),
                 price = ?, quantity = ?, total = ?, payment_method = ?, date = ?, period = ?, iva_percent = ?, iva_amount = ?,
                 sale_invoice_number = ?, dian_invoice_file = ? WHERE id = ?`,
                [newClient, newProductId, newProductId, newPrice, newQty, newTotal, newPayment, newDate, newPeriod, newIvaPercent, newIvaAmount, newInvoiceNumber, storedDianFile, req.params.id]
            );
            if (sale.sale_batch_id) {
                await dbRun(
                    `UPDATE sales SET client = ?, payment_method = ?, sale_invoice_number = ?, dian_invoice_file = ? WHERE sale_batch_id = ? AND id != ?`,
                    [newClient, newPayment, newInvoiceNumber, storedDianFile, batchId, req.params.id]
                );
            }
            await syncInventoryStock(newProductId);
        } else {
            await dbRun(
                `UPDATE sales SET client = ?, payment_method = ?, date = ?, period = ?, sale_invoice_number = ?, dian_invoice_file = ? WHERE id = ?`,
                [newClient, newPayment, newDate, newPeriod, newInvoiceNumber, storedDianFile, req.params.id]
            );
            if (sale.sale_batch_id) {
                await dbRun(
                    `UPDATE sales SET client = ?, payment_method = ?, sale_invoice_number = ?, dian_invoice_file = ? WHERE sale_batch_id = ? AND id != ?`,
                    [newClient, newPayment, newInvoiceNumber, storedDianFile, batchId, req.params.id]
                );
            }
        }

        await dbRun('UPDATE sales SET client = ?, payment_method = ?, price = ?, quantity = ?, total = ?, iva_percent = ?, iva_amount = ?, observation = ?, retention_percent = ? WHERE id = ?',
            [newClient, newPayment, newPrice, newQty, newTotal, newIvaPercent, newIvaAmount, newObservation, newRetention, sale.id]);
        if (sale.sale_batch_id) {
            const lines = await dbAll('SELECT * FROM sales WHERE sale_batch_id = ? AND id != ?', [sale.sale_batch_id, sale.id]);
            for (const other of lines) {
                const movement = await findSaleMovement(other);
                if (movement) {
                    await dbRun('UPDATE inventory_movements SET date = ?, period = ? WHERE id = ?', [newDate, newPeriod, movement.id]);
                }
                const totals = saleLineTotals(other.quantity, other.price, other.iva_percent);
                await dbRun('UPDATE sales SET client = ?, payment_method = ?, observation = ?, retention_percent = ?, total = ?, date = ?, period = ? WHERE id = ?',
                    [newClient, newPayment, newObservation, newRetention, totals.total - totals.subtotal * newRetention / 100, newDate, newPeriod, other.id]);
            }
        }
        await dbRun('COMMIT');
        res.json({ success: true, message: 'Venta e inventario actualizados.' });
    } catch (e) {
        try { await dbRun('ROLLBACK'); } catch (_) {}
        console.error(e);
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/sales/:id', async (req, res) => {
    try {
        const sale = await dbGet(`SELECT * FROM sales WHERE id = ?`, [req.params.id]);
        if (!sale) return res.status(404).json({ error: 'Venta no encontrada' });

        await checkPeriodOpen(sale.period);
        await dbRun('BEGIN TRANSACTION');
        await removeSaleMovementAndReturns(sale);
        await dbRun(`DELETE FROM sales WHERE id = ?`, [req.params.id]);
        await syncInventoryStock(sale.product_id);
        await dbRun('COMMIT');
        res.json({ success: true, message: 'Venta eliminada e inventario restaurado.' });
    } catch (e) {
        try { await dbRun('ROLLBACK'); } catch (_) {}
        console.error(e);
        res.status(400).json({ error: e.message });
    }
});


// Get a single sale by ID
app.get('/api/sales/:id', (req, res) => {
    const id = req.params.id;
    db.get(`SELECT * FROM sales WHERE id = ?`, [id], (err, row) => {
        if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
        if (!row) return res.status(404).json({ error: 'Venta no encontrada' });
        res.json(row);
    });
});

// Get sales by client name
app.get('/api/sales/client/:client', (req, res) => {
    const client = req.params.client;
    db.all(`SELECT * FROM sales WHERE client = ?`, [client], (err, rows) => {
        if (err) return res.status(500).json({ error: 'No se pudo completar la operación.' });
        res.json(rows);
    });
});

app.get('/api/sales/:id/dian-invoice-file', async (req, res) => {
    try {
        await ensureSalesColumns();
        const sale = await dbGet('SELECT dian_invoice_file, sale_invoice_number, sale_batch_id FROM sales WHERE id = ?', [req.params.id]);
        if (!sale || !sale.dian_invoice_file) {
            return res.status(404).json({ error: 'No hay factura DIAN adjunta para esta venta.' });
        }
        const stored = sale.dian_invoice_file;
        const fileLabel = sale.sale_invoice_number || sale.sale_batch_id || req.params.id;
        if (stored.startsWith('data:')) {
            const match = stored.match(/^data:(application\/pdf);base64,(.+)$/s);
            if (!match) return res.status(400).json({ error: 'Archivo adjunto inválido.' });
            const buf = invoiceBuffer(stored);
            res.setHeader('Content-Type', match[1] || 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="Factura_DIAN_${fileLabel}.pdf"`);
            return res.send(buf);
        }
        const abs = resolveInvoicePath(stored);
        if (!fs.existsSync(abs)) {
            return res.status(404).json({ error: 'El archivo PDF DIAN no se encuentra en el servidor.' });
        }
        return res.download(abs, `Factura_DIAN_${fileLabel}.pdf`);
    } catch (e) {
        return res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
});

// --- Period Opening Balance API ---
app.get('/api/period-opening-balance/:period', async (req, res) => {
    try {
        const period = req.params.period;
        const row = await dbGet(
            `SELECT * FROM period_opening_balance WHERE period = ?`,
            [period]
        );
        if (!row) {
            return res.json({
                period,
                opening_cash: 0,
                opening_bank: 0,
                opening_merchandise_value: 0,
                opening_other_assets: 0,
                opening_total: 0
            });
        }
        res.json(row);
    } catch (e) {
        res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
});

// Helper function to calculate closing balance for a period
async function calculatePeriodClosingBalance(period, openingCash, openingBank) {
    try {
        // Sales flows
        const salesRows = await dbAll(
            `SELECT payment_method, total FROM sales WHERE period = ?`,
            [period]
        );
        
        let salesCash = 0, salesBank = 0;
        salesRows.forEach(s => {
            if (s.payment_method === 'Efectivo') {
                salesCash += Number(s.total) || 0;
            } else {
                salesBank += Number(s.total) || 0;
            }
        });

        // Expense flows
        const expenseRows = await dbAll(
            `SELECT payment_method, amount FROM expenses WHERE period = ?`,
            [period]
        );
        
        let expCash = 0, expBank = 0;
        expenseRows.forEach(e => {
            if (e.payment_method === 'Efectivo') {
                expCash += Number(e.amount) || 0;
            } else {
                expBank += Number(e.amount) || 0;
            }
        });

        // Merchandise purchases
        const mercRow = await dbAll(
            `SELECT total FROM inventory_movements WHERE period = ? AND type = 'ENTRADA' AND reason = 'Compra'`,
            [period]
        );
        const merchandise = mercRow.reduce((sum, m) => sum + (Number(m.total) || 0), 0);

        // Calculate closing balances
        const closingCash = openingCash + salesCash - expCash;
        const closingBank = openingBank + salesBank - expBank - merchandise;

        return { closingCash, closingBank };
    } catch (err) {
        console.error('Error calculating closing balance:', err);
        return { closingCash: 0, closingBank: 0 };
    }
}

// Helper function to cascade update all following periods
async function cascadeUpdateFollowingPeriods(startPeriod) {
    try {
        // Get all periods ordered
        const allPeriods = await dbAll(`SELECT month FROM periods ORDER BY month ASC`);
        const periodMonths = allPeriods.map(p => p.month);
        const startIndex = periodMonths.indexOf(startPeriod);
        
        if (startIndex === -1) return;
        
        // Update this period and all following periods
        for (let i = startIndex; i < periodMonths.length; i++) {
            const currentPeriod = periodMonths[i];
            
            // Get current opening balance
            const openingRow = await dbGet(
                `SELECT opening_cash, opening_bank FROM period_opening_balance WHERE period = ?`,
                [currentPeriod]
            );
            
            const openingCash = Number(openingRow?.opening_cash) || 0;
            const openingBank = Number(openingRow?.opening_bank) || 0;
            
            // Calculate closing balance
            const { closingCash, closingBank } = await calculatePeriodClosingBalance(currentPeriod, openingCash, openingBank);
            
            // If this is not the last period, update next period's opening balance
            if (i < periodMonths.length - 1) {
                const nextPeriod = periodMonths[i + 1];
                const now = new Date().toISOString();
                
                await dbRun(
                    `INSERT INTO period_opening_balance (period, opening_cash, opening_bank, opening_merchandise_value, opening_other_assets, opening_total, createdAt, updatedAt)
                     VALUES (?, ?, ?, 0, 0, ?, ?, ?)
                     ON CONFLICT(period) DO UPDATE SET 
                        opening_cash = excluded.opening_cash, 
                        opening_bank = excluded.opening_bank, 
                        opening_total = excluded.opening_total,
                        updatedAt = ?`,
                    [nextPeriod, closingCash, closingBank, closingCash + closingBank, now, now, now]
                );
            }
        }
    } catch (err) {
        console.error('Error cascading update:', err);
    }
}

app.put('/api/period-opening-balance/:period', async (req, res) => {
    try {
        const period = req.params.period;
        const { opening_cash, opening_bank, opening_merchandise_value, opening_other_assets } = req.body;
        const cash = Number(opening_cash) || 0;
        const bank = Number(opening_bank) || 0;
        const merchandise = Number(opening_merchandise_value) || 0;
        const other = Number(opening_other_assets) || 0;
        const total = cash + bank + merchandise + other;
        const now = new Date().toISOString();
        
        // First, update the current period
        await dbRun(
            `INSERT INTO period_opening_balance (period, opening_cash, opening_bank, opening_merchandise_value, opening_other_assets, opening_total, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(period) DO UPDATE SET 
                opening_cash = excluded.opening_cash, 
                opening_bank = excluded.opening_bank, 
                opening_merchandise_value = excluded.opening_merchandise_value,
                opening_other_assets = excluded.opening_other_assets, 
                opening_total = excluded.opening_total, 
                updatedAt = ?`,
            [period, cash, bank, merchandise, other, total, now, now, now]
        );
        
        // Then cascade update all following periods
        await cascadeUpdateFollowingPeriods(period);
        
        res.json({ success: true, period, opening_cash: cash, opening_bank: bank, opening_merchandise_value: merchandise, opening_other_assets: other, opening_total: total });
    } catch (e) {
        res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
});

// --- Comprehensive Accounting Report API ---
app.get('/api/accounting-report', async (req, res) => {
    try {
        const period = req.query.period;
        if (!period) {
            return res.status(400).json({ error: 'Período requerido (ej: 2026-05)' });
        }

        // 1. Opening Balance
        const openingBalance = await dbGet(
            `SELECT * FROM period_opening_balance WHERE period = ?`,
            [period]
        );
        const opening = openingBalance || {
            opening_cash: 0,
            opening_bank: 0,
            opening_merchandise_value: 0,
            opening_other_assets: 0,
            opening_total: 0
        };

        // 2. Total Sales (Revenue)
        const salesRow = await dbGet(
            `SELECT COALESCE(SUM(total), 0) as total, COALESCE(SUM(iva_amount), 0) as iva FROM sales WHERE period = ?`,
            [period]
        );
        const totalSalesWithIva = (salesRow?.total || 0) + (salesRow?.iva || 0);
        const totalSales = salesRow?.total || 0;
        const salesTaxCollected = salesRow?.iva || 0;

        // Sales paid in cash vs bank
        const salesCashRow = await dbGet(
            `SELECT COALESCE(SUM(total), 0) as total FROM sales WHERE period = ? AND payment_method = 'Efectivo'`,
            [period]
        );
        const salesCash = salesCashRow?.total || 0;
        const salesBank = totalSales - salesCash;

        // 3. Cost of Goods Sold (COGS) - From Inventory Movements
        const cogsRow = await dbGet(
            `SELECT COALESCE(SUM(total), 0) as cogs FROM inventory_movements 
             WHERE period = ? AND type = 'ENTRADA' AND reason = 'Compra'`,
            [period]
        );
        const cogs = cogsRow?.cogs || 0;

        // 4. Gross Profit = Total Sales - COGS
        const grossProfit = totalSales - cogs;

        // 5. Operating Expenses total
        const expensesRow = await dbGet(
            `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE period = ?`,
            [period]
        );
        const totalExpenses = expensesRow?.total || 0;

        // 5b. Expense Tax (IVA on expenses) — fetched early so we can use it in opex split
        const expenseTaxRow = await dbGet(
            `SELECT COALESCE(SUM(iva_amount), 0) as iva FROM expenses WHERE period = ?`,
            [period]
        );
        const expenseTaxPaid = expenseTaxRow?.iva || 0;

        // Expenses paid in cash vs bank (including IVA as real money movement)
        const expCashRow = await dbGet(
            `SELECT COALESCE(SUM(amount + COALESCE(iva_amount,0)), 0) as total FROM expenses WHERE period = ? AND payment_method = 'Efectivo'`,
            [period]
        );
        const opexCash = expCashRow?.total || 0;
        const opexBank = (totalExpenses + expenseTaxPaid) - opexCash;

        // Get expenses by category
        const expensesByCategory = await dbAll(
            `SELECT category, COALESCE(SUM(amount), 0) as total FROM expenses WHERE period = ? GROUP BY category ORDER BY category`,
            [period]
        );

        // 6. Operating Profit = Gross Profit - Operating Expenses
        const operatingProfit = grossProfit - totalExpenses;

        // 7. Purchase Tax (IVA on purchases)
        const purchaseTaxRow = await dbGet(
            `SELECT COALESCE(SUM(iva_amount), 0) as iva FROM inventory_movements 
             WHERE period = ? AND type = 'ENTRADA' AND reason = 'Compra'`,
            [period]
        );
        const purchaseTaxPaid = purchaseTaxRow?.iva || 0;

        // 9. Net Tax Position
        const netTaxPosition = salesTaxCollected - (purchaseTaxPaid + expenseTaxPaid);

        // 10. Ending Merchandise Inventory Value (current stock value)
        const inventoryRow = await dbGet(
            `SELECT COALESCE(SUM(stock * purchase_price), 0) as value FROM inventory WHERE status = 'Activo'`,
            []
        );
        const endingInventoryValue = inventoryRow?.value || 0;

        // 11. Purchases (COGS) — inventory_movements has no payment_method column,
        //     so all purchases are treated as bank payments by default.
        const purchCash = 0;
        const purchBank = cogs + purchaseTaxPaid;

        // 12. Cash Flow Summary
        // Inflows: ventas cobradas por cada canal (IVA incluido proporcional)
        const ivaRatioCash = totalSales > 0 ? salesCash / totalSales : 0;
        const ivaRatioBank = totalSales > 0 ? salesBank / totalSales : 0;
        const cashInflowsActual  = salesCash + (salesTaxCollected * ivaRatioCash);
        const bankInflowsActual  = salesBank + (salesTaxCollected * ivaRatioBank);

        // Outflows: gastos y compras por cada canal
        const cashOutflowsActual = opexCash + purchCash;
        const bankOutflowsActual = opexBank + purchBank;

        // Saldo final = saldo inicial + entradas - salidas
        const closingCash = (opening.opening_cash || 0) + cashInflowsActual - cashOutflowsActual;
        const closingBank = (opening.opening_bank || 0) + bankInflowsActual - bankOutflowsActual;

        // Build comprehensive report
        const report = {
            period,
            statement_date: new Date().toISOString().split('T')[0],
            
            // I. Opening Balance Section
            opening_balance: {
                opening_cash: Number(opening.opening_cash) || 0,
                opening_bank: Number(opening.opening_bank) || 0,
                opening_merchandise_value: Number(opening.opening_merchandise_value) || 0,
                opening_other_assets: Number(opening.opening_other_assets) || 0,
                opening_total: Number(opening.opening_total) || 0
            },

            // II. Revenue Section
            revenue: {
                sales_subtotal: totalSales,
                sales_tax_collected: salesTaxCollected,
                sales_total_with_tax: totalSalesWithIva
            },

            // III. Cost of Goods Sold
            cogs_section: {
                purchases_of_merchandise: cogs,
                purchase_tax_paid: purchaseTaxPaid,
                ending_inventory_value: endingInventoryValue
            },

            // IV. Gross Profit
            gross_profit: grossProfit,

            // V. Operating Expenses
            operating_expenses: {
                total_expenses: totalExpenses,
                expenses_tax_paid: expenseTaxPaid,
                by_category: expensesByCategory.map(e => ({
                    category: e.category || 'Sin categoría',
                    amount: e.total
                }))
            },

            // VI. Operating Profit
            operating_profit: operatingProfit,

            // VII. Tax Summary
            tax_summary: {
                sales_tax_collected: salesTaxCollected,
                purchase_tax_paid: purchaseTaxPaid,
                expense_tax_paid: expenseTaxPaid,
                net_tax_position: netTaxPosition
            },

            // VIII. Cash Position
            cash_position: {
                opening_cash: Number(opening.opening_cash) || 0,
                opening_bank: Number(opening.opening_bank) || 0,
                cash_inflows: cashInflowsActual,
                bank_inflows: bankInflowsActual,
                cash_outflows: cashOutflowsActual,
                bank_outflows: bankOutflowsActual,
                closing_cash: closingCash,
                closing_bank: closingBank
            },

            // IX. Summary
            summary: {
                total_sales: totalSales,
                total_cogs: cogs,
                gross_profit: grossProfit,
                total_expenses: totalExpenses,
                operating_profit: operatingProfit,
                opening_inventory_value: Number(opening.opening_merchandise_value) || 0,
                ending_inventory_value: endingInventoryValue,
                net_income: operatingProfit
            }
        };

        res.json(report);
    } catch (e) {
        console.error('Error generating accounting report:', e);
        res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
});

async function startServer() {
    await ensureInventoryColumns();
    await ensureInventoryMovementColumns();
    await ensureSalesColumns();
    await ensureExpenseColumns();
    await dbRun("UPDATE sales SET period = substr(date, 1, 7) WHERE period IS NULL OR period = ''");
    await dbRun("UPDATE expenses SET period = substr(date, 1, 7) WHERE period IS NULL OR period = ''");
    const seeded = await seedDemoData(db);
    if (seeded) console.log('Datos ficticios de demostración cargados.');
    // La reconciliación destructiva solo se solicita explícitamente desde la API.
    app.listen(port, host, () => console.log(`LuMedix app listening on http://${host}:${port}`));
}
startServer().catch(error => { console.error('No se pudo iniciar LuMedix:', error); process.exitCode = 1; db.close(); });
