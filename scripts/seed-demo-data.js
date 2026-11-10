const DEMO_SEED_VERSION = '3';

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    });
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(error) {
            if (error) reject(error);
            else resolve(this);
        });
    });
}

function getPeriod(offset) {
    const [year, month] = new Date().toISOString().slice(0, 7).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1 + offset, 1));
    return date.toISOString().slice(0, 7);
}

function getDate(period, day) {
    const currentPeriod = new Date().toISOString().slice(0, 7);
    const safeDay = period === currentPeriod ? Math.min(day, new Date().getUTCDate()) : day;
    return `${period}-${String(safeDay).padStart(2, '0')}`;
}

async function seedDemoData(db) {
    const marker = await get(db, "SELECT value FROM company_settings WHERE key = 'demo_seed_version'");
    if (marker) return false;
    // Nunca reemplazar una base que ya contenga información.
    for (const table of ['inventory', 'inventory_movements', 'sales', 'expenses', 'suppliers', 'clients', 'company_settings', 'period_opening_balance']) {
        const row = await get(db, 'SELECT COUNT(*) AS total FROM ' + table);
        if (row.total > 0) return false;
    }

    const periods = [getPeriod(-2), getPeriod(-1), getPeriod(0)];
    const [olderPeriod, previousPeriod, currentPeriod] = periods;
    await run(db, 'BEGIN IMMEDIATE');

    try {

        for (const month of periods) {
            await run(db, "INSERT OR IGNORE INTO periods (month, status) VALUES (?, 'ABIERTO')", [month]);
        }

        const supplierRows = [
            ['Distribuciones Andinas DEMO', '900000001-0', 'Laura Demo', '3000000001', 'compras1@example.com', 'Calle 10 # 20-30', 'Bogotá', 'inventory'],
            ['Suministros Clínicos DEMO', '900000002-0', 'Carlos Demo', '3000000002', 'compras2@example.com', 'Carrera 15 # 40-20', 'Medellín', 'inventory'],
            ['Servicios Administrativos DEMO', '900000003-0', 'María Demo', '3000000003', 'servicios@example.com', 'Calle 5 # 8-12', 'Cali', 'expense']
        ];
        const supplierIds = [];
        for (const supplier of supplierRows) {
            const result = await run(db, `INSERT INTO suppliers
                (name, identification, contact, phone, email, address, city, observation, supplier_type, status, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Activo', ?, ?)`,
            [...supplier.slice(0, 7), 'Proveedor ficticio para demostración.', supplier[7], new Date().toISOString(), new Date().toISOString()]);
            supplierIds.push(result.lastID);
        }

        const clientRows = [
            ['Clínica Horizonte DEMO', '800000001-0', 'Ana Ejemplo', '3010000001', 'cliente1@example.com', 'Avenida 1 # 2-3', 'Bogotá'],
            ['Centro Médico del Parque DEMO', '800000002-0', 'Luis Ejemplo', '3010000002', 'cliente2@example.com', 'Carrera 20 # 15-10', 'Medellín'],
            ['Consultorio Vida Plena DEMO', '800000003-0', 'Sofía Ejemplo', '3010000003', 'cliente3@example.com', 'Calle 30 # 10-5', 'Cali']
        ];
        const clientIds = [];
        for (const client of clientRows) {
            const result = await run(db, `INSERT INTO clients
                (name, identification, contact, phone, email, address, city, observation, status, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Activo', ?, ?)`,
            [...client, 'Cliente ficticio para demostración.', new Date().toISOString(), new Date().toISOString()]);
            clientIds.push(result.lastID);
        }

        const products = [
            { code: 'DEMO-001', name: 'Guantes de nitrilo talla M', category: 'Bioseguridad', minStock: 8, purchasePrice: 12000, salePrice: 22500, supplierId: supplierIds[0], supplierName: supplierRows[0][0], quantity: 36, period: olderPeriod },
            { code: 'DEMO-002', name: 'Mascarilla quirúrgica x 50', category: 'Bioseguridad', minStock: 10, purchasePrice: 2500, salePrice: 5200, supplierId: supplierIds[1], supplierName: supplierRows[1][0], quantity: 48, period: previousPeriod },
            { code: 'DEMO-003', name: 'Gel antibacterial 500 ml', category: 'Higiene', minStock: 6, purchasePrice: 11000, salePrice: 19800, supplierId: supplierIds[0], supplierName: supplierRows[0][0], quantity: 30, period: currentPeriod }
        ];
        const productIds = [];
        for (const product of products) {
            const result = await run(db, `INSERT INTO inventory
                (code, name, category, min_stock, status, supplier, price, stock, purchase_price, sale_price)
                VALUES (?, ?, ?, ?, 'Activo', ?, ?, 0, ?, ?)`,
            [product.code, product.name, product.category, product.minStock, product.supplierName, product.salePrice, product.purchasePrice, product.salePrice]);
            productIds.push(result.lastID);

            const purchaseDate = getDate(product.period, 5);
            const subtotal = product.quantity * product.purchasePrice;
            const iva = Math.round(subtotal * 0.19);
            await run(db, `INSERT INTO inventory_movements
                (period, date, product_id, type, reason, quantity, unit_cost, total, observation, supplier_id, supplier_name, invoice_number, iva_percent, iva_amount, invoice_file)
                VALUES (?, ?, ?, 'ENTRADA', 'Compra', ?, ?, ?, ?, ?, ?, ?, 19, ?, NULL)`,
            [product.period, purchaseDate, result.lastID, product.quantity, product.purchasePrice, subtotal + iva, 'Compra ficticia de demostración.', product.supplierId, product.supplierName, `DEMO-C-${product.code}`, iva]);
        }

        const salesData = [
            { period: olderPeriod, day: 18, productIndex: 0, quantity: 2, clientIndex: 0, price: 22500, payment: 'Efectivo', invoice: 'DEMO-V-001' },
            { period: previousPeriod, day: 16, productIndex: 0, quantity: 3, clientIndex: 1, price: 22500, payment: 'Transferencia', invoice: 'DEMO-V-002' },
            { period: currentPeriod, day: 3, productIndex: 0, quantity: 4, clientIndex: 0, price: 22500, payment: 'Efectivo', invoice: 'DEMO-V-003' },
            { period: currentPeriod, day: 6, productIndex: 1, quantity: 5, clientIndex: 1, price: 5200, payment: 'Transferencia', invoice: 'DEMO-V-004' },
            { period: currentPeriod, day: 8, productIndex: 2, quantity: 4, clientIndex: 2, price: 19800, payment: 'Efectivo', invoice: 'DEMO-V-005' }
        ];
        for (const sale of salesData) {
            const product = products[sale.productIndex];
            const productId = productIds[sale.productIndex];
            const date = getDate(sale.period, sale.day);
            const subtotal = sale.quantity * sale.price;
            const iva = Math.round(subtotal * 0.19);
            const batchId = `DEMO-${sale.invoice}`;
            const result = await run(db, `INSERT INTO sales
                (client, product_id, product_name, price, quantity, total, payment_method, date, period, iva_percent, iva_amount, sale_batch_id, sale_invoice_number, dian_invoice_file, observation, retention_percent)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 19, ?, ?, ?, NULL, ?, 0)`,
            [clientRows[sale.clientIndex][0], productId, product.name, sale.price, sale.quantity, subtotal + iva, sale.payment, date, sale.period, iva, batchId, sale.invoice, 'Venta ficticia para demostración.']);
            await run(db, `INSERT INTO inventory_movements
                (period, date, product_id, type, reason, quantity, unit_cost, total, observation, sale_id)
                VALUES (?, ?, ?, 'SALIDA', 'Venta', ?, ?, ?, ?, ?)`,
            [sale.period, date, productId, sale.quantity, sale.price, subtotal, 'Salida asociada a venta ficticia.', result.lastID]);
        }

        const expenseRows = [
            ['Arriendo de consultorio DEMO', 'Administración', 1, 850000, 0, 'Transferencia', 'DEMO-G-001'],
            ['Papelería y suministros DEMO', 'Oficina', 2, 42000, 19, 'Efectivo', 'DEMO-G-002']
        ];
        for (const expense of expenseRows) {
            const subtotal = expense[2] * expense[3];
            const iva = Math.round(subtotal * expense[4] / 100);
            await run(db, `INSERT INTO expenses
                (description, amount, date, period, category, supplier_id, supplier_name, invoice_number, invoice_file, payment_method, observation, expense_batch_id, line_description, quantity, unit_price, iva_percent, iva_amount)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [expense[0], subtotal + iva, getDate(currentPeriod, expenseRows.indexOf(expense) === 0 ? 4 : 7), currentPeriod, expense[1], supplierIds[2], supplierRows[2][0], expense[6], expense[5], 'Gasto ficticio para demostración.', `DEMO-${expense[6]}`, expense[0], expense[2], expense[3], expense[4], iva]);
        }

        let openingCash = 300000;
        let openingBank = 2000000;
        let openingMerchandise = 500000;
        let openingOther = 25000;
        for (const month of periods) {
            const now = new Date().toISOString();
            await run(db, `INSERT INTO period_opening_balance
                (period, opening_cash, opening_bank, opening_merchandise_value, opening_other_assets, opening_total, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [month, openingCash, openingBank, openingMerchandise, openingOther, openingCash + openingBank + openingMerchandise + openingOther, now, now]);

            const sales = await get(db, `SELECT
                COALESCE(SUM(CASE WHEN payment_method = 'Efectivo' THEN total ELSE 0 END), 0) AS cash,
                COALESCE(SUM(CASE WHEN payment_method != 'Efectivo' THEN total ELSE 0 END), 0) AS bank
                FROM sales WHERE period = ?`, [month]);
            const expenses = await get(db, `SELECT
                COALESCE(SUM(CASE WHEN payment_method = 'Efectivo' THEN amount ELSE 0 END), 0) AS cash,
                COALESCE(SUM(CASE WHEN payment_method != 'Efectivo' THEN amount ELSE 0 END), 0) AS bank
                FROM expenses WHERE period = ?`, [month]);
            const purchases = await get(db, `SELECT COALESCE(SUM(total), 0) AS total
                FROM inventory_movements WHERE period = ? AND type = 'ENTRADA' AND reason = 'Compra'`, [month]);

            openingCash += Number(sales.cash) - Number(expenses.cash);
            openingBank += Number(sales.bank) - Number(expenses.bank) - Number(purchases.total);
        }

        await run(db, `INSERT INTO company_settings (key, value) VALUES ('opening_cash_balance', '150000')`);
        await run(db, `INSERT INTO company_settings (key, value) VALUES ('demo_seed_version', ?)`, [DEMO_SEED_VERSION]);
        await run(db, 'COMMIT');
        return true;
    } catch (error) {
        try {
            await run(db, 'ROLLBACK');
        } catch (rollbackError) {
            console.error('Error al revertir la carga de demostración:', rollbackError);
        }
        throw error;
    }
}

module.exports = seedDemoData;
