let inventory = [];
let inventoryMovements = [];
let sales = [];
let expenses = [];
let periods = [];
let suppliers = [];
let clients = [];
let currentInvoiceItems = [];
let currentSaleItems = [];
let editingSaleId = null;
let editingExpenseId = null;
let editingExpenseBatchId = null;
let currentExpenseItems = [];
let currentExpenseInvoiceFile = null;
let openingCashBalance = 0;
let currentPeriodOpeningCash = 0;
let currentPeriodOpeningBank = 0;

const EXPENSE_CLASS_BY_CATEGORY = {
    'Transporte': 'Operativo',
    'Empaques': 'Operativo',
    'Publicidad': 'Operativo',
    'Comisiones bancarias': 'Financiero',
    'Arriendo': 'Administrativo',
    'Servicios públicos': 'Administrativo',
    'Internet / telefonía': 'Administrativo',
    'Papelería': 'Administrativo',
    'Aseo': 'Administrativo',
    'Mantenimiento': 'Administrativo',
    'Honorarios': 'Administrativo',
    'Equipos / muebles': 'Administrativo',
    'Software / suscripciones': 'Administrativo',
    'Otros': 'Administrativo'
};
/** @type {{ old_supplier_id: string|number, old_invoice_number: string } | null} */
let editingInvoice = null;
let myChart;
let currentActivePeriod = '';

// Formatters
const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const copFormatter = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

/** Más reciente arriba, más antigua abajo */
function sortByDateDesc(list, dateField = 'date') {
    return list.slice().sort((a, b) => {
        const byDate = String(b[dateField] || '').localeCompare(String(a[dateField] || ''));
        if (byDate !== 0) return byDate;
        return (Number(b.id) || 0) - (Number(a.id) || 0);
    });
}

function getInvFilterState(prefix) {
    return {
        search: (document.getElementById(`${prefix}-filter-search`)?.value || '').trim().toLowerCase(),
        productId: document.getElementById(`${prefix}-filter-product`)?.value || '',
        supplierId: document.getElementById(`${prefix}-filter-supplier`)?.value || '',
        type: document.getElementById(`${prefix}-filter-type`)?.value || '',
        reason: document.getElementById(`${prefix}-filter-reason`)?.value || '',
        dateFrom: document.getElementById(`${prefix}-filter-date-from`)?.value || '',
        dateTo: document.getElementById(`${prefix}-filter-date-to`)?.value || '',
        periodOnly: !!document.getElementById(`${prefix}-filter-period`)?.checked
    };
}

function movementMatchesDate(m, dateFrom, dateTo) {
    const d = String(m.date || '').slice(0, 10);
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
}

function movementMatchesSearch(m, search) {
    if (!search) return true;
    const prod = inventory.find(i => String(i.id) === String(m.product_id));
    const haystack = [
        prod?.name,
        prod?.code,
        m.supplier_name,
        m.invoice_number,
        m.observation,
        m.reason,
        m.type
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(search);
}

function applyInvMovementFilters(movs, prefix) {
    const f = getInvFilterState(prefix);
    return movs.filter(m => {
        if (f.periodOnly && currentActivePeriod && String(m.period) !== String(currentActivePeriod)) return false;
        if (f.productId && String(m.product_id) !== String(f.productId)) return false;
        if (f.supplierId && String(m.supplier_id) !== String(f.supplierId)) return false;
        if (f.type && m.type !== f.type) return false;
        if (f.reason && (m.reason || '') !== f.reason) return false;
        if (!movementMatchesDate(m, f.dateFrom, f.dateTo)) return false;
        if (!movementMatchesSearch(m, f.search)) return false;
        return true;
    });
}

function updateInvFilterCount(elementId, shown, total) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = total === shown
        ? `${shown} registro${shown === 1 ? '' : 's'}`
        : `${shown} de ${total} registros`;
}

function fillInvFilterSelect(selectId, options, placeholder) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>`;
    options.forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        sel.appendChild(opt);
    });
    if (current && [...sel.options].some(o => o.value === current)) sel.value = current;
}

function populateInvFilterSelects() {
    const productOptions = inventory
        .filter(p => p.status !== 'Inactivo')
        .map(p => ({ value: String(p.id), label: p.name || p.code || String(p.id) }))
        .sort((a, b) => a.label.localeCompare(b.label, 'es'));

    ['ent-filter-product', 'sal-filter-product', 'mov-filter-product'].forEach(id => {
        fillInvFilterSelect(id, productOptions, 'Todos los productos');
    });

    const supplierIds = new Set();
    inventoryMovements.forEach(m => {
        if (m.supplier_id) supplierIds.add(String(m.supplier_id));
    });
    const supplierOptions = suppliers
        .filter(s => supplierIds.has(String(s.id)))
        .map(s => ({ value: String(s.id), label: s.name || s.business_name || String(s.id) }))
        .sort((a, b) => a.label.localeCompare(b.label, 'es'));

    ['ent-filter-supplier', 'mov-filter-supplier'].forEach(id => {
        fillInvFilterSelect(id, supplierOptions, 'Todos los proveedores');
    });

    const salReasons = [...new Set(
        inventoryMovements
            .filter(m => m.type === 'SALIDA' && m.reason !== 'Venta')
            .map(m => m.reason)
            .filter(Boolean)
    )].sort((a, b) => String(a).localeCompare(String(b), 'es'));

    fillInvFilterSelect('sal-filter-reason', salReasons.map(r => ({ value: r, label: r })), 'Todos los tipos');

    const movReasons = [...new Set(inventoryMovements.map(m => m.reason).filter(Boolean))]
        .sort((a, b) => String(a).localeCompare(String(b), 'es'));
    fillInvFilterSelect('mov-filter-reason', movReasons.map(r => ({ value: r, label: r })), 'Todos los motivos');
}

function clearInvFilters(prefix) {
    const ids = [
        `${prefix}-filter-search`,
        `${prefix}-filter-product`,
        `${prefix}-filter-supplier`,
        `${prefix}-filter-type`,
        `${prefix}-filter-reason`,
        `${prefix}-filter-date-from`,
        `${prefix}-filter-date-to`
    ];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.tagName === 'SELECT') el.value = '';
        else el.value = '';
    });
    const periodChk = document.getElementById(`${prefix}-filter-period`);
    if (periodChk) periodChk.checked = false;
    renderInventoryModule();
}

function getSaleFilterState(prefix) {
    return {
        search: (document.getElementById(`${prefix}-filter-search`)?.value || '').trim().toLowerCase(),
        productId: document.getElementById(`${prefix}-filter-product`)?.value || '',
        clientId: document.getElementById(`${prefix}-filter-client`)?.value || '',
        payment: document.getElementById(`${prefix}-filter-payment`)?.value || '',
        dateFrom: document.getElementById(`${prefix}-filter-date-from`)?.value || '',
        dateTo: document.getElementById(`${prefix}-filter-date-to`)?.value || '',
        periodOnly: !!document.getElementById(`${prefix}-filter-period`)?.checked
    };
}

function saleMatchesDate(s, dateFrom, dateTo) {
    const d = String(s.date || '').slice(0, 10);
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
}

function saleMatchesSearch(s, search, clientName) {
    if (!search) return true;
    const haystack = [
        s.product_name,
        clientName,
        s.payment_method,
        s.observation
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(search);
}

function applySaleFilters(list, prefix) {
    const f = getSaleFilterState(prefix);
    return list.filter(s => {
        if (f.periodOnly && currentActivePeriod && getSalePeriod(s) !== currentActivePeriod) return false;
        if (f.productId && String(s.product_id) !== String(f.productId)) return false;
        if (f.clientId && String(s.client) !== String(f.clientId)) return false;
        if (f.payment && (s.payment_method || '') !== f.payment) return false;
        if (!saleMatchesDate(s, f.dateFrom, f.dateTo)) return false;
        const c = clients.find(cli => String(cli.id) === String(s.client));
        const clientName = c ? c.name : s.client;
        if (!saleMatchesSearch(s, f.search, clientName)) return false;
        return true;
    });
}

function populateSaleFilterSelects() {
    const productMap = new Map();
    sales.forEach(s => {
        const key = String(s.product_id || s.product_name || '');
        if (!key) return;
        productMap.set(key, s.product_name || key);
    });
    inventory.filter(p => p.status !== 'Inactivo').forEach(p => {
        productMap.set(String(p.id), p.name || p.code || String(p.id));
    });
    const productOptions = [...productMap.entries()]
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label, 'es'));
    fillInvFilterSelect('ven-filter-product', productOptions, 'Todos los productos');

    const clientIds = new Set(sales.map(s => String(s.client)).filter(Boolean));
    const clientOptions = clients
        .filter(c => clientIds.has(String(c.id)))
        .map(c => ({ value: String(c.id), label: c.name || String(c.id) }))
        .sort((a, b) => a.label.localeCompare(b.label, 'es'));
    fillInvFilterSelect('ven-filter-client', clientOptions, 'Todos los clientes');

    const payments = [...new Set(sales.map(s => s.payment_method).filter(Boolean))]
        .sort((a, b) => String(a).localeCompare(String(b), 'es'));
    fillInvFilterSelect('ven-filter-payment', payments.map(p => ({ value: p, label: p })), 'Todos los pagos');
}

function clearSaleFilters(prefix) {
    const ids = [
        `${prefix}-filter-search`,
        `${prefix}-filter-product`,
        `${prefix}-filter-client`,
        `${prefix}-filter-payment`,
        `${prefix}-filter-date-from`,
        `${prefix}-filter-date-to`
    ];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = '';
    });
    const periodChk = document.getElementById(`${prefix}-filter-period`);
    if (periodChk) periodChk.checked = false;
    renderSales();
}

const getMonthName = (yyyy_mm) => {
    try {
        if(!yyyy_mm || typeof yyyy_mm !== 'string' || !yyyy_mm.includes('-')) return yyyy_mm || '';
        const [year, month] = yyy_mm.split('-');
        const date = new Date(parseInt(year), parseInt(month) - 1, 1);
        const monthName = date.toLocaleString('es-ES', { month: 'long' });
        return monthName.charAt(0).toUpperCase() + monthName.slice(1) + ' ' + year;
    } catch(e) {
        return yyyy_mm;
    }
};

// Helper to get current period (YYYY-MM)
const getCurrentPeriod = () => {
    const d = new Date();
    return d.toISOString().slice(0,7);
};

// Save periods to localStorage
function savePeriodsToLocal() {
    localStorage.setItem('lm_periods', JSON.stringify(periods));
}

// Load periods from backend or fallback to localStorage
async function loadPeriods() {
    try {
        const res = await fetch('/api/periods');
        if (!res.ok) throw new Error('Backend error');
        const data = await res.json();
        periods = (Array.isArray(data) ? data : []).filter(p => p && p.month);
        savePeriodsToLocal();
    } catch (e) {
        console.log('Using localStorage for periods');
        try {
            const localData = localStorage.getItem('lm_periods');
            const parsed = localData ? JSON.parse(localData) : [];
            periods = (Array.isArray(parsed) ? parsed : []).filter(p => p && p.month);
        } catch(err) {
            periods = [];
        }
    }
    
    // Auto-create current period if completely empty (fallback)
    if (periods.length === 0) {
        periods.push({ month: getCurrentPeriod(), status: 'ABIERTO' });
        savePeriodsToLocal();
    }

    // Ensure current period is active
    currentActivePeriod = getCurrentPeriod();

    updatePeriodBadge();
    renderPeriods();
}

// Render periods table
function renderPeriods() {
    const tbody = document.querySelector('#periods-table tbody');
    tbody.innerHTML = '';
    
    updateGlobalPeriodDropdown();

    const sortedPeriods = [...periods]
        .filter(p => p && p.month)
        .sort((a, b) => String(b.month).localeCompare(String(a.month)));

    sortedPeriods.forEach(p => {
        const tr = document.createElement('tr');
        
        let actionBtn = '';
        if (p.status === 'ABIERTO') {
            actionBtn = `<button class="btn btn-success btn-small" onclick="closePeriod(${htmlJsArg(p.month)})"><i class="fas fa-lock"></i> Cerrar</button>`;
        } else {
            actionBtn = `<button class="btn btn-danger btn-small" onclick="openPeriod(${htmlJsArg(p.month)})"><i class="fas fa-lock-open"></i> Reabrir</button>`;
        }
        actionBtn += ` <button class="btn btn-danger btn-small" onclick="deletePeriod(${htmlJsArg(p.month)})" style="margin-left: 5px;"><i class="fas fa-trash"></i> Eliminar</button>`;

        tr.innerHTML = `<td>${escapeHtml(p.month)}</td><td>${escapeHtml(p.status)}</td><td>${actionBtn}</td>`;
        tbody.appendChild(tr);
    });
}

// Update badge in dashboard header
function updatePeriodBadge() {
    const badge = document.getElementById('period-badge');
    if (!badge) return;
    const current = periods.find(p => p.month === getCurrentPeriod());
    const status = current ? current.status : 'ABIERTO';
    badge.textContent = status;
    badge.className = 'badge';
    if (status === 'ABIERTO') {
        badge.style.background = 'var(--success)';
        badge.style.color = '#fff';
    } else {
        badge.style.background = 'var(--danger)';
        badge.style.color = '#fff';
    }
}

function updateGlobalPeriodDropdown() {
    try {
        const select = document.getElementById('global-period-select');
        if(!select) return;
        
        select.innerHTML = '';
        const validPeriods = (Array.isArray(periods) ? periods : [])
            .filter(p => p && p.month); 
        
        // Filtramos para mostrar Ãºnicamente los perÃ­odos ABIERTOS
        const openPeriods = validPeriods.filter(p => p.status === 'ABIERTO');
        const sorted = [...openPeriods].sort((a,b) => String(b.month).localeCompare(String(a.month)));
        
        if (sorted.length === 0) {
            select.innerHTML = '<option value="">Sin perÃ­odos abiertos</option>';
            currentActivePeriod = '';
        } else {
            sorted.forEach(p => {
                const option = document.createElement('option');
                option.value = p.month;
                option.textContent = p.month;
                select.appendChild(option);
            });

            // Si el perÃ­odo activo ya no estÃ¡ en la lista (se cerrÃ³), seleccionamos el mÃ¡s reciente
            if(!currentActivePeriod || !sorted.find(p => p.month === currentActivePeriod)) {
                currentActivePeriod = sorted[0].month;
            }
        }
        
        if(currentActivePeriod) {
            select.value = currentActivePeriod;
        }
        updatePeriodBadge();
    } catch (err) {
        console.error("Error updating dropdown:", err);
    }
}

async function changeActivePeriod() {
    const select = document.getElementById('global-period-select');
    currentActivePeriod = select.value;
    updatePeriodBadge();
    // Auto-populate opening balance from previous month if not already set
    await autoPopulateOpeningBalanceFromPreviousMonth();
    await updateDashboard();
    renderInventoryModule();
    renderSales();
    renderExpensesModule();
    loadAccountingReport();
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Navigation
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            
            const targetId = e.currentTarget.dataset.target;
            document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
            document.getElementById(targetId).classList.add('active');
            
            if (targetId === 'dashboard' || targetId === 'sales') updateDashboard();
            if (targetId === 'inventory') renderInventoryModule();
            if (targetId === 'expenses') renderExpensesModule();
            if (targetId === 'accounting-report') loadAccountingReport();
        });
    });

    // Inventory Tabs
    document.querySelectorAll('.inv-tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.inv-tab').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            const targetId = e.currentTarget.dataset.target;
            document.querySelectorAll('.inv-section').forEach(sec => sec.classList.remove('active'));
            document.getElementById(targetId).classList.add('active');
        });
    });

    // Sale Tabs
    document.querySelectorAll('.sale-tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.sale-tab').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            const targetId = e.currentTarget.dataset.target;
            document.querySelectorAll('.sale-section').forEach(sec => sec.classList.remove('active'));
            document.getElementById(targetId).classList.add('active');
        });
    });

    document.querySelectorAll('.exp-tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.exp-tab').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            const targetId = e.currentTarget.dataset.target;
            document.querySelectorAll('.exp-section').forEach(sec => sec.classList.remove('active'));
            document.getElementById(targetId).classList.add('active');
            // Persist last active expenses tab
            try { localStorage.setItem('lm_exp_active_tab', targetId); } catch (err) {}
            if (targetId === 'exp-suppliers') renderSuppliers();
            if (targetId === 'exp-records') renderExpenses();
        });
    });

    // Restore last active expenses tab (if any)
    (function restoreExpensesTab(){
        try {
            const saved = localStorage.getItem('lm_exp_active_tab');
            if (!saved) return;
            const btn = document.querySelector(`.exp-tab[data-target="${saved}"]`);
            if (btn) {
                // activate visual tab
                document.querySelectorAll('.exp-tab').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                // show section
                document.querySelectorAll('.exp-section').forEach(sec => sec.classList.remove('active'));
                const sec = document.getElementById(saved);
                if (sec) sec.classList.add('active');
                if (saved === 'exp-suppliers') renderSuppliers();
                if (saved === 'exp-records') renderExpenses();
            }
        } catch (e) { /* ignore */ }
    })();

    // Close Modals on outside click
    window.onclick = function(event) {
        if (event.target.classList.contains('modal')) {
            event.target.style.display = "none";
        }
    }

    loadData();
    loadPeriods();
});

async function refreshAllModules() {
    try { await loadData(true); } catch (error) {
        error.saved = true;
        throw error;
    }
}

// Load Data
async function loadData(strict = false) {
    try {
        const invRes = await fetch('/api/inventory');
        if (invRes.ok) {
            inventory = await invRes.json();
            const invMovRes = await fetch('/api/inventory_movements');
            if (!invMovRes.ok) throw new Error('Error al cargar movimientos');
            if(invMovRes.ok) inventoryMovements = sortByDateDesc(await invMovRes.json());
            
            const salesRes = await fetch('/api/sales');
            if (!salesRes.ok) throw new Error('Error al cargar ventas');
            let salesRaw = await salesRes.json();
            // Ensure each sale has a total field for dashboard calculations
            sales = sortByDateDesc(salesRaw.map(s => {
                const parsedTotal = Number(s.total);
                if (!isNaN(parsedTotal) && parsedTotal > 0) {
                    return { ...s, total: parsedTotal, quantity: Number(s.quantity) || s.quantity, price: Number(s.price) || s.price };
                }
                const computed = (s.items?.reduce((a, i) => a + (Number(i.total) || 0), 0)) || (Number(s.price) || 0) * (Number(s.quantity) || 0);
                return { ...s, total: computed, quantity: Number(s.quantity) || s.quantity, price: Number(s.price) || s.price };
            }));
            const expRes = await fetch('/api/expenses');
            if (!expRes.ok) throw new Error('Error al cargar gastos');
            expenses = sortByDateDesc(await expRes.json());
            const suppRes = await fetch('/api/suppliers');
            if (!suppRes.ok) throw new Error('Error al cargar proveedores');
            if(suppRes.ok) suppliers = await suppRes.json();
            const cliRes = await fetch('/api/clients');
            if (!cliRes.ok) throw new Error('Error al cargar clientes');
            if(cliRes.ok) clients = await cliRes.json();
        } else {
            throw new Error("Backend not available");
        }
    } catch (e) {
        if (strict) throw new Error('No se pudo recargar la información del servidor: ' + e.message);
        console.log("Using localStorage fallback");
        try {
            inventory = JSON.parse(localStorage.getItem('lm_inventory')) || [];
            inventoryMovements = sortByDateDesc(JSON.parse(localStorage.getItem('lm_inventory_movements')) || []);
            sales = sortByDateDesc(JSON.parse(localStorage.getItem('lm_sales')) || []);
            expenses = sortByDateDesc(JSON.parse(localStorage.getItem('lm_expenses')) || []);
            suppliers = JSON.parse(localStorage.getItem('lm_suppliers')) || [];
            clients = JSON.parse(localStorage.getItem('lm_clients')) || [];
        } catch(err) {
            inventory = [];
            inventoryMovements = [];
            sales = [];
            expenses = [];
            suppliers = [];
            clients = [];
        }
    }
    
    await loadOpeningCash();
    renderInventoryModule();
    renderSales();
    renderExpensesModule();
    renderClients();
    updateDashboard();
}

function renderExpensesModule() {
    renderExpenses();
    renderSuppliers();
}

function saveDataToLocal() {
    localStorage.setItem('lm_inventory', JSON.stringify(inventory));
    localStorage.setItem('lm_inventory_movements', JSON.stringify(inventoryMovements));
    localStorage.setItem('lm_sales', JSON.stringify(sales));
    localStorage.setItem('lm_expenses', JSON.stringify(expenses));
    localStorage.setItem('lm_suppliers', JSON.stringify(suppliers));
    localStorage.setItem('lm_clients', JSON.stringify(clients));
}

// Modals
function openModal(id, contextType) {
    const isClosed = isPeriodClosed(currentActivePeriod);
    if(isClosed && ['sales-modal', 'expenses-modal', 'inventory-modal', 'entrada-modal', 'salida-modal', 'client-modal', 'supplier-modal'].includes(id)) {
        if (!(id === 'sales-modal' && editingSaleId) && !(id === 'expenses-modal' && editingExpenseId)) {
            alert(`El período de ${getMonthName(currentActivePeriod)} está CERRADO. No se pueden registrar o modificar datos en este período.`);
            return;
        }
    }

    if (id === 'expenses-modal' && !editingExpenseId) {
        populateExpenseSuppliers();
        const dateEl = document.getElementById('exp-date');
        if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);
        updateExpenseClassPreview();
    }

    if(id === 'sales-modal') {
        if (!editingSaleId) {
            currentSaleItems = [];
            renderSaleItems();
            populateSalesProducts();
            setSalesModalEditMode(false);
            const form = document.getElementById('sales-form');
            if (form) form.reset();
            const saleDate = document.getElementById('sale-date');
            if (saleDate) saleDate.valueAsDate = new Date();
        }
        populateClients('sale-client');
    }
    if (id === 'salida-modal') {
        populateInventoryProducts('sal-product');
    }
    if (id === 'supplier-modal') {
        // Reset modal if it's for creation
        const suppId = document.getElementById('supp-id').value;
        if (!suppId) {
            document.getElementById('supplier-modal-title').innerText = "Registrar Proveedor";
            document.getElementById('supplier-form').reset();
            document.getElementById('supp-type').value = contextType || 'inventory';
        }
    }
    if (id === 'client-modal') {
        const cliId = document.getElementById('cli-id').value;
        if (!cliId) {
            document.getElementById('client-modal-title').innerText = "Registrar Cliente";
            document.getElementById('client-form').reset();
        }
    }
    document.getElementById(id).style.display = 'block';
}

function closeModal(id) {
    document.getElementById(id).style.display = 'none';
    if (id === 'sales-modal') {
        editingSaleId = null;
        setSalesModalEditMode(false);
    }
    if (id === 'entrada-modal') {
        editingInvoice = null;
        setEntradaModalEditMode(false);
        resetEntradaInvoicePdf();
    }
    if (id === 'expenses-modal') {
        editingExpenseId = null;
        editingExpenseBatchId = null;
        currentExpenseItems = [];
    }
}

function invoiceGroupKey(m) {
    return `${m.supplier_id || ''}|${m.invoice_number || ''}|${m.date || ''}`;
}

function getInvoiceMovements(supplierId, invoiceNumber, date) {
    return inventoryMovements.filter(m =>
        m.type === 'ENTRADA' &&
        m.reason === 'Compra' &&
        String(m.supplier_id) === String(supplierId) &&
        String(m.invoice_number) === String(invoiceNumber) &&
        String(m.date) === String(date)
    );
}

function setEntradaModalEditMode(isEdit) {
    const title = document.getElementById('entrada-modal-title');
    const subtitle = document.getElementById('entrada-modal-subtitle');
    const submitLabel = document.getElementById('entrada-submit-label');
    if (title) {
        title.textContent = isEdit
            ? 'Editar Compra de Mercancía (Factura)'
            : 'Registrar Compra de Mercancía (Factura)';
    }
    if (subtitle) {
        subtitle.textContent = isEdit
            ? 'Modifique proveedor, productos, totales o PDF. El inventario se recalcula al guardar.'
            : 'Esta factura aumentará el inventario de los productos seleccionados.';
    }
    if (submitLabel) {
        submitLabel.textContent = isEdit
            ? 'Guardar cambios de la factura'
            : 'Finalizar y Guardar Factura';
    }
}

function resetEntradaForm() {
    editingInvoice = null;
    currentInvoiceItems = [];
    const form = document.getElementById('entrada-form');
    if (form) form.reset();
    resetEntradaInvoicePdf();
    setEntradaModalEditMode(false);
    renderInvoiceItems();
}

function openEntradaModalForCreate() {
    if (isPeriodClosed(currentActivePeriod)) {
        alert(`El período de ${getMonthName(currentActivePeriod)} está CERRADO. No se pueden registrar compras en este período.`);
        return;
    }
    resetEntradaForm();
    populateInventoryProducts('ent-product-select');
    populateSuppliers('ent-supplier', 'inventory');
    document.getElementById('ent-date').valueAsDate = new Date();
    document.getElementById('entrada-modal').style.display = 'block';
}

function editPurchaseInvoice(supplierId, invoiceNumber, date) {
    const lines = getInvoiceMovements(supplierId, invoiceNumber, date);
    if (!lines.length) return alert('No se encontró la factura.');
    if (isPeriodClosed(lines[0].period)) {
        return alert('El período de esta factura está cerrado. No se puede editar.');
    }
    if (lines[0].period !== currentActivePeriod) {
        return alert(`Seleccione el período ${lines[0].period} en el menú superior para editar esta factura.`);
    }

    editingInvoice = {
        old_supplier_id: supplierId,
        old_invoice_number: invoiceNumber,
        old_date: date
    };

    populateInventoryProducts('ent-product-select');
    document.getElementById('ent-supplier').innerHTML = '';
    suppliers.filter(s => s.status === 'Activo' || String(s.id) === String(supplierId)).forEach(s => {
        const option = document.createElement('option'); option.value = s.id; option.textContent = s.name;
        document.getElementById('ent-supplier').appendChild(option);
    });

    document.getElementById('ent-date').value = date;
    document.getElementById('ent-supplier').value = String(supplierId);
    document.getElementById('ent-invoice').value = invoiceNumber;
    document.getElementById('ent-obs').value = lines[0].observation || '';

    const pdfLabel = document.getElementById('ent-invoice-pdf-name');
    const pdfInput = document.getElementById('ent-invoice-pdf');
    if (pdfInput) pdfInput.value = '';
    const hasPdf = lines.some(l => l.invoice_file);
    if (pdfLabel) {
        pdfLabel.textContent = hasPdf
            ? 'PDF guardado. Elija otro archivo solo si desea reemplazarlo.'
            : 'Opcional. Máx. 8 MB.';
    }

    currentInvoiceItems = lines.map(m => {
        const product = inventory.find(i => String(i.id) === String(m.product_id));
        const subtotal = Number(m.quantity) * Number(m.unit_cost);
        const ivaAmount = Number(m.iva_amount) || 0;
        const ivaPercent = Number(m.iva_percent) || (subtotal > 0 ? (ivaAmount / subtotal) * 100 : 0);
        return {
            product_id: m.product_id,
            product_name: product ? product.name : m.product_id,
            quantity: m.quantity,
            unit_cost: m.unit_cost,
            iva_percent: ivaPercent,
            iva_amount: ivaAmount,
            subtotal,
            total: m.total
        };
    });

    setEntradaModalEditMode(true);
    renderInvoiceItems();
    document.getElementById('entrada-modal').style.display = 'block';
}

function resetEntradaInvoicePdf() {
    const input = document.getElementById('ent-invoice-pdf');
    const label = document.getElementById('ent-invoice-pdf-name');
    if (input) input.value = '';
    if (label) label.textContent = 'Opcional. Máximo 8 MB.';
}

async function onEntradaPdfSelected(e) {
    const label = document.getElementById('ent-invoice-pdf-name');
    const file = e.target.files && e.target.files[0];
    if (!file) {
        if (label) label.textContent = 'Opcional. Máximo 8 MB.';
        return;
    }
    try {
        await readEntradaInvoicePdf(file);
    } catch (err) {
        alert(err.message);
        resetEntradaInvoicePdf();
    }
}

function readInvoicePdfFile(file, labelEl, emptyText) {
    if (!file) return Promise.resolve(null);
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) return Promise.reject(new Error('Solo se permiten archivos PDF.'));
    const maxMb = 8;
    if (file.size > maxMb * 1024 * 1024) {
        return Promise.reject(new Error(`El PDF no puede superar ${maxMb} MB.`));
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            if (labelEl) labelEl.textContent = `Archivo seleccionado: ${file.name}`;
            resolve(reader.result);
        };
        reader.onerror = () => reject(new Error('No se pudo leer el archivo PDF.'));
        reader.readAsDataURL(file);
    });
}

function readEntradaInvoicePdf(file) {
    const label = document.getElementById('ent-invoice-pdf-name');
    return readInvoicePdfFile(file, label);
}

function onSaleDianPdfSelected(e) {
    const label = document.getElementById('sale-dian-pdf-name');
    const file = e.target.files?.[0];
    if (!file) {
        if (label) label.textContent = 'Opcional. Máx. 8 MB.';
        return;
    }
    readInvoicePdfFile(file, label).catch(err => {
        e.target.value = '';
        if (label) label.textContent = 'Opcional. Máx. 8 MB.';
        alert(err.message);
    });
}

function getSaleBatchLines(sale) {
    if (sale?.sale_batch_id) {
        return sales.filter(s => String(s.sale_batch_id) === String(sale.sale_batch_id));
    }
    return sale ? [sale] : [];
}

function saleBatchKey(sale) {
    return sale.sale_batch_id ? String(sale.sale_batch_id) : `single-${sale.id}`;
}

function resetSaleFormExtras() {
    const invInput = document.getElementById('sale-invoice-number');
    const pdfInput = document.getElementById('sale-dian-pdf');
    const pdfName = document.getElementById('sale-dian-pdf-name');
    if (invInput) invInput.value = '';
    const observation = document.getElementById('sale-obs');
    const retention = document.getElementById('sale-retentions');
    if (observation) observation.value = '';
    if (retention) retention.value = 0;
    if (pdfInput) pdfInput.value = '';
    if (pdfName) pdfName.textContent = 'Opcional. Máx. 8 MB.';
}

function downloadDianInvoiceForSale(id) {
    const sale = sales.find(s => String(s.id) === String(id));
    if (!sale || !sale.dian_invoice_file) return alert('No hay factura DIAN guardada para esta venta.');

    if (sale.dian_invoice_file.startsWith('data:')) {
        try {
            const link = document.createElement('a');
            link.href = sale.dian_invoice_file;
            link.download = `Factura_DIAN_${sale.sale_invoice_number || sale.sale_batch_id || sale.id}.pdf`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (err) {
            alert('Error al descargar la factura DIAN: ' + err.message);
        }
        return;
    }

    window.open(`/api/sales/${id}/dian-invoice-file`, '_blank');
}

function recalcSaleItemLine(item) {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.price) || 0;
    const ivaPercent = Number(item.iva_percent) || 0;
    item.subtotal = qty * price;
    item.iva_amount = item.subtotal * (ivaPercent / 100);
    item.total = item.subtotal + item.iva_amount;
}

function updateEditingSaleItem(idx, field, value) {
    const item = currentSaleItems[idx];
    if (!item) return;
    if (field === 'quantity') {
        item.quantity = Math.max(1, parseInt(value, 10) || 1);
    } else if (field === 'price') {
        item.price = Math.max(0, parseFloat(value) || 0);
    } else if (field === 'iva_percent') {
        item.iva_percent = Math.max(0, parseFloat(value) || 0);
    }
    recalcSaleItemLine(item);
    renderSaleItems();
}

function setSalesModalEditMode(isEdit) {
    const addSection = document.getElementById('sale-add-products-section');
    if (addSection) addSection.style.display = isEdit ? 'none' : '';
    const title = document.getElementById('sales-modal-title');
    const subtitle = document.getElementById('sales-modal-subtitle');
    const submitLabel = document.getElementById('sales-submit-label');
    if (title) title.textContent = isEdit ? 'Editar Venta' : 'Registrar Venta';
    if (subtitle) {
        subtitle.textContent = isEdit
            ? 'Modifique cliente, pago o cantidades. El inventario se recalcula al guardar.'
            : 'Agregue los productos vendidos. El inventario se actualizará al guardar.';
    }
    if (submitLabel) {
        submitLabel.textContent = isEdit ? 'Guardar cambios de la venta' : 'Finalizar y Guardar Venta';
    }
}

function openSalesModalForCreate() {
    if (isPeriodClosed(currentActivePeriod)) {
        alert(`El período de ${getMonthName(currentActivePeriod)} está CERRADO. No se pueden registrar ventas en este período.`);
        return;
    }
    editingSaleId = null;
    currentSaleItems = [];
    setSalesModalEditMode(false);
    const form = document.getElementById('sales-form');
    if (form) form.reset();
    resetSaleFormExtras();
    populateSalesProducts();
    populateClients('sale-client');
    const saleDate = document.getElementById('sale-date');
    if (saleDate) saleDate.valueAsDate = new Date();
    onSaleClientChange();
    renderSaleItems();
    document.getElementById('sales-modal').style.display = 'block';
}

// Inventario Reutilizable
function calculateStock(productId, upToPeriod) {
    let stock = 0;
    const movements = inventoryMovements.filter(m => String(m.product_id) === String(productId) && String(m.period) <= String(upToPeriod));
    for(let m of movements) {
        const qty = Number(m.quantity) || 0;
        if(m.type === 'ENTRADA') stock += qty;
        else if(m.type === 'SALIDA') stock -= qty;
    }
    return stock;
}

function getWeightedAverageCost(productId, upToPeriod) {
    let totalQuantity = 0;
    let totalCost = 0;
    const movements = inventoryMovements.filter(m => 
        String(m.product_id) === String(productId) && 
        String(m.period) <= String(upToPeriod) &&
        m.type === 'ENTRADA'
    );
    if (movements.length === 0) return 0;
    movements.forEach(m => {
        totalQuantity += m.quantity;
        totalCost += (m.quantity * m.unit_cost);
    });
    return totalQuantity > 0 ? (totalCost / totalQuantity) : 0;
}

function isPeriodClosed(month) {
    const p = periods.find(p => p.month === month);
    return p ? p.status === 'CERRADO' : true;
}

async function registrarMovimientoInventario({ periodo, fecha, productoId, tipo, motivo, cantidad, costoUnitario, observacion, supplier_id, supplier_name, invoice_number, iva_percent, iva_amount }) {
    if (isPeriodClosed(periodo)) throw new Error('El período seleccionado está cerrado.');
    if (cantidad <= 0) throw new Error('La cantidad debe ser mayor a cero.');
    
    const producto = inventory.find(i => String(i.id) === String(productoId));
    if (!producto) throw new Error('Producto no encontrado.');

    if (tipo === 'SALIDA') {
        const currentStock = calculateStock(productoId, periodo);
        if (currentStock < cantidad) throw new Error(`Stock insuficiente. Stock actual: ${currentStock}`);
    }

    const subtotal = cantidad * costoUnitario;
    const final_iva = iva_amount || 0;

    const newMov = {
        period: periodo,
        date: fecha,
        product_id: productoId,
        type: tipo,
        reason: motivo,
        quantity: cantidad,
        unit_cost: costoUnitario,
        total: subtotal + final_iva,
        observation: observacion || '',
        supplier_id: supplier_id || null,
        supplier_name: supplier_name || '',
        invoice_number: invoice_number || '',
        iva_percent: iva_percent || 0,
        iva_amount: final_iva,

    };

    try {
        const res = await fetch('/api/inventory_movements', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newMov)
        });
        if(res.ok) {
            const data = await res.json();
            newMov.id = data.id;
            return newMov;
        } else {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || 'Error al registrar el movimiento.');
        }
    } catch(e) {
        throw new Error('No se guardó el movimiento en la base de datos: ' + e.message);
    }
}

// Render Functions
function renderInventoryModule() {
    if(!currentActivePeriod) return;
    const isClosed = isPeriodClosed(currentActivePeriod);

    populateInvFilterSelects();
    renderInventoryProducts();
    renderInventoryEntradas();
    renderInventorySalidas();
    renderInventoryMovimientos();
    renderSuppliers();
    updateInventorySummary();

    // Deshabilitar botones DESPUÉS de renderizar las tablas para cubrir los botones dinámicos
    document.querySelectorAll('.btn-period-dependent').forEach(btn => {
        btn.disabled = isClosed;
        btn.style.opacity = isClosed ? 0.5 : 1;
        btn.style.cursor = isClosed ? 'not-allowed' : 'pointer';
    });

    // Mostrar/ocultar aviso de período cerrado
    const warning = document.getElementById('inventory-period-warning');
    if(warning) warning.style.display = isClosed ? 'block' : 'none';
}

function updateInventorySummary() {
    const productsList = inventory.filter(p => p.status !== 'Inactivo');
    let totalCostValue = 0;
    let totalStock = 0;
    let lowStockCount = 0;

    productsList.forEach(p => {
        const stock = calculateStock(p.id, currentActivePeriod);
        const avgCost = getWeightedAverageCost(p.id, currentActivePeriod);
        if(stock > 0) {
            totalCostValue += (avgCost * stock);
            totalStock += stock;
        }
        if(stock <= p.min_stock) lowStockCount++;
    });

    document.getElementById('inv-total-products').innerText = productsList.length;
    document.getElementById('inv-total-cost').innerText = currencyFormatter.format(totalCostValue);
    document.getElementById('inv-total-stock').innerText = totalStock;
    document.getElementById('inv-low-stock').innerText = lowStockCount;
}

function renderInventoryProducts() {
    const tbody = document.querySelector('#inventory-table tbody');
    if(!tbody) return;
    tbody.innerHTML = '';
    inventory.forEach((item, idx) => {
        const currentStock = calculateStock(item.id || idx, currentActivePeriod);
        const tr = document.createElement('tr');
        const isLowStock = currentStock <= item.min_stock;
        const stockStatus = currentStock === 0 ? 'Sin stock' : (isLowStock ? 'Bajo' : 'Normal');
        const statusClass = item.status === 'Activo' ? 'success' : 'danger';
        tr.innerHTML = `
            <td>${escapeHtml(item.code || '')}</td>
            <td>${escapeHtml(item.name)}</td>
            <td>${escapeHtml(item.category || '')}</td>
            <td>${escapeHtml(currentStock)}</td>
            <td>${escapeHtml(item.min_stock || 0)}</td>
            <td><span class="badge" style="background: ${escapeHtml(stockStatus==='Normal'?'var(--success)':(stockStatus==='Bajo'?'var(--warning)':'var(--danger)'))}">${escapeHtml(stockStatus)}</span></td>
            <td style="color: var(--${escapeHtml(statusClass)}); font-weight: bold;">${escapeHtml(item.status || 'Activo')}</td>
            <td>
                <button class="btn btn-primary btn-small btn-period-dependent" onclick="editInventory(${Number(item.id || idx)})"><i class="fas fa-edit"></i></button>
                <button class="btn btn-danger btn-small btn-period-dependent" onclick="deleteProduct(${Number(item.id || idx)})"><i class="fas fa-trash"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function downloadInvoiceForMovement(id) {
    const m = inventoryMovements.find(x => String(x.id) === String(id));
    if (!m || !m.invoice_file) return alert("No hay factura digital guardada para esta entrada.");

    if (m.invoice_file.startsWith('data:')) {
        try {
            const link = document.createElement('a');
            link.href = m.invoice_file;
            link.download = `Factura_${m.invoice_number || m.id}.pdf`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (err) {
            alert("Error al descargar la factura: " + err.message);
        }
        return;
    }

    window.open(`/api/inventory_movements/${id}/invoice-file`, '_blank');
}

function renderInventoryEntradas() {
    const tbody = document.querySelector('#entradas-table tbody');
    if(!tbody) return;
    tbody.innerHTML = '';
    const baseMovs = inventoryMovements.filter(m => m.type === 'ENTRADA');
    const movs = sortByDateDesc(applyInvMovementFilters(baseMovs, 'ent'));
    updateInvFilterCount('entradas-filter-count', movs.length, baseMovs.length);
    const editShownForInvoice = new Set();

    if (movs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#64748b;padding:1.5rem;">No hay entradas que coincidan con los filtros.</td></tr>';
        return;
    }

    movs.forEach(m => {
        const prod = inventory.find(i => String(i.id) === String(m.product_id));
        const tr = document.createElement('tr');
        const periodClosed = isPeriodClosed(m.period);
        const disabledAttr = periodClosed ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '';

        const isPurchaseInvoice = m.reason === 'Compra' && m.invoice_number && m.supplier_id;
        const groupKey = invoiceGroupKey(m);
        const showInvoiceActions = isPurchaseInvoice && !editShownForInvoice.has(groupKey);
        if (showInvoiceActions) editShownForInvoice.add(groupKey);

        const downloadBtn = m.invoice_file
            ? `<button class="btn btn-small" style="background: #10b981; color: white;" onclick="downloadInvoiceForMovement(${Number(m.id)})" title="Descargar factura PDF"><i class="fas fa-file-download"></i></button>`
            : '';

        const editBtn = showInvoiceActions
            ? `<button class="btn btn-primary btn-small" onclick='editPurchaseInvoice(${escapeHtml(JSON.stringify(String(m.supplier_id)))}, ${escapeHtml(JSON.stringify(String(m.invoice_number)))}, ${escapeHtml(JSON.stringify(String(m.date)))})' ${disabledAttr} title="Editar factura completa"><i class="fas fa-edit"></i></button>`
            : '';

        tr.innerHTML = `
            <td>${escapeHtml(m.date)}</td>
            <td>${escapeHtml(prod ? prod.name : m.product_id)}</td>
            <td>${escapeHtml(m.supplier_name || '-')} ${escapeHtml(m.invoice_number ? `(Fact. ${m.invoice_number})` : '')}</td>
            <td style="text-align: center;">${escapeHtml(m.quantity)}</td>
            <td style="text-align: right;">${escapeHtml(currencyFormatter.format(m.unit_cost))}</td>
            <td style="text-align: right; font-weight: bold;">${escapeHtml(currencyFormatter.format(m.total))}</td>
            <td>${escapeHtml(m.observation || '')}</td>
            <td style="text-align: center; display: flex; gap: 0.35rem; justify-content: center; flex-wrap: wrap;">
                ${editBtn}
                ${downloadBtn}
                <button class="btn btn-danger btn-small" onclick="deleteEntrada(${Number(m.id)})" ${disabledAttr} title="Eliminar esta línea"><i class="fas fa-trash"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function renderInventorySalidas() {
    const tbody = document.querySelector('#salidas-table tbody');
    if(!tbody) return;
    tbody.innerHTML = '';
    const baseMovs = inventoryMovements.filter(m => m.type === 'SALIDA' && m.reason !== 'Venta');
    const movs = sortByDateDesc(applyInvMovementFilters(baseMovs, 'sal'));
    updateInvFilterCount('salidas-filter-count', movs.length, baseMovs.length);

    if (movs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#64748b;padding:1.5rem;">No hay salidas o ajustes que coincidan con los filtros.</td></tr>';
        return;
    }

    movs.forEach(m => {
        const prod = inventory.find(i => String(i.id) === String(m.product_id));
        const deleteBtnDisabled = isPeriodClosed(m.period) ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '';
        const editBtnDisabled = isPeriodClosed(m.period) ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(m.date)}</td>
            <td>${escapeHtml(m.reason)}</td>
            <td>${escapeHtml(prod ? prod.name : m.product_id)}</td>
            <td>${escapeHtml(m.quantity)}</td>
            <td>${escapeHtml(m.observation || '')}</td>
            <td style="text-align: center;">
                <button class="btn btn-primary btn-small" onclick="editSalida(${Number(m.id)})" ${editBtnDisabled}>Editar</button>
                <button class="btn btn-danger btn-small" onclick="deleteSalida(${Number(m.id)})" ${deleteBtnDisabled}><i class="fas fa-trash"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function submitMovementEdit(event, prefix, modal) {
    event.preventDefault();
    const id = document.getElementById(prefix + '-id').value;
    const movement = inventoryMovements.find(m => String(m.id) === String(id));
    if (!movement) return alert('Movimiento no encontrado');
    const quantity = Number(document.getElementById(prefix + '-qty').value);
    const date = document.getElementById(prefix + '-date').value;
    const unit_cost = prefix === 'edit-ent' ? Number(document.getElementById(prefix + '-cost').value) : Number(movement.unit_cost) || 0;
    const iva_percent = prefix === 'edit-ent' ? Number(document.getElementById(prefix + '-iva').value) : Number(movement.iva_percent) || 0;
    if (!date || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unit_cost) || unit_cost < 0 || !Number.isFinite(iva_percent) || iva_percent < 0) return alert('Indique fecha, cantidad y valores válidos.');
    const iva_amount = quantity * unit_cost * iva_percent / 100;
    const item = { ...movement, date, quantity, unit_cost, iva_percent, iva_amount, total: quantity * unit_cost + iva_amount,
        observation: document.getElementById(prefix + '-obs').value };
    if (prefix === 'edit-sal') item.reason = document.getElementById(prefix + '-reason').value;
    try {
        await persistRecord('inventory_movements', id, item);
        await refreshAllModules();
        closeModal(modal);
    } catch (error) { alert(error.saved ? 'El cambio se guardó en la base de datos, pero no se pudo actualizar la pantalla. Recargue la aplicación.' : 'No se guardaron los cambios: ' + error.message); }
}

async function handleEditSalidaSubmit(event) { await submitMovementEdit(event, 'edit-sal', 'edit-salida-modal'); }
async function handleEditEntradaSubmit(event) { await submitMovementEdit(event, 'edit-ent', 'edit-entrada-modal'); }

function editSalida(id) {
    const movement = inventoryMovements.find(m => String(m.id) === String(id));
    if (!movement) return alert('Movimiento no encontrado');
    if (isPeriodClosed(movement.period)) return alert('El período está cerrado.');
    if (movement.sale_id || movement.reason === 'Venta') {
        const sale = sales.find(row => String(row.id) === String(movement.sale_id));
        return sale ? editSale(sale.id) : alert('Este movimiento corresponde a una venta. Edítela desde Ventas.');
    }
    document.getElementById('edit-sal-id').value = movement.id;
    document.getElementById('edit-sal-date').value = movement.date;
    document.getElementById('edit-sal-reason').value = movement.reason;
    document.getElementById('edit-sal-qty').value = movement.quantity;
    document.getElementById('edit-sal-obs').value = movement.observation || '';
    openModal('edit-salida-modal');
}

function renderInventoryMovimientos() {
    const tbody = document.querySelector('#movements-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const baseMovs = inventoryMovements.slice();
    const movs = sortByDateDesc(applyInvMovementFilters(baseMovs, 'mov'));
    updateInvFilterCount('movimientos-filter-count', movs.length, baseMovs.length);

    if (movs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#64748b;padding:1.5rem;">No hay movimientos que coincidan con los filtros.</td></tr>';
        return;
    }

    movs.forEach(m => {
        const prod = inventory.find(i => String(i.id) === String(m.product_id));
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(m.date)}</td>
            <td><span style="color: ${escapeHtml(m.type==='ENTRADA'?'var(--success)':'var(--danger)')}; font-weight:bold;">${escapeHtml(m.type)}</span></td>
            <td>${escapeHtml(m.reason || '')}</td>
            <td>${escapeHtml(prod ? prod.name : m.product_id)}</td>
            <td>${escapeHtml(m.supplier_name || '-')}</td>
            <td>${escapeHtml(m.invoice_number || '-')}</td>
            <td>${escapeHtml(m.quantity)}</td>
            <td>${escapeHtml(currencyFormatter.format(m.unit_cost || 0))}</td>
            <td>${escapeHtml(currencyFormatter.format(m.iva_amount || 0))}</td>
            <td style="font-weight:600;">${escapeHtml(currencyFormatter.format(m.total))}</td>
        `;
        tbody.appendChild(tr);
    });
}
/*

    const tbody = document.querySelector('#movements-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const movs = inventoryMovements.slice();
    movs.sort((a,b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
    movs.forEach(m => {
        const prod = inventory.find(i => String(i.id) === String(m.product_id));
        const editBtnDisabled = isPeriodClosed(m.period) ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${m.date}</td>
            <td><span style="color: ${m.type==='ENTRADA'?'var(--success)':'var(--danger)'}; font-weight:bold;">${m.type}</span></td>
            <td>${m.reason}</td>
            <td>${prod ? prod.name : m.product_id}</td>
            <td>${m.supplier_name || '-'}</td>
            <td>${m.invoice_number || '-'}</td>
            <td>${m.quantity}</td>
            <td>${currencyFormatter.format(m.unit_cost || 0)}</td>
            <td>${currencyFormatter.format(m.iva_amount || 0)}</td>
            <td style="font-weight:600;">${currencyFormatter.format(m.total)}</td>
            ${m.type === 'SALIDA' ? `<td style="text-align:center;"><button class="btn btn-primary btn-small" onclick="editSalida(${m.id})" ${editBtnDisabled}>Editar</button></td>` : ''}
        `;
        tbody.appendChild(tr);
    });
}

    const tbody = document.querySelector('#movements-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const movs = inventoryMovements.slice();
    movs.sort((a,b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
    movs.forEach(m => {
        const prod = inventory.find(i => String(i.id) === String(m.product_id));
        const editBtnDisabled = isPeriodClosed(m.period) ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${m.date}</td>
            <td><span style="color: ${m.type==='ENTRADA'?'var(--success)':'var(--danger)'}; font-weight:bold;">${m.type}</span></td>
            <td>${m.reason}</td>
            <td>${prod ? prod.name : m.product_id}</td>
            <td>${m.supplier_name || '-'}</td>
            <td>${m.invoice_number || '-'}</td>
            <td>${m.quantity}</td>
            <td>${currencyFormatter.format(m.unit_cost || 0)}</td>
            <td>${currencyFormatter.format(m.iva_amount || 0)}</td>
            <td style="font-weight:600;">${currencyFormatter.format(m.total)}</td>
            ${m.type === 'SALIDA' ? `<td style="text-align:center;"><button class="btn btn-primary btn-small" onclick="editSalida(${m.id})" ${editBtnDisabled}>Editar</button></td>` : ''}
        `;
        tbody.appendChild(tr);
    });
}

    const tbody = document.querySelector('#movements-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const movs = inventoryMovements.slice();
    movs.sort((a,b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
    movs.forEach(m => {
        const prod = inventory.find(i => String(i.id) === String(m.product_id));
        const editBtnDisabled = isPeriodClosed(m.period) ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${m.date}</td>
            <td><span style="color: ${m.type==='ENTRADA'?'var(--success)':'var(--danger)'}; font-weight:bold;">${m.type}</span></td>
            <td>${m.reason}</td>
            <td>${prod ? prod.name : m.product_id}</td>
            <td>${m.supplier_name || '-'}</td>
            <td>${m.invoice_number || '-'}</td>
            <td>${m.quantity}</td>
            <td>${currencyFormatter.format(m.unit_cost || 0)}</td>
            <td>${currencyFormatter.format(m.iva_amount || 0)}</td>
            <td style="font-weight:600;">${currencyFormatter.format(m.total)}</td>
            ${m.type === 'SALIDA' ? `<td style="text-align:center;"><button class="btn btn-primary btn-small" onclick="editSalida(${m.id})" ${editBtnDisabled}>Editar</button></td>` : ''}
        `;
        tbody.appendChild(tr);
    });
}

    const tbody = document.querySelector('#movements-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const movs = inventoryMovements.slice();
    movs.sort((a,b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
    movs.forEach(m => {
        const prod = inventory.find(i => String(i.id) === String(m.product_id));
        const editBtnDisabled = isPeriodClosed(m.period) ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${m.date}</td>
            <td><span style="color: ${m.type==='ENTRADA'?'var(--success)':'var(--danger)'}; font-weight:bold;">${m.type}</span></td>
            <td>${m.reason}</td>
            <td>${prod ? prod.name : m.product_id}</td>
            <td>${m.supplier_name || '-'}</td>
            <td>${m.invoice_number || '-'}</td>
            <td>${m.quantity}</td>
            <td>${currencyFormatter.format(m.unit_cost || 0)}</td>
            <td>${currencyFormatter.format(m.iva_amount || 0)}</td>
            <td style="font-weight:600;">${currencyFormatter.format(m.total)}</td>
            ${m.type === 'SALIDA' ? `<td style="text-align:center;"><button class="btn btn-primary btn-small" onclick="editSalida(${m.id})" ${editBtnDisabled}>Editar</button></td>` : ''}
        `;
        tbody.appendChild(tr);
    });
}
    const tbody = document.querySelector('#movements-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const movs = inventoryMovements.slice();
    movs.sort((a,b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
    movs.forEach(m => {
        const prod = inventory.find(i => String(i.id) === String(m.product_id));
        const editBtnDisabled = isPeriodClosed(m.period) ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${m.date}</td>
            <td><span style="color: ${m.type==='ENTRADA'?'var(--success)':'var(--danger)'}; font-weight:bold;">${m.type}</span></td>
            <td>${m.reason}</td>
            <td>${prod ? prod.name : m.product_id}</td>
            <td>${m.supplier_name || '-'}</td>
            <td>${m.invoice_number || '-'}</td>
            <td>${m.quantity}</td>
            <td>${currencyFormatter.format(m.unit_cost || 0)}</td>
            <td>${currencyFormatter.format(m.iva_amount || 0)}</td>
            <td style="font-weight:600;">${currencyFormatter.format(m.total)}</td>
            ${m.type === 'SALIDA' ? `<td style="text-align:center;"><button class="btn btn-primary btn-small" onclick="editSalida(${m.id})" ${editBtnDisabled}>Editar</button></td>` : ''}
        `;
        tbody.appendChild(tr);
    });
}

    const tbody = document.querySelector('#movements-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const movs = inventoryMovements.slice();
    movs.sort((a,b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
    movs.forEach(m => {
        const prod = inventory.find(i => String(i.id) === String(m.product_id));
        const editBtnDisabled = isPeriodClosed(m.period) ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${m.date}</td>
            <td><span style="color: ${m.type==='ENTRADA'?'var(--success)':'var(--danger)'}; font-weight:bold;">${m.type}</span></td>
            <td>${m.reason}</td>
            <td>${prod ? prod.name : m.product_id}</td>
            <td>${m.supplier_name || '-'}</td>
            <td>${m.invoice_number || '-'}</td>
            <td>${m.quantity}</td>
            <td>${currencyFormatter.format(m.unit_cost || 0)}</td>
            <td>${currencyFormatter.format(m.iva_amount || 0)}</td>
            <td style="font-weight:600;">${currencyFormatter.format(m.total)}</td>
            ${m.type === 'SALIDA' ? `<td style="text-align:center;"><button class="btn btn-primary btn-small" onclick="editSalida(${m.id})" ${editBtnDisabled}>Editar</button></td>` : ''}
        `;
        tbody.appendChild(tr);
    });
}




    movs.sort((a,b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
    movs.forEach(m => {
        const prod = inventory.find(i => String(i.id) === String(m.product_id));
        const editBtnDisabled = isPeriodClosed(m.period) ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${m.date}</td>
            <td><span style="color: ${m.type==='ENTRADA'?'var(--success)':'var(--danger)'}; font-weight:bold;">${m.type}</span></td>
            <td>${m.reason}</td>
            <td>${prod ? prod.name : m.product_id}</td>
            <td>${m.supplier_name || '-'}</td>
            <td>${m.invoice_number || '-'}</td>
            <td>${m.quantity}</td>
        const deleteBtnDisabled = isPeriodClosed(m.period) ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '';
        const editBtnDisabled = isPeriodClosed(m.period) ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${m.date}</td>
            <td><span style="color: ${m.type==='ENTRADA'?'var(--success)':'var(--danger)'}; font-weight:bold;">${m.type}</span></td>
            <td>${m.reason}</td>
            <td>${prod ? prod.name : m.product_id}</td>
            <td>${m.supplier_name || '-'}</td>
            <td>${m.invoice_number || '-'}</td>
            <td>${m.quantity}</td>
            <td>${currencyFormatter.format(m.unit_cost || 0)}</td>
            <td>${currencyFormatter.format(m.iva_amount || 0)}</td>
            <td style="font-weight: 600;">${currencyFormatter.format(m.total)}</td>
            ${m.type === 'SALIDA' ? `<td style="text-align:center;"><button class="btn btn-primary btn-small" onclick="editSalida(${m.id})" ${editBtnDisabled}>Editar</button></td>` : ''}
        `;
        tbody.appendChild(tr);
    });
*/

// The table and Excel export must use the same filters and row order.
function getVisibleSales() {
    return sortByDateDesc(applySaleFilters(sales.slice(), 'ven'));
}

function renderSales() {
    const tbody = document.querySelector('#sales-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    populateSaleFilterSelects();
    const baseSales = sales.slice();
    const filteredSales = getVisibleSales();
    updateInvFilterCount('ventas-filter-count', filteredSales.length, baseSales.length);

    if (filteredSales.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#64748b;padding:1.5rem;">No hay ventas que coincidan con los filtros.</td></tr>';
    }

    const dianShownForBatch = new Set();

    filteredSales.forEach((sale) => {
        const c = clients.find(cli => String(cli.id) === String(sale.client));
        const clientName = c ? c.name : sale.client;
        const periodClosed = isPeriodClosed(sale.period);
        const disabledAttr = periodClosed ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '';
        const unitPrice = Number(sale.price) || 0;
        const batchKey = saleBatchKey(sale);
        const showDianBtn = sale.dian_invoice_file && !dianShownForBatch.has(batchKey);
        if (showDianBtn) dianShownForBatch.add(batchKey);

        const dianBtn = showDianBtn
            ? `<button class="btn btn-small" style="background: #10b981; color: white;" onclick="downloadDianInvoiceForSale(${Number(sale.id)})" title="Descargar factura DIAN"><i class="fas fa-file-download"></i></button>`
            : '';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(sale.date)}</td>
            <td>${escapeHtml(sale.product_name)}</td>
            <td>${escapeHtml(clientName)}</td>
            <td style="text-align: center;">${escapeHtml(sale.quantity)}</td>
            <td style="text-align: right;">${escapeHtml(currencyFormatter.format(unitPrice))}</td>
            <td style="text-align: right; font-weight: bold;">${escapeHtml(currencyFormatter.format(sale.total))}</td>
            <td>${escapeHtml(sale.payment_method || '')}</td>
            <td>${escapeHtml(sale.observation || '')}</td>
            <td style="text-align: center; display: flex; gap: 0.35rem; justify-content: center; flex-wrap: wrap;">
                <button class="btn btn-primary btn-small" onclick="editSale(${Number(sale.id)})" ${disabledAttr} title="Editar venta"><i class="fas fa-edit"></i></button>
                ${dianBtn}
                <button class="btn btn-small" style="background: #64748b; color: white;" onclick="generatePDF(${Number(sale.id)})" title="Descargar comprobante LuMedix"><i class="fas fa-file-pdf"></i></button>
                <button class="btn btn-danger btn-small" onclick="deleteSale(${Number(sale.id)})" ${disabledAttr} title="Eliminar venta"><i class="fas fa-trash"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    const isClosed = isPeriodClosed(currentActivePeriod);
    document.querySelectorAll('#sale-records .btn-period-dependent').forEach(btn => {
        btn.disabled = isClosed;
        btn.style.opacity = isClosed ? 0.5 : 1;
        btn.style.cursor = isClosed ? 'not-allowed' : 'pointer';
    });
}

async function editSale(id) {
    const sale = sales.find(s => String(s.id) === String(id));
    if (!sale) return alert('Venta no encontrada');
    if (isPeriodClosed(sale.period)) return alert('El período de esta venta está cerrado. No se puede editar.');

    editingSaleId = sale.id;
    const saleClientSelect = document.getElementById('sale-client');
    saleClientSelect.innerHTML = '';
    clients.filter(c => c.status === 'Activo' || String(c.id) === String(sale.client)).forEach(c => {
        const option = document.createElement('option'); option.value = c.id; option.textContent = c.name; saleClientSelect.appendChild(option);
    });
    document.getElementById('sale-client').value = sale.client;
    onSaleClientChange();
    const saleDateEl = document.getElementById('sale-date');
    if (saleDateEl) saleDateEl.value = sale.date || '';
    document.getElementById('sale-payment').value = sale.payment_method || 'Efectivo';
    document.getElementById('sale-obs').value = sale.observation || '';
    document.getElementById('sale-retentions').value = sale.retention_percent || 0;
    const invInput = document.getElementById('sale-invoice-number');
    if (invInput) invInput.value = sale.sale_invoice_number || '';
    const pdfName = document.getElementById('sale-dian-pdf-name');
    const pdfInput = document.getElementById('sale-dian-pdf');
    if (pdfInput) pdfInput.value = '';
    if (pdfName) {
        pdfName.textContent = sale.dian_invoice_file
            ? `Factura DIAN guardada${sale.sale_invoice_number ? `: ${sale.sale_invoice_number}` : ''}. Puede reemplazarla subiendo un nuevo PDF.`
            : 'Opcional. Máx. 8 MB.';
    }
    const ivaPercent = Number(sale.iva_percent) || 0;
    currentSaleItems = [{
        product_id: sale.product_id,
        product_name: sale.product_name,
        quantity: sale.quantity,
        price: sale.price,
        iva_percent: ivaPercent,
        subtotal: (Number(sale.quantity) || 0) * (Number(sale.price) || 0),
        iva_amount: Number(sale.iva_amount) || 0,
        total: sale.total
    }];
    recalcSaleItemLine(currentSaleItems[0]);
    renderSaleItems();
    setSalesModalEditMode(true);
    openModal('sales-modal');
}

async function deleteSale(id) {
    const sale = sales.find(s => String(s.id) === String(id));
    if (!sale) return alert('Venta no encontrada');
    if (isPeriodClosed(sale.period)) return alert('El período de esta venta está cerrado. No se puede eliminar.');
    if (!confirm('¿Está seguro de eliminar esta venta?')) return;

    try {
        const res = await fetch(`/api/sales/${id}`, { method: 'DELETE' });
        if (res.ok) {
            await refreshAllModules();
            alert('Venta eliminada exitosamente');
        } else {
            const err = await res.json();
            throw new Error(err.error || 'Error al eliminar la venta');
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

function renderExpenses() {
    const tbody = document.querySelector('#expenses-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    populateExpenseFilterSelects();
    updateExpenseSummary();

    const baseList = expenses.slice();
    const filtered = sortByDateDesc(baseList.filter(expenseMatchesFilters));
    updateInvFilterCount('expenses-filter-count', filtered.length, baseList.length);

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:#64748b;padding:1.5rem;">No hay gastos que coincidan con los filtros.</td></tr>';
        return;
    }

    filtered.forEach(exp => {
        const periodClosed = isPeriodClosed(getExpensePeriod(exp));
        const disabledAttr = periodClosed ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '';
        const qty = Number(exp.quantity) || 1;
        const unitPrice = Number(exp.unit_price) || Number(exp.amount) || 0;
        const ivaAmt = Number(exp.iva_amount) || 0;
        const ivaPct = Number(exp.iva_percent) || 0;
        const hasInvoiceFile = !!exp.invoice_file;
        const fileButton = hasInvoiceFile ? `<button type="button" class="btn btn-secondary btn-small" onclick="downloadExpenseInvoice(${Number(exp.id)})" title="Descargar factura"><i class="fas fa-file-pdf"></i> Descargar factura</button>` : '';
        const supportBadge = hasInvoiceFile
            ? '<span class="badge" style="background:#ecfdf5;color:#0369a1;">Soporte</span>'
            : '<span class="badge" style="background:#fef2f2;color:#b91c1c;">Sin soporte</span>';
        const invoiceCell = `${escapeHtml(exp.invoice_number || '—')} ${supportBadge}`;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(exp.date || '')}</td>
            <td><span class="badge" style="background:#e0f2fe;color:#0369a1;">${escapeHtml(getExpenseClass(exp.category))}</span></td>
            <td>${escapeHtml(exp.category || '—')}</td>
            <td>${escapeHtml(exp.supplier_name || '—')}</td>
            <td>${invoiceCell}</td>
            <td>${escapeHtml(exp.line_description || exp.description || '')}</td>
            <td style="text-align:center;">${escapeHtml(qty)}</td>
            <td style="text-align:right;">${escapeHtml(currencyFormatter.format(unitPrice))}</td>
            <td style="text-align:right;font-size:0.85rem;color:#64748b;">${escapeHtml(currencyFormatter.format(ivaAmt))} (${escapeHtml(ivaPct)}%)</td>
            <td style="text-align:right;font-weight:600;">${escapeHtml(currencyFormatter.format(Number(exp.amount) || 0))}</td>
            <td>${escapeHtml(exp.payment_method || '—')}</td>
            <td style="text-align:center;display:flex;gap:0.35rem;justify-content:center;flex-wrap:wrap;">
                ${fileButton}
                <button type="button" class="btn btn-primary btn-small" onclick="editExpense(${Number(exp.id)})" ${disabledAttr} title="Editar factura"><i class="fas fa-edit"></i></button>
                <button type="button" class="btn btn-danger btn-small" onclick="deleteExpense(${Number(exp.id)})" ${disabledAttr} title="Eliminar"><i class="fas fa-trash"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function downloadExpenseInvoice(id) {
    const exp = expenses.find(e => String(e.id) === String(id));
    if (!exp || !exp.invoice_file) return alert('No hay soporte adjunto para este gasto.');
    if (exp.invoice_file.startsWith('data:')) {
        const link = document.createElement('a');
        link.href = exp.invoice_file;
        link.download = `Soporte_Gasto_${exp.invoice_number || exp.id}.pdf`;
        link.click();
        return;
    }
    try {
        const res = await fetch(`/api/expenses/${id}/invoice-file`);
        if (!res.ok) {
            const err = await res.json();
            return alert(err.error || 'No se pudo descargar el soporte.');
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `Soporte_Gasto_${exp.invoice_number || exp.id}.pdf`;
        link.click();
        URL.revokeObjectURL(url);
    } catch (err) {
        alert('Error al descargar el soporte: ' + err.message);
    }
}

function addExpenseItem() {
    const desc = (document.getElementById('exp-line-desc')?.value || '').trim();
    const qty = parseInt(document.getElementById('exp-line-qty')?.value, 10);
    const price = parseFloat(document.getElementById('exp-line-price')?.value);
    const ivaPercent = parseFloat(document.getElementById('exp-line-iva')?.value) || 0;
    if (!desc) return alert('Indique el concepto o producto.');
    if (!qty || qty <= 0) return alert('La cantidad debe ser mayor a cero.');
    const item = { description: desc, quantity: qty, unit_price: price || 0, iva_percent: ivaPercent };
    recalcExpenseItemLine(item);
    currentExpenseItems.push(item);
    renderExpenseItems();
    document.getElementById('exp-line-desc').value = '';
    document.getElementById('exp-line-qty').value = '1';
    document.getElementById('exp-line-price').value = '0';
}

function removeExpenseItem(index) {
    currentExpenseItems.splice(index, 1);
    renderExpenseItems();
}

function renderExpenseItems() {
    const tbody = document.querySelector('#expense-items-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    let subtotalGeneral = 0;
    let ivaGeneral = 0;
    currentExpenseItems.forEach((item, idx) => {
        recalcExpenseItemLine(item);
        subtotalGeneral += item.subtotal;
        ivaGeneral += item.iva_amount;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(item.description)}</td>
            <td style="text-align:center;">${escapeHtml(item.quantity)}</td>
            <td style="text-align:right;">${escapeHtml(currencyFormatter.format(item.unit_price))}</td>
            <td style="text-align:right;color:#64748b;font-size:0.85rem;">${escapeHtml(currencyFormatter.format(item.iva_amount))} (${escapeHtml(item.iva_percent)}%)</td>
            <td style="text-align:right;font-weight:600;">${escapeHtml(currencyFormatter.format(item.total))}</td>
            <td style="text-align:center;">
                <button type="button" class="btn btn-danger btn-small" onclick="removeExpenseItem(${Number(idx)})"><i class="fas fa-trash"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });
    const subEl = document.getElementById('exp-invoice-subtotal');
    const ivaEl = document.getElementById('exp-invoice-iva');
    const totEl = document.getElementById('exp-invoice-total');
    if (subEl) subEl.innerText = currencyFormatter.format(subtotalGeneral);
    if (ivaEl) ivaEl.innerText = currencyFormatter.format(ivaGeneral);
    if (totEl) totEl.innerText = currencyFormatter.format(subtotalGeneral + ivaGeneral);
}

async function persistRecord(resource, id, item) {
    const response = await fetch(`/api/${resource}${id ? '/' + id : ''}`, {
        method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo guardar en la base de datos.');
    if (id && result.changes === 0) throw new Error('El registro ya no existe. Recargue la información.');
    return result;
}

async function handleInventorySubmit(e) {
    e.preventDefault();
    const isClosed = isPeriodClosed(currentActivePeriod);
    if(isClosed) return alert("PerÃ­odo cerrado.");
    const id = document.getElementById('inv-id').value;
    const item = {
        code: document.getElementById('inv-code').value,
        name: document.getElementById('inv-name').value,
        category: document.getElementById('inv-category').value,
        min_stock: parseInt(document.getElementById('inv-min-stock').value),
        status: document.getElementById('inv-status').value
    };
    try {
        const saved = await persistRecord('inventory', id, item);
        if (!id && saved.id) document.getElementById('inv-id').value = saved.id;
        await refreshAllModules();
        closeModal('inventory-modal');
        e.target.reset();
        document.getElementById('inv-id').value = '';
    } catch (error) {
        alert(error.saved ? 'El cambio se guardó en la base de datos, pero no se pudo actualizar la pantalla. Recargue la aplicación.' : 'No se guardaron los cambios: ' + error.message);
    }
}

function editInventory(idOrIdx) {
    const isClosed = isPeriodClosed(currentActivePeriod);
    if(isClosed) return alert("PerÃ­odo cerrado.");
    const item = inventory.find(i => String(i.id) === String(idOrIdx)) || inventory[idOrIdx];
    if(!item) return;
    document.getElementById('inv-id').value = item.id;
    document.getElementById('inv-code').value = item.code || '';
    document.getElementById('inv-name').value = item.name || '';
    document.getElementById('inv-category').value = item.category || '';
    document.getElementById('inv-min-stock').value = item.min_stock || 0;
    document.getElementById('inv-status').value = item.status || 'Activo';
    openModal('inventory-modal');
}

function populateInventoryProducts(selectId) {
    const select = document.getElementById(selectId);
    if(!select) return;
    select.innerHTML = '<option value="">Seleccione un producto</option>';
    const actives = inventory.filter(i => i.status !== 'Inactivo');
    actives.forEach(item => {
        select.innerHTML += `<option value="${Number(item.id)}">${escapeHtml(item.code || '')} - ${escapeHtml(item.name)}</option>`;
    });
}

async function handleEntradaSubmit(e) {
    e.preventDefault();
    const date = document.getElementById('ent-date').value;
    if (!date) return alert("Debe ingresar una fecha.");
    const targetPeriod = date.slice(0, 7);
    // Ensure the invoice period matches the currently active period
    if (targetPeriod !== currentActivePeriod) {
        return alert(`La factura corresponde al período ${targetPeriod}. Cambie al período activo (${currentActivePeriod}) antes de guardar.`);
    }
    const isClosed = isPeriodClosed(targetPeriod);
    if(isClosed) return alert(`El período ${targetPeriod} correspondiente a la fecha de la factura está CERRADO o no existe.`);
    if (currentInvoiceItems.length === 0) return alert("Debe agregar al menos un producto a la factura.");

    const suppId = document.getElementById('ent-supplier').value;
    const invoice = document.getElementById('ent-invoice').value;
    const obs = document.getElementById('ent-obs').value;
    const supp = suppliers.find(s => String(s.id) === String(suppId));

    try {
        let invoiceFile = null;
        const pdfInput = document.getElementById('ent-invoice-pdf');
        if (pdfInput?.files?.[0]) {
            invoiceFile = await readEntradaInvoicePdf(pdfInput.files[0]);
        }

        const payload = {
            date,
            invoice_number: invoice,
            supplier_id: suppId,
            supplier_name: supp ? supp.name : '',
            observation: obs,
            items: currentInvoiceItems.map(item => ({
                product_id: item.product_id,
                quantity: item.quantity,
                unit_cost: item.unit_cost,
                iva_percent: item.iva_percent || 0,
                iva_amount: item.iva_amount || 0
            })),
            invoice_file: invoiceFile
        };

        if (editingInvoice) {
            payload.is_edit = true;
            payload.old_supplier_id = editingInvoice.old_supplier_id;
            payload.old_invoice_number = editingInvoice.old_invoice_number;
            payload.old_date = editingInvoice.old_date;
        }

        const res = await fetch('/api/invoices/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) {
            const raw = await res.text();
            let msg = `No se pudo guardar (código ${res.status}).`;
            try {
                const errData = JSON.parse(raw);
                if (errData.error) msg = errData.error;
            } catch (_) {
                if (raw) msg = raw.slice(0, 300);
            }
            if (res.status === 413) {
                msg = 'El PDF es demasiado grande. Use un archivo menor a 8 MB o reinicie el servidor.';
            }
            throw new Error(msg);
        }

        await refreshAllModules();
        closeModal('entrada-modal');
        resetEntradaForm();
    } catch(err) {
        alert((editingInvoice ? 'Error al actualizar la factura: ' : 'Error al guardar la factura: ') + err.message);
    }
}

function addInvoiceItem() {
    const productId = document.getElementById('ent-product-select').value;
    const qty = parseInt(document.getElementById('ent-qty-input').value);
    const cost = parseFloat(document.getElementById('ent-cost-input').value);
    const ivaPercent = parseFloat(document.getElementById('ent-iva-input').value) || 0;

    if (!productId) return alert("Seleccione un producto");
    if (qty <= 0) return alert("La cantidad debe ser mayor a 0");

    const product = inventory.find(i => String(i.id) === String(productId));
    const subtotal = qty * cost;
    const ivaAmount = subtotal * (ivaPercent / 100);
    const total = subtotal + ivaAmount;

    const newItem = {
        product_id: productId,
        product_name: product ? product.name : 'Unknown',
        quantity: qty,
        unit_cost: cost,
        iva_percent: ivaPercent,
        iva_amount: ivaAmount,
        subtotal: subtotal,
        total: total
    };

    currentInvoiceItems.push(newItem);
    renderInvoiceItems();
    
    // Reset inputs
    document.getElementById('ent-product-select').value = '';
    document.getElementById('ent-qty-input').value = '1';
    document.getElementById('ent-cost-input').value = '0';
    // Mantenemos el IVA por defecto (normalmente 19)
}

function removeInvoiceItem(index) {
    currentInvoiceItems.splice(index, 1);
    renderInvoiceItems();
}

function renderInvoiceItems() {
    const tbody = document.querySelector('#invoice-items-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    let subtotalGeneral = 0;
    let ivaGeneral = 0;

    currentInvoiceItems.forEach((item, idx) => {
        subtotalGeneral += item.subtotal;
        ivaGeneral += item.iva_amount;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(item.product_name)}</td>
            <td style="text-align: center;">${escapeHtml(item.quantity)}</td>
            <td style="text-align: right;">${escapeHtml(currencyFormatter.format(item.unit_cost))}</td>
            <td style="text-align: right; color: #64748b; font-size: 0.85rem;">${escapeHtml(currencyFormatter.format(item.iva_amount))} (${escapeHtml(item.iva_percent)}%)</td>
            <td style="text-align: right; font-weight: 600;">${escapeHtml(currencyFormatter.format(item.total))}</td>
            <td style="text-align: center;">
                <button type="button" class="btn btn-danger btn-small" onclick="removeInvoiceItem(${Number(idx)})"><i class="fas fa-trash"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('ent-invoice-subtotal').innerText = currencyFormatter.format(subtotalGeneral);
    document.getElementById('ent-invoice-iva').innerText = currencyFormatter.format(ivaGeneral);
    document.getElementById('ent-invoice-total').innerText = currencyFormatter.format(subtotalGeneral + ivaGeneral);
}

async function handleSalidaSubmit(e) {
    e.preventDefault();
    const date = document.getElementById('sal-date').value;
    const targetPeriod = date.slice(0,7);
    const isClosed = isPeriodClosed(targetPeriod);
    if(isClosed) return alert(`El período ${currentActivePeriod} está CERRADO. No se pueden registrar salidas.`);
    try {
        const prodId = document.getElementById('sal-product').value;
        const qty = parseInt(document.getElementById('sal-qty').value);
        await registrarMovimientoInventario({
            periodo: targetPeriod,
            fecha: document.getElementById('sal-date').value,
            productoId: prodId,
            tipo: 'SALIDA',
            motivo: document.getElementById('sal-reason').value,
            cantidad: qty,
            costoUnitario: 0,
            observacion: document.getElementById('sal-obs').value
        });
        await refreshAllModules();
        closeModal('salida-modal');
        e.target.reset();
    } catch(err) {
        alert(err.message);
    }
}

function onSaleClientChange() {
    const clientId = document.getElementById('sale-client').value;
    const c = clients.find(cli => String(cli.id) === String(clientId));
    const nitEl = document.getElementById('selected-client-nit');
    const emailEl = document.getElementById('selected-client-email');
    if (!c) {
        if (nitEl) nitEl.innerText = '-';
        if (emailEl) emailEl.innerText = '-';
        return;
    }
    if (nitEl) nitEl.innerText = c.identification || '-';
    if (emailEl) emailEl.innerText = c.email || '-';
    const idNumber = document.getElementById('sale-id-number');
    const idEmail = document.getElementById('sale-email');
    const idType = document.getElementById('sale-id-type');
    const fiscalRegime = document.getElementById('sale-fiscal-regime');
    if (idNumber) idNumber.value = c.identification || '';
    if (idEmail) idEmail.value = c.email || '';
    if (idType) {
        const id = (c.identification || '').replace(/\D/g, '');
        idType.value = id.length > 10 ? 'NIT' : 'CC';
    }
    if (fiscalRegime && !fiscalRegime.value) fiscalRegime.value = 'Común';
}

function populateSalesProducts() {
    const select = document.getElementById('sale-product');
    select.innerHTML = '<option value="">Seleccione un producto</option>';
    inventory.forEach((item, idx) => {
        const cStock = calculateStock(item.id, currentActivePeriod);
        if(cStock > 0 && item.status !== 'Inactivo') {
            select.innerHTML += `<option value="${Number(item.id)}" data-price="${escapeHtml(item.sale_price || item.price || 0)}" data-name="${escapeHtml(item.name)}">${escapeHtml(item.name)} - Stock: ${escapeHtml(cStock)}</option>`;
        }
    });
}

function updateSaleProductPrice() {
    const select = document.getElementById('sale-product');
    const priceInput = document.getElementById('sale-price');
    if(select.selectedIndex > 0) {
        priceInput.value = select.options[select.selectedIndex].dataset.price;
    } else {
        priceInput.value = "0";
    }
}

function addSaleItem() {
    const select = document.getElementById('sale-product');
    const productId = select.value;
    const qty = parseInt(document.getElementById('sale-qty').value);
    const price = parseFloat(document.getElementById('sale-price').value);
    const ivaPercent = parseFloat(document.getElementById('sale-item-iva').value) || 0;

    if (!productId) return alert("Seleccione un producto");
    if (qty <= 0) return alert("La cantidad debe ser mayor a 0");

    const opt = select.options[select.selectedIndex];
    const productName = opt.dataset.name;
    
    // Check stock
    const invItem = inventory.find(i => String(i.id) === String(productId));
    const cStock = calculateStock(invItem.id, currentActivePeriod);
    
    // Check existing added qty
    const existing = currentSaleItems.find(i => String(i.product_id) === String(productId));
    const totalQty = (existing ? existing.quantity : 0) + qty;
    
    if(cStock < totalQty) return alert("Stock insuficiente para agregar esta cantidad.");

    if (existing) {
        existing.quantity += qty;
        recalcSaleItemLine(existing);
    } else {
        const newItem = {
            product_id: productId,
            product_name: productName,
            quantity: qty,
            price: price,
            iva_percent: ivaPercent
        };
        recalcSaleItemLine(newItem);
        currentSaleItems.push(newItem);
    }

    renderSaleItems();
    
    // Reset inputs
    document.getElementById('sale-product').value = '';
    document.getElementById('sale-qty').value = '1';
    document.getElementById('sale-price').value = '0';
}

function removeSaleItem(index) {
    currentSaleItems.splice(index, 1);
    renderSaleItems();
}

function renderSaleItems() {
    const tbody = document.querySelector('#sale-items-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    let subtotalGeneral = 0;
    let ivaGeneral = 0;

    currentSaleItems.forEach((item, idx) => {
        recalcSaleItemLine(item);
        subtotalGeneral += item.subtotal;
        ivaGeneral += item.iva_amount;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(item.product_name)}</td>
            <td style="text-align: center;">
                ${editingSaleId
                    ? `<input type="number" min="1" value="${escapeHtml(item.quantity)}" style="width:70px;text-align:center" onchange="updateEditingSaleItem(${Number(idx)},'quantity',this.value)">`
                    : item.quantity}
            </td>
            <td style="text-align: right;">
                ${editingSaleId
                    ? `<input type="number" min="0" step="0.01" value="${escapeHtml(item.price)}" style="width:90px;text-align:right" onchange="updateEditingSaleItem(${Number(idx)},'price',this.value)">`
                    : currencyFormatter.format(item.price)}
            </td>
            <td style="text-align: right; color: #64748b; font-size: 0.85rem;">
                ${editingSaleId
                    ? `<input type="number" min="0" step="0.01" value="${escapeHtml(item.iva_percent)}" style="width:70px;text-align:right" onchange="updateEditingSaleItem(${Number(idx)},'iva_percent',this.value)">%`
                    : `${currencyFormatter.format(item.iva_amount)} (${item.iva_percent}%)`}
            </td>
            <td style="text-align: right; font-weight: 600;">${escapeHtml(currencyFormatter.format(item.total))}</td>
            <td style="text-align: center;">
                ${editingSaleId ? '' : `<button type="button" class="btn btn-danger btn-small" onclick="removeSaleItem(${Number(idx)})"><i class="fas fa-trash"></i></button>`}
            </td>
        `;
        tbody.appendChild(tr);
    });

    const retPerc = parseFloat(document.getElementById('sale-retentions').value) || 0;
    const retAmount = subtotalGeneral * retPerc / 100;
    const total = subtotalGeneral + ivaGeneral - retAmount;

    document.getElementById('sale-subtotal').innerText = currencyFormatter.format(subtotalGeneral);
    document.getElementById('sale-iva-amount').innerText = currencyFormatter.format(ivaGeneral);
    document.getElementById('sale-retentions-amount').innerText = currencyFormatter.format(retAmount);
    document.getElementById('sale-total').innerText = currencyFormatter.format(total);
}

async function handleSalesSubmit(e) {
    e.preventDefault();

    if (editingSaleId) {
        const sale = sales.find(s => String(s.id) === String(editingSaleId));
        if (!sale) return alert('Venta no encontrada');
        if (isPeriodClosed(sale.period)) return alert('El período de esta venta está cerrado.');

        const item = currentSaleItems[0];
        if (!item) return alert('No hay producto en la venta.');

        let dianInvoiceFile;
        try {
            const pdfInput = document.getElementById('sale-dian-pdf');
            if (pdfInput?.files?.[0]) {
                dianInvoiceFile = await readInvoicePdfFile(pdfInput.files[0], document.getElementById('sale-dian-pdf-name'));
            }
        } catch (pdfErr) {
            return alert(pdfErr.message);
        }

        const updatePayload = {
            client: document.getElementById('sale-client').value,
            payment_method: document.getElementById('sale-payment').value,
            date: document.getElementById('sale-date').value,
            quantity: item.quantity,
            product_id: item.product_id,
            price: item.price,
            iva_percent: item.iva_percent,
            iva_amount: item.iva_amount,
            observation: document.getElementById('sale-obs').value,
            retention_percent: Number(document.getElementById('sale-retentions').value) || 0,
            sale_invoice_number: document.getElementById('sale-invoice-number')?.value?.trim() || null
        };
        if (dianInvoiceFile) updatePayload.dian_invoice_file = dianInvoiceFile;
        const originalEditableFields = {
            client: sale.client, payment_method: sale.payment_method || 'Efectivo', date: sale.date,
            quantity: sale.quantity, product_id: sale.product_id, price: sale.price,
            iva_percent: Number(sale.iva_percent) || 0, retention_percent: Number(sale.retention_percent) || 0,
            sale_invoice_number: sale.sale_invoice_number || null
        };
        const observationOnly = !dianInvoiceFile && Object.entries(originalEditableFields)
            .every(([key, value]) => String(updatePayload[key] ?? '') === String(value ?? ''));
        const editPayload = observationOnly ? { observation: updatePayload.observation } : updatePayload;

        try {
            const res = await fetch(`/api/sales/${editingSaleId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editPayload)
            });
            if (res.ok) {
                const savedResponse = await fetch(`/api/sales/${editingSaleId}`, { cache: 'no-store' });
                if (!savedResponse.ok) throw new Error('No fue posible comprobar la observación guardada.');
                const savedSale = await savedResponse.json();
                if ((savedSale.observation ?? '') !== updatePayload.observation) {
                    throw new Error('El servidor de ventas activo está desactualizado y no confirmó la observación. El cambio no se guardó; conserve el texto, reinicie el servidor de LuMedix y vuelva a intentarlo.');
                }
                await refreshAllModules();
                closeModal('sales-modal');
                e.target.reset();
                resetSaleFormExtras();
                currentSaleItems = [];
                renderSaleItems();
                alert('Venta actualizada exitosamente');
            } else {
                const err = await res.json();
                throw new Error(err.error || 'Error al actualizar la venta');
            }
        } catch (error) {
            alert('Error: ' + error.message);
        }
        return;
    }

    const isClosed = isPeriodClosed(currentActivePeriod);
    if(isClosed) return alert("Período cerrado.");
    
    if(currentSaleItems.length === 0) return alert("Debe agregar al menos un producto a la venta.");

    const saleDate = document.getElementById('sale-date').value;
    if (!saleDate) return alert('Debe ingresar una fecha.');
    const targetPeriod = saleDate.slice(0, 7);
    if (targetPeriod !== currentActivePeriod) {
        return alert(`La venta corresponde al período ${targetPeriod}. Cambie al período activo (${currentActivePeriod}) antes de guardar.`);
    }

    let dianInvoiceFile = null;
    try {
        const pdfInput = document.getElementById('sale-dian-pdf');
        if (pdfInput?.files?.[0]) {
            dianInvoiceFile = await readInvoicePdfFile(pdfInput.files[0], document.getElementById('sale-dian-pdf-name'));
        }
    } catch (pdfErr) {
        return alert(pdfErr.message);
    }

    const salePayload = {
        client: document.getElementById('sale-client').value,
        payment_method: document.getElementById('sale-payment').value,
        date: saleDate,
        period: targetPeriod,
        sale_invoice_number: document.getElementById('sale-invoice-number')?.value?.trim() || null,
        dian_invoice_file: dianInvoiceFile,
        observation: document.getElementById('sale-obs').value,
        retention_percent: Number(document.getElementById('sale-retentions').value) || 0,
        items: currentSaleItems
    };

    try {
        const res = await fetch('/api/sales', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(salePayload) 
        });
        
        if(res.ok) {
            const createdSale = await res.json();
            if (!Array.isArray(createdSale.sale_ids) || createdSale.sale_ids.length === 0) {
                throw new Error('La venta se registró, pero el servidor no devolvió los registros para verificar la observación. Reinicie el servidor antes de continuar.');
            }
            for (const saleId of createdSale.sale_ids) {
                const savedResponse = await fetch(`/api/sales/${saleId}`, { cache: 'no-store' });
                if (!savedResponse.ok) throw new Error('La venta se registró, pero no fue posible comprobar la observación guardada.');
                const savedSale = await savedResponse.json();
                if ((savedSale.observation ?? '') !== salePayload.observation) {
                    throw new Error('La venta se registró, pero el servidor no confirmó la observación. Conserve el texto y reinicie el servidor antes de reintentar.');
                }
            }
            await refreshAllModules();
            closeModal('sales-modal');
            e.target.reset();
            resetSaleFormExtras();
            currentSaleItems = [];
            renderSaleItems();
            alert("Venta registrada exitosamente");
        } else {
            const err = await res.json();
            throw new Error(err.error || "Error al registrar la venta");
        }
    } catch(error) {
        alert("Error: " + error.message);
    }
}

async function handleExpenseSubmit(e) {
    e.preventDefault();
    const header = buildExpenseHeaderFromForm();
    if (!header.date) return alert('Indique la fecha del gasto.');
    if (!header.category) return alert('Seleccione una categoría.');
    if (currentExpenseItems.length === 0) return alert('Agregue al menos un concepto o producto.');

    const targetPeriod = header.date.slice(0, 7);
    if (isPeriodClosed(targetPeriod)) return alert(`El período ${targetPeriod} está cerrado.`);
    if (currentActivePeriod && targetPeriod !== currentActivePeriod) {
        return alert(`La fecha corresponde a ${targetPeriod}. Cambie al período activo (${currentActivePeriod}) o ajuste la fecha.`);
    }

    let invoiceFile = currentExpenseInvoiceFile || null;
    const fileInput = document.getElementById('exp-invoice-file');
    const selectedFile = fileInput?.files?.[0];
    if (selectedFile) {
        if (selectedFile.size > 15 * 1024 * 1024) return alert('El archivo no puede superar 15 MB.');
        try {
            invoiceFile = await readFileAsDataURL(selectedFile);
        } catch (readErr) {
            return alert('No se pudo leer el archivo seleccionado.');
        }
    }

    const payload = {
        ...header,
        invoice_file: invoiceFile,
        items: currentExpenseItems.map(item => ({
            description: item.description,
            quantity: item.quantity,
            unit_price: item.unit_price,
            iva_percent: item.iva_percent
        }))
    };

    try {
        const url = editingExpenseId
            ? `/api/expenses/${editingExpenseId}`
            : '/api/expenses';
        const res = await fetch(url, {
            method: editingExpenseId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Error al guardar');
        }
        alert(editingExpenseId ? 'Gasto actualizado' : 'Gasto registrado');
        editingExpenseId = null;
        editingExpenseBatchId = null;
        currentExpenseItems = [];
        currentExpenseInvoiceFile = null;
        const fileInput = document.getElementById('exp-invoice-file');
        if (fileInput) fileInput.value = '';
        const fileLabel = document.getElementById('exp-invoice-file-label');
        if (fileLabel) fileLabel.textContent = 'Sin archivo adjunto.';
        await refreshAllModules();
        closeModal('expenses-modal');
        e.target.reset();
        renderExpenseItems();
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

async function handlePeriodSubmit(e) {
    e.preventDefault();
    const month = document.getElementById('period-month').value;
    if(periods.find(p => p.month === month)) return alert('Ese perÃ­odo ya existe.');
    const newPeriod = { month, status: 'ABIERTO' };
    try {
        const res = await fetch('/api/periods', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month }) });
        if(res.ok) {
            const data = await res.json();
            newPeriod.id = data.id;
            periods.unshift(newPeriod);
            savePeriodsToLocal();
        } else throw new Error();
    } catch(err) {
        return alert('No se guardó el período en la base de datos: ' + err.message);
    }
    renderPeriods();
    updatePeriodBadge();
    closeModal('period-modal');
    e.target.reset();
}

async function closePeriod(month) {
    const hasOpenBefore = periods.some(p => p.month < month && p.status === 'ABIERTO');
    if (hasOpenBefore) {
        alert('No puedes cerrar este perÃ­odo porque existen perÃ­odos anteriores abiertos. Cierra primero los perÃ­odos anteriores.');
        return;
    }

    if (!confirm(`¿Estás seguro de que deseas cerrar el período ${month}? Al cerrar, no podrás agregar más ventas ni gastos en este mes.`)) return;
    try {
        const res = await fetch(`/api/periods/${month}/close`, { method: 'PUT' });
        if(res.ok) {
            const p = periods.find(p => p.month === month);
            if(p) p.status = 'CERRADO';
            savePeriodsToLocal();
        } else {
            const errData = await res.json();
            alert(errData.error || "Error al cerrar el perÃ­odo.");
        }
    } catch(e) {
        return alert('No se guardó el estado del período: ' + e.message);
    }
    renderPeriods();
    updatePeriodBadge();
}

async function openPeriod(month) {
    const hasClosedAfter = periods.some(p => p.month > month && p.status === 'CERRADO');
    if (hasClosedAfter) {
        alert('No puedes reabrir este perÃ­odo porque existen perÃ­odos posteriores cerrados. Reabre primero los perÃ­odos mÃ¡s recientes.');
        return;
    }

    if (!confirm(`¿Estás seguro de que deseas reabrir el período ${month}?`)) return;
    try {
        const res = await fetch(`/api/periods/${month}/open`, { method: 'PUT' });
        if(res.ok) {
            const p = periods.find(p => p.month === month);
            if(p) p.status = 'ABIERTO';
            savePeriodsToLocal();
        } else {
            const errData = await res.json();
            alert(errData.error || "Error al reabrir el perÃ­odo.");
        }
    } catch(e) {
        return alert('No se guardó el estado del período: ' + e.message);
    }
    renderPeriods();
    updatePeriodBadge();
}

async function deletePeriod(month) {
    if (!confirm(`¿Estás seguro de que deseas eliminar el período ${month}? Esta acción no se puede deshacer.`)) return;
    try {
        const res = await fetch(`/api/periods/${month}`, { method: 'DELETE' });
        if (res.ok) {
            periods = periods.filter(p => p.month !== month);
            savePeriodsToLocal();
        } else {
            const errData = await res.json();
            alert(errData.error || "Error al eliminar el período.");
        }
    } catch (e) {
        periods = periods.filter(p => p.month !== month);
        savePeriodsToLocal();
    }
    renderPeriods();
    updatePeriodBadge();
}

function getSalePeriod(sale) {
    return sale.period || (sale.date ? String(sale.date).slice(0, 7) : '');
}

function getExpensePeriod(exp) {
    return exp.period || (exp.date ? String(exp.date).slice(0, 7) : '');
}

function getExpenseClass(category) {
    return EXPENSE_CLASS_BY_CATEGORY[category] || 'Administrativo';
}

function getPeriodCogs(period) {
    if (!period) return 0;
    return sales.filter(s => getSalePeriod(s) === period).reduce((sum, sale) => {
        const avgCost = getWeightedAverageCost(sale.product_id, period);
        return sum + ((Number(sale.quantity) || 0) * avgCost);
    }, 0);
}

function getMercanciaPurchasesTotal(period) {
    if (!period) return 0;
    return inventoryMovements
        .filter(m => m.type === 'ENTRADA' && m.reason === 'Compra' && String(m.period) === String(period))
        .reduce((s, m) => s + (Number(m.total) || 0), 0);
}

function getFinancialMetrics(period) {
    if (!period) {
        return {
            salesRevenue: 0, cogs: 0, opex: 0, grossProfit: 0, operatingProfit: 0,
            mercanciaPurchases: 0, openingCash: 0, estimatedCash: 0, openingBank: 0, estimatedBank: 0
        };
    }
    const salesRevenue = sales
        .filter(s => getSalePeriod(s) === period)
        .reduce((acc, s) => acc + getSaleTotal(s), 0);
        
    const salesCash = sales
        .filter(s => getSalePeriod(s) === period && s.payment_method === 'Efectivo')
        .reduce((acc, s) => acc + getSaleTotal(s), 0);
    const salesBank = salesRevenue - salesCash;

    const cogs = getPeriodCogs(period);
    const opex = expenses
        .filter(e => getExpensePeriod(e) === period)
        .reduce((acc, e) => acc + (Number(e.amount) || 0), 0);

    const opexCash = expenses
        .filter(e => getExpensePeriod(e) === period && e.payment_method === 'Efectivo')
        .reduce((acc, e) => acc + (Number(e.amount) || 0), 0);
    const opexBank = opex - opexCash;

    const grossProfit = salesRevenue - cogs;
    const operatingProfit = grossProfit - opex;
    const mercanciaPurchases = getMercanciaPurchasesTotal(period);
    
    // Use the active period's opening balances if this is the active period,
    // otherwise fetch from the period_opening_balance data already cached.
    // currentPeriodOpeningCash/Bank are loaded by loadActivePeriodOpeningBalance()
    // and always correspond to currentActivePeriod.
    const openingCash = (period === currentActivePeriod) ? currentPeriodOpeningCash : 0;
    const openingBank = (period === currentActivePeriod) ? currentPeriodOpeningBank : 0;

    const estimatedCash = openingCash + salesCash - opexCash;
    const estimatedBank = openingBank + salesBank - opexBank - mercanciaPurchases;

    return {
        salesRevenue, cogs, opex, grossProfit, operatingProfit, mercanciaPurchases,
        openingCash, estimatedCash, openingBank, estimatedBank
    };
}

function getExpenseBatchLines(exp) {
    if (exp?.expense_batch_id) {
        return expenses.filter(e => String(e.expense_batch_id) === String(exp.expense_batch_id));
    }
    return exp ? [exp] : [];
}

function recalcExpenseItemLine(item) {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.unit_price) || 0;
    const ivaPercent = Number(item.iva_percent) || 0;
    item.subtotal = qty * price;
    item.iva_amount = item.subtotal * (ivaPercent / 100);
    item.total = item.subtotal + item.iva_amount;
}

async function loadOpeningCash() {
    try {
        const res = await fetch('/api/settings/opening-cash');
        if (res.ok) {
            const data = await res.json();
            openingCashBalance = Number(data.amount) || 0;
        }
    } catch (_) {
        openingCashBalance = Number(localStorage.getItem('lm_opening_cash')) || 0;
    }
}

// Get previous period in YYYY-MM format
function getPreviousPeriod(period) {
    if (!period || !period.includes('-')) return null;
    const [year, month] = period.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1, 1);
    date.setMonth(date.getMonth() - 1);
    const prevYear = date.getFullYear();
    const prevMonth = String(date.getMonth() + 1).padStart(2, '0');
    return `${prevYear}-${prevMonth}`;
}

// Auto-populate opening balance from previous month's closing balance
async function autoPopulateOpeningBalanceFromPreviousMonth() {
    if (!currentActivePeriod) return;
    
    try {
        // Check if current period already has opening balance defined
        const res = await fetch(`/api/period-opening-balance/${currentActivePeriod}`);
        if (!res.ok) return;
        
        const currentBalance = await res.json();
        // If opening balance is already set (both cash AND bank not zero), don't override it
        const hasCash = (currentBalance.opening_cash || 0) !== 0;
        const hasBank = (currentBalance.opening_bank || 0) !== 0;
        if (hasCash && hasBank) {
            return; // Both already configured, skip auto-population
        }
        
        // Get previous period
        const prevPeriod = getPreviousPeriod(currentActivePeriod);
        if (!prevPeriod) return;
        
        // Get previous period's opening balance from API
        const prevOpeningRes = await fetch(`/api/period-opening-balance/${prevPeriod}`);
        if (!prevOpeningRes.ok) return;
        
        const prevOpeningBalance = await prevOpeningRes.json();
        const prevOpeningCash = Number(prevOpeningBalance.opening_cash) || 0;
        const prevOpeningBank = Number(prevOpeningBalance.opening_bank) || 0;
        
        // Calculate previous period's cash/bank flows
        const prevSalesRevenue = sales
            .filter(s => getSalePeriod(s) === prevPeriod)
            .reduce((acc, s) => acc + getSaleTotal(s), 0);
        
        const prevSalesCash = sales
            .filter(s => getSalePeriod(s) === prevPeriod && s.payment_method === 'Efectivo')
            .reduce((acc, s) => acc + getSaleTotal(s), 0);
        const prevSalesBank = prevSalesRevenue - prevSalesCash;
        
        const prevOpex = expenses
            .filter(e => getExpensePeriod(e) === prevPeriod)
            .reduce((acc, e) => acc + (Number(e.amount) || 0), 0);
        
        const prevOpexCash = expenses
            .filter(e => getExpensePeriod(e) === prevPeriod && e.payment_method === 'Efectivo')
            .reduce((acc, e) => acc + (Number(e.amount) || 0), 0);
        const prevOpexBank = prevOpex - prevOpexCash;
        
        const prevMercanciaPurchases = getMercanciaPurchasesTotal(prevPeriod);
        
        // Calculate closing balance for previous period
        const prevClosingCash = prevOpeningCash + prevSalesCash - prevOpexCash;
        const prevClosingBank = prevOpeningBank + prevSalesBank - prevOpexBank - prevMercanciaPurchases;
        
        // If previous period has no movements, don't auto-populate
        if (prevClosingCash === prevOpeningCash && prevClosingBank === prevOpeningBank) {
            return;
        }
        
        // Set opening balance of current period to the closing balance of previous period
        const updateRes = await fetch(`/api/period-opening-balance/${currentActivePeriod}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                opening_bank: prevClosingBank,
                opening_cash: prevClosingCash,
                opening_merchandise_value: 0,
                opening_other_assets: 0
            })
        });
        
        if (updateRes.ok) {
            console.log(`Saldos iniciales de ${currentActivePeriod} poblados automáticamente: Banco ${prevClosingBank}, Efectivo ${prevClosingCash}`);
        }
    } catch (err) {
        console.warn('Error auto-populating opening balance:', err);
    }
}

async function loadActivePeriodOpeningBalance() {
    if (!currentActivePeriod) {
        currentPeriodOpeningCash = 0;
        currentPeriodOpeningBank = 0;
        return;
    }
    try {
        const res = await fetch(`/api/period-opening-balance/${currentActivePeriod}`);
        if (res.ok) {
            const data = await res.json();
            currentPeriodOpeningCash = Number(data.opening_cash) || 0;
            currentPeriodOpeningBank = Number(data.opening_bank) || 0;
        } else {
            currentPeriodOpeningCash = 0;
            currentPeriodOpeningBank = 0;
        }
    } catch (err) {
        currentPeriodOpeningCash = 0;
        currentPeriodOpeningBank = 0;
    }
}

function openOpeningCashModal() {
    const bankInput = document.getElementById('opening-bank-input');
    const cashInput = document.getElementById('opening-cash-input');
    if (bankInput) bankInput.value = currentPeriodOpeningBank || 0;
    if (cashInput) cashInput.value = currentPeriodOpeningCash || 0;
    openModal('opening-cash-modal');
}

async function saveOpeningCash(e) {
    e.preventDefault();
    const bankAmount = Number(document.getElementById('opening-bank-input').value) || 0;
    const cashAmount = Number(document.getElementById('opening-cash-input').value) || 0;
    if (isNaN(bankAmount) || isNaN(cashAmount)) {
        return alert('Indique saldos válidos.');
    }
    
    try {
        const previousRes = await fetch(`/api/period-opening-balance/${currentActivePeriod}`);
        if (!previousRes.ok) throw new Error('No se pudieron cargar los saldos existentes.');
        const previous = await previousRes.json();
        const res = await fetch(`/api/period-opening-balance/${currentActivePeriod}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                opening_bank: bankAmount,
                opening_cash: cashAmount,
                opening_merchandise_value: previous.opening_merchandise_value || 0,
                opening_other_assets: previous.opening_other_assets || 0
            })
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Error al guardar');
        }
        
        currentPeriodOpeningBank = bankAmount;
        currentPeriodOpeningCash = cashAmount;
        
        closeModal('opening-cash-modal');
        await updateDashboard();
        await loadAccountingReport();
        alert('Saldos iniciales guardados para este período.');
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

function getExpenseFilterState() {
    return {
        search: (document.getElementById('exp-filter-search')?.value || '').trim().toLowerCase(),
        category: document.getElementById('exp-filter-category')?.value || '',
        expenseClass: document.getElementById('exp-filter-class')?.value || '',
        supplierId: document.getElementById('exp-filter-supplier')?.value || '',
        dateFrom: document.getElementById('exp-filter-date-from')?.value || '',
        dateTo: document.getElementById('exp-filter-date-to')?.value || '',
        periodOnly: !!document.getElementById('exp-filter-period')?.checked
    };
}

function expenseMatchesFilters(exp) {
    const f = getExpenseFilterState();
    if (f.periodOnly && currentActivePeriod && getExpensePeriod(exp) !== currentActivePeriod) return false;
    if (f.category && (exp.category || '') !== f.category) return false;
    if (f.expenseClass && getExpenseClass(exp.category) !== f.expenseClass) return false;
    if (f.supplierId && String(exp.supplier_id || '') !== String(f.supplierId)) return false;
    const d = String(exp.date || '').slice(0, 10);
    if (f.dateFrom && d < f.dateFrom) return false;
    if (f.dateTo && d > f.dateTo) return false;
    if (f.search) {
        const haystack = [
            exp.description,
            exp.category,
            exp.supplier_name,
            exp.invoice_number,
            exp.payment_method,
            exp.observation,
            getExpenseClass(exp.category)
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(f.search)) return false;
    }
    return true;
}

function populateExpenseFilterSelects() {
    const categories = [...new Set(expenses.map(e => e.category).filter(Boolean))]
        .sort((a, b) => String(a).localeCompare(String(b), 'es'));
    fillInvFilterSelect('exp-filter-category', categories.map(c => ({ value: c, label: c })), 'Todas las categorías');

    const supplierIds = new Set(expenses.map(e => e.supplier_id).filter(Boolean));
    const supplierOptions = suppliers
        .filter(s => supplierIds.has(String(s.id)) || supplierIds.has(Number(s.id)))
        .map(s => ({ value: String(s.id), label: s.name || String(s.id) }));
    suppliers.forEach(s => {
        if (!supplierOptions.some(o => o.value === String(s.id))) {
            supplierOptions.push({ value: String(s.id), label: s.name });
        }
    });
    supplierOptions.sort((a, b) => a.label.localeCompare(b.label, 'es'));
    fillInvFilterSelect('exp-filter-supplier', supplierOptions, 'Todos los proveedores');
}

function clearExpenseFilters() {
    ['exp-filter-search', 'exp-filter-category', 'exp-filter-class', 'exp-filter-supplier', 'exp-filter-date-from', 'exp-filter-date-to'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const periodChk = document.getElementById('exp-filter-period');
    if (periodChk) periodChk.checked = false;
    renderExpenses();
}

function populateExpenseSuppliers(selectedId) {
    const sel = document.getElementById('exp-supplier');
    if (!sel) return;
    const current = selectedId !== undefined ? selectedId : sel.value;
    sel.innerHTML = '<option value="">Sin proveedor / beneficiario</option>';
    suppliers.filter(s => s.status !== 'Inactivo' || String(s.id) === String(current)).forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        sel.appendChild(opt);
    });
    if (current && [...sel.options].some(o => String(o.value) === String(current))) sel.value = current;
}

function updateExpenseClassPreview() {
    const cat = document.getElementById('exp-category')?.value;
    const el = document.getElementById('exp-class-preview');
    if (!el) return;
    el.textContent = cat ? `Clase contable: ${getExpenseClass(cat)}` : 'Clase contable: —';
}

function buildExpenseHeaderFromForm() {
    const suppId = document.getElementById('exp-supplier')?.value || '';
    const supp = suppliers.find(s => String(s.id) === String(suppId));
    return {
        date: document.getElementById('exp-date').value,
        category: document.getElementById('exp-category').value,
        supplier_id: suppId || null,
        supplier_name: supp ? supp.name : null,
        invoice_number: document.getElementById('exp-invoice')?.value?.trim() || null,
        payment_method: document.getElementById('exp-payment-method')?.value || null,
        observation: document.getElementById('exp-obs')?.value?.trim() || null
    };
}

function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function onExpenseInvoiceFileSelected(event) {
    const file = event.target.files?.[0];
    const label = document.getElementById('exp-invoice-file-label');
    if (!label) return;
    if (file) {
        label.textContent = `Archivo seleccionado: ${file.name}`;
    } else {
        label.textContent = currentExpenseInvoiceFile ? 'Soporte adjunto disponible.' : 'Sin archivo adjunto.';
    }
}

function openExpenseModalForCreate() {
    if (isPeriodClosed(currentActivePeriod)) {
        alert(`El período de ${getMonthName(currentActivePeriod)} está CERRADO. No se pueden registrar gastos.`);
        return;
    }
    editingExpenseId = null;
    editingExpenseBatchId = null;
    currentExpenseItems = [];
    const form = document.getElementById('expenses-form');
    if (form) form.reset();
    document.getElementById('expense-modal-title').innerText = 'Registrar Gasto Administrativo / Operativo';
    const submitLabel = document.getElementById('expense-submit-label');
    if (submitLabel) submitLabel.textContent = 'Guardar gasto';
    const dateEl = document.getElementById('exp-date');
    if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);
    currentExpenseInvoiceFile = null;
    const fileInput = document.getElementById('exp-invoice-file');
    if (fileInput) fileInput.value = '';
    const fileLabel = document.getElementById('exp-invoice-file-label');
    if (fileLabel) fileLabel.textContent = 'Sin archivo adjunto.';
    populateExpenseSuppliers();
    updateExpenseClassPreview();
    renderExpenseItems();
    openModal('expenses-modal');
}

function editExpense(id) {
    const exp = expenses.find(e => String(e.id) === String(id));
    if (!exp) return alert('Gasto no encontrado');
    if (isPeriodClosed(getExpensePeriod(exp))) return alert('El período de este gasto está cerrado.');
    const lines = getExpenseBatchLines(exp);
    editingExpenseId = exp.id;
    editingExpenseBatchId = exp.expense_batch_id || null;
    currentExpenseItems = lines.map(line => ({
        description: line.line_description || line.description,
        quantity: Number(line.quantity) || 1,
        unit_price: line.unit_price != null ? Number(line.unit_price) : Number(line.amount) || 0,
        iva_percent: Number(line.iva_percent) || 0
    }));
    currentExpenseItems.forEach(recalcExpenseItemLine);

    document.getElementById('expense-modal-title').innerText = 'Editar Gasto (factura)';
    const submitLabel = document.getElementById('expense-submit-label');
    if (submitLabel) submitLabel.textContent = 'Guardar cambios';
    document.getElementById('exp-id').value = exp.id;
    document.getElementById('exp-date').value = exp.date || '';
    document.getElementById('exp-category').value = exp.category || '';
    document.getElementById('exp-invoice').value = exp.invoice_number || '';
    document.getElementById('exp-payment-method').value = exp.payment_method || 'Efectivo';
    document.getElementById('exp-obs').value = exp.observation || '';
    currentExpenseInvoiceFile = exp.invoice_file || null;
    const fileInput = document.getElementById('exp-invoice-file');
    if (fileInput) fileInput.value = '';
    const fileLabel = document.getElementById('exp-invoice-file-label');
    if (fileLabel) {
        fileLabel.textContent = exp.invoice_file ? 'Soporte adjunto disponible. Suba otro archivo para reemplazar.' : 'Sin archivo adjunto.';
    }
    populateExpenseSuppliers(exp.supplier_id);
    document.getElementById('exp-supplier').value = exp.supplier_id || '';
    updateExpenseClassPreview();
    renderExpenseItems();
    openModal('expenses-modal');
}

async function deleteExpense(id) {
    const exp = expenses.find(e => String(e.id) === String(id));
    if (!exp) return alert('Gasto no encontrado');
    if (isPeriodClosed(getExpensePeriod(exp))) return alert('El período está cerrado.');
    const batchLines = getExpenseBatchLines(exp);
    const msg = batchLines.length > 1
        ? `¿Eliminar esta factura/gasto completo (${batchLines.length} líneas)?`
        : '¿Eliminar este gasto?';
    if (!confirm(msg)) return;
    try {
        const res = await fetch(`/api/expenses/${id}`, { method: 'DELETE' });
        if (res.ok) {
            await refreshAllModules();
            alert('Gasto eliminado');
        } else {
            const err = await res.json();
            throw new Error(err.error || 'Error al eliminar');
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

function updateExpenseSummary() {
    const period = currentActivePeriod;
    const m = getFinancialMetrics(period);
    const totalEl = document.getElementById('exp-summary-total');
    const mercEl = document.getElementById('exp-summary-mercancia');
    if (totalEl) totalEl.innerText = currencyFormatter.format(m.opex);
    if (mercEl) mercEl.innerText = currencyFormatter.format(m.mercanciaPurchases);
    const warning = document.getElementById('expenses-period-warning');
    if (warning) warning.style.display = period && isPeriodClosed(period) ? 'flex' : 'none';
    document.querySelectorAll('#expenses .btn-period-dependent').forEach(btn => {
        const closed = period && isPeriodClosed(period);
        btn.disabled = closed;
        btn.style.opacity = closed ? 0.5 : 1;
        btn.style.cursor = closed ? 'not-allowed' : 'pointer';
    });
}

function getSaleTotal(sale) {
    const n = Number(sale.total);
    if (!isNaN(n) && n > 0) return n;
    if (Array.isArray(sale.items)) {
        return sale.items.reduce((s, i) => s + (Number(i.total) || 0), 0);
    }
    return (Number(sale.price) || 0) * (Number(sale.quantity) || 0);
}

async function updateDashboard() {
    const period = currentActivePeriod;
    await loadActivePeriodOpeningBalance();
    const m = getFinancialMetrics(period);

    const periodLabel = document.getElementById('dash-period-label');
    if (periodLabel) {
        periodLabel.textContent = period
            ? `Cifras del período activo: ${getMonthName(period)} (${period})`
            : 'Seleccione un período en el menú superior.';
    }

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = currencyFormatter.format(val); };
    setEl('dash-sales', m.salesRevenue);
    setEl('dash-cogs', m.cogs);
    setEl('dash-gross-profit', m.grossProfit);
    setEl('dash-expenses', m.opex);
    setEl('dash-utility', m.operatingProfit);

    const mercNote = document.getElementById('dash-mercancia-note');
    if (mercNote && period) {
        mercNote.textContent = `Compras de mercancía (Inventario → Entradas): ${currencyFormatter.format(m.mercanciaPurchases)}. No se suman a gastos operativos.`;
    }
    const openBankEl = document.getElementById('dash-opening-bank');
    const closeBankEl = document.getElementById('dash-closing-bank');
    const openCashEl = document.getElementById('dash-opening-cash');
    const closeCashEl = document.getElementById('dash-closing-cash');

    if (openBankEl) openBankEl.innerText = copFormatter.format(m.openingBank);
    if (closeBankEl) closeBankEl.innerText = copFormatter.format(m.estimatedBank);
    if (openCashEl) openCashEl.innerText = copFormatter.format(m.openingCash);
    if (closeCashEl) closeCashEl.innerText = copFormatter.format(m.estimatedCash);

    const salesTotalEl = document.getElementById('sales-total');
    if (salesTotalEl) salesTotalEl.innerText = currencyFormatter.format(m.salesRevenue);
    if (period) {
        document.getElementById('sales-month').innerText = currencyFormatter.format(m.salesRevenue);
        document.getElementById('net-profit-month').innerText = currencyFormatter.format(m.operatingProfit);
        const productMap = {};
        sales.filter(s => getSalePeriod(s) === period).forEach(s => {
            const name = s.product_name || s.product;
            if (name) productMap[name] = (productMap[name] || 0) + (s.quantity || 1);
        });
        const topProduct = Object.entries(productMap).sort((a, b) => b[1] - a[1])[0];
        document.getElementById('top-product-month').innerText = topProduct ? topProduct[0] : '-';
    }

    const ctx = document.getElementById('mainChart');
    if (!ctx) return;
    if (myChart) myChart.destroy();
    myChart = new Chart(ctx.getContext('2d'), {
        type: 'bar',
        data: {
            labels: ['Ingresos', 'COGS', 'Gastos OPEX', 'Utilidad operativa'],
            datasets: [{
                label: period ? `Período ${period}` : 'Período',
                data: [m.salesRevenue, m.cogs, m.opex, m.operatingProfit],
                backgroundColor: [
                    'rgba(0, 188, 212, 0.75)',
                    'rgba(245, 158, 11, 0.75)',
                    'rgba(239, 68, 68, 0.75)',
                    m.operatingProfit >= 0 ? 'rgba(16, 185, 129, 0.75)' : 'rgba(148, 163, 184, 0.75)'
                ],
                borderWidth: 1
            }]
        },
        options: {
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true } }
        }
    });
}

function exportExpensesToExcel() {
    if (!currentActivePeriod) return alert('Seleccione un período');
    const list = sortByDateDesc(expenses.filter(e => getExpensePeriod(e) === currentActivePeriod));
    const rows = list.map(e => {
        const qty = Number(e.quantity) || 1;
        const unitPrice = Number(e.unit_price) || 0;
        const subtotal = qty * unitPrice;
        const ivaAmt = Number(e.iva_amount) || 0;
        const ivaPct = Number(e.iva_percent) || 0;
        return {
            'Período': getExpensePeriod(e),
            'Fecha': e.date,
            'ID Lote': e.expense_batch_id || '',
            'Clase': getExpenseClass(e.category),
            'Categoría': e.category,
            'Proveedor': e.supplier_name || '',
            'Nro. Factura': e.invoice_number || '',
            'Concepto / Producto': e.line_description || e.description,
            'Cantidad': qty,
            'Precio unitario': unitPrice,
            'Subtotal': subtotal,
            'IVA %': ivaPct,
            'Valor IVA': ivaAmt,
            'Total línea': Number(e.amount) || 0,
            'Método de pago': e.payment_method || '',
            'Observación': e.observation || ''
        };
    });

    const wb = XLSX.utils.book_new();
    const m = getFinancialMetrics(currentActivePeriod);
    const summary = [{
        'Período': currentActivePeriod,
        'Total gastos operativos': list.reduce((s, e) => s + (Number(e.amount) || 0), 0),
        'Compras mercancía (referencia Inventario)': getMercanciaPurchasesTotal(currentActivePeriod),
        'Saldo inicial en Banco': m.openingBank,
        'Saldo inicial en Efectivo': m.openingCash,
        'Saldo final estimado Banco': m.estimatedBank,
        'Saldo final estimado Efectivo': m.estimatedCash
    }];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Resumen');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ Mensaje: 'Sin gastos en el período' }]), 'Gastos');
    XLSX.writeFile(wb, `gastos_${currentActivePeriod}.xlsx`);
}

function exportDashboardExcel() {
    if (!currentActivePeriod) return alert('Seleccione un período');
    const m = getFinancialMetrics(currentActivePeriod);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
        { Concepto: 'Período', Valor: currentActivePeriod },
        { Concepto: 'Ingresos por ventas', Valor: m.salesRevenue },
        { Concepto: 'Costo de ventas (COGS)', Valor: m.cogs },
        { Concepto: 'Utilidad bruta', Valor: m.grossProfit },
        { Concepto: 'Gastos operativos', Valor: m.opex },
        { Concepto: 'Utilidad operativa', Valor: m.operatingProfit },
        { Concepto: 'Compras mercancía (Inventario, referencia)', Valor: m.mercanciaPurchases },
        { Concepto: 'Saldo inicial en Banco', Valor: m.openingBank },
        { Concepto: 'Saldo inicial en Efectivo', Valor: m.openingCash },
        { Concepto: 'Saldo final estimado Banco', Valor: m.estimatedBank },
        { Concepto: 'Saldo final estimado Efectivo', Valor: m.estimatedCash }
    ]), 'Resultado');

    const byClass = {};
    expenses.filter(e => getExpensePeriod(e) === currentActivePeriod).forEach(e => {
        const cls = getExpenseClass(e.category);
        byClass[cls] = (byClass[cls] || 0) + (Number(e.amount) || 0);
    });
    const classRows = Object.entries(byClass).map(([Clase, Total]) => ({ Clase, Total }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(classRows.length ? classRows : [{ Nota: 'Sin gastos' }]), 'Gastos por clase');

    XLSX.writeFile(wb, `panel_financiero_${currentActivePeriod}.xlsx`);
}


function generatePDF(saleId) {
    const sale = sales.find(s => String(s.id) === String(saleId));
    if (!sale) return;
    const lines = getSaleBatchLines(sale);
    const client = clients.find(c => String(c.id) === String(sale.client));
    const clientName = client ? client.name : sale.client;
    let subtotalGeneral = 0;
    let ivaGeneral = 0;
    const tableBody = lines.map(line => {
        const qty = Number(line.quantity) || 0;
        const price = Number(line.price) || 0;
        const lineSubtotal = qty * price;
        const lineIva = Number(line.iva_amount) || 0;
        subtotalGeneral += lineSubtotal;
        ivaGeneral += lineIva;
        return [
            line.product_name,
            currencyFormatter.format(price),
            String(qty),
            currencyFormatter.format(lineSubtotal),
            `${Number(line.iva_percent) || 0}%`,
            currencyFormatter.format(lineIva),
            currencyFormatter.format(line.total)
        ];
    });
    const grandTotal = subtotalGeneral + ivaGeneral;

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text('LuMedix', 105, 18, { align: 'center' });
    doc.setFontSize(12);
    doc.text('Comprobante de Venta', 14, 32);
    doc.setFontSize(10);
    doc.text(`Fecha: ${sale.date}`, 14, 42);
    doc.text(`Cliente: ${clientName}`, 14, 49);
    if (sale.sale_invoice_number) {
        doc.text(`Factura DIAN: ${sale.sale_invoice_number}`, 14, 56);
    }
    doc.text(`Método de pago: ${sale.payment_method || ''}`, 14, sale.sale_invoice_number ? 63 : 56);
    doc.autoTable({
        startY: sale.sale_invoice_number ? 72 : 65,
        head: [['Producto', 'Precio Unit.', 'Cant.', 'Subtotal', 'IVA %', 'Valor IVA', 'Total']],
        body: tableBody,
        styles: { fontSize: 8 },
        headStyles: { fillColor: [13, 71, 161] }
    });
    const finalY = doc.lastAutoTable.finalY + 8;
    doc.text(`Subtotal: ${currencyFormatter.format(subtotalGeneral)}`, 14, finalY);
    doc.text(`Total IVA: ${currencyFormatter.format(ivaGeneral)}`, 14, finalY + 7);
    doc.setFont(undefined, 'bold');
    doc.text(`Total: ${currencyFormatter.format(grandTotal)}`, 14, finalY + 14);
    const safeName = String(clientName).replace(/[^\w.-]+/g, '_').slice(0, 40);
    doc.save(`Comprobante_LuMedix_${safeName}_${sale.date || sale.id}.pdf`);
}

function buildResumenKardexData() {
    const rows = [];
    const products = inventory.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));

    products.forEach(p => {
        const productMovs = inventoryMovements
            .filter(m => String(m.product_id) === String(p.id) && String(m.period) <= currentActivePeriod)
            .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.id - b.id));

        let saldo = 0;
        productMovs.filter(m => String(m.period) < currentActivePeriod).forEach(m => {
            const qty = Number(m.quantity) || 0;
            saldo += m.type === 'ENTRADA' ? qty : -qty;
        });

        rows.push({
            "Producto": p.name,
            "Código": p.code || "",
            "Fecha": "",
            "Tipo": "SALDO EN BANCO",
            "Motivo": "Saldo al inicio del período",
            "Entrada (uds)": "",
            "Salida (uds)": "",
            "Saldo (uds)": saldo
        });

        productMovs
            .filter(m => String(m.period) === currentActivePeriod)
            .forEach(m => {
                const qty = Number(m.quantity) || 0;
                const entrada = m.type === "ENTRADA" ? qty : "";
                const salida = m.type === "SALIDA" ? qty : "";
                saldo += m.type === "ENTRADA" ? qty : -qty;
                rows.push({
                    "Producto": p.name,
                    "Código": p.code || "",
                    "Fecha": m.date,
                    "Tipo": m.type,
                    "Motivo": m.reason || "",
                    "Entrada (uds)": entrada,
                    "Salida (uds)": salida,
                    "Saldo (uds)": saldo
                });
            });

        rows.push({
            "Producto": "",
            "Código": "",
            "Fecha": "",
            "Tipo": "",
            "Motivo": "",
            "Entrada (uds)": "",
            "Salida (uds)": "",
            "Saldo (uds)": ""
        });
    });

    return rows;
}

// Keep column headers even when a report has no records.
function excelReportSheet(rows, headers) {
    const sheet = XLSX.utils.json_to_sheet(rows, { header: headers });
    sheet['!cols'] = headers.map(header => ({ wch: rows.reduce((width, row) => Math.max(width, Math.min(50, String(row[header] ?? '').length)), Math.max(16, header.length + 2)) }));
    if (rows.length) sheet['!autofilter'] = { ref: sheet['!ref'] };
    return sheet;
}

function exportInventoryExcel() {
    if(!currentActivePeriod) return alert("Seleccione un período");
    const wb = XLSX.utils.book_new();

    const suppSheetData = suppliers.map(s => ({
        "Nombre": s.name,
        "Identificación": s.identification,
        "Contacto": s.contact,
        "Teléfono": s.phone,
        "Correo": s.email,
        "Ciudad": s.city,
        "Dirección": s.address || '',
        "Observación": s.observation || '',
        "Estado": s.status
    }));
    XLSX.utils.book_append_sheet(wb, excelReportSheet(suppSheetData, ["Nombre", "Identificación", "Contacto", "Teléfono", "Correo", "Ciudad", "Dirección", "Observación", "Estado"]), "Proveedores");

    const movsData = sortByDateDesc(inventoryMovements.filter(m => m.period === currentActivePeriod)).reverse().map(m => {
        const prod = inventory.find(p => String(p.id) === String(m.product_id));
        const supp = suppliers.find(s => String(s.id) === String(m.supplier_id));
        const cantidad = Number(m.quantity) || 0;
        const costoUnit = Number(m.unit_cost) || 0;
        return {
            "Fecha": m.date,
            "Tipo": m.type,
            "Motivo": m.reason,
            "Producto": prod ? prod.name : m.product_id,
            "Proveedor": m.supplier_name || (supp ? supp.name : ''),
            "NIT Proveedor": supp ? supp.identification : '',
            "Factura": m.invoice_number || '',
            "Cantidad": m.quantity,
            "Costo Unit.": m.unit_cost,
            "Subtotal": cantidad * costoUnit,
            "IVA %": m.iva_percent || 0,
            "Valor IVA": m.iva_amount || 0,
            "Total": m.total,
            "Observación": m.observation || ''
        };
    });
    const movementHeaders = ["Fecha", "Tipo", "Motivo", "Producto", "Proveedor", "NIT Proveedor", "Factura", "Cantidad", "Costo Unit.", "Subtotal", "IVA %", "Valor IVA", "Total", "Observación"];
    const purchasesData = movsData.filter(m => m.Tipo === 'ENTRADA' && m.Motivo === 'Compra');
    XLSX.utils.book_append_sheet(wb, excelReportSheet(purchasesData, movementHeaders), "Compras");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(buildResumenKardexData()), "Resumen");
    XLSX.utils.book_append_sheet(wb, excelReportSheet(movsData, movementHeaders), "Movimientos");

    XLSX.writeFile(wb, `inventario_${currentActivePeriod}.xlsx`);
}

function renderSuppliersTable(tableSelector, typeFilter) {
    const tbody = document.querySelector(`${tableSelector} tbody`);
    if (!tbody) return;
    tbody.innerHTML = '';
    const visibleSuppliers = suppliers.filter(s => {
        if (!typeFilter) return true;
        if (!s.supplier_type) return typeFilter === 'inventory';
        return s.supplier_type === typeFilter;
    });
    visibleSuppliers.forEach(s => {
        const tr = document.createElement('tr');
        const statusClass = s.status === 'Activo' ? 'success' : 'danger';
        tr.innerHTML = `
            <td>${escapeHtml(s.name)}</td>
            <td>${escapeHtml(s.identification || '')}</td>
            <td>${escapeHtml(s.contact || '')}</td>
            <td>${escapeHtml(s.phone || '')}</td>
            <td>${escapeHtml(s.email || '')}</td>
            <td>${escapeHtml(s.city || '')}</td>
            <td style="color: var(--${escapeHtml(statusClass)}); font-weight: bold;">${escapeHtml(s.status)}</td>
            <td>
                <button class="btn btn-primary btn-small" onclick="editSupplier(${Number(s.id)})" title="Editar"><i class="fas fa-edit"></i></button>
                <button class="btn btn-warning btn-small" onclick="toggleSupplierStatus(${Number(s.id)})" title="${escapeHtml(s.status === 'Activo' ? 'Inactivar' : 'Activar')}"><i class="fas fa-${escapeHtml(s.status === 'Activo' ? 'ban' : 'check')}"></i></button>
                <button class="btn btn-danger btn-small" onclick="deleteSupplier(${Number(s.id)})" title="Eliminar"><i class="fas fa-trash"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function renderSuppliers() {
    renderSuppliersTable('#suppliers-table', 'inventory');
    renderSuppliersTable('#exp-suppliers-table', 'expense');
}

function populateSuppliers(selectId, typeFilter) {
    const select = document.getElementById(selectId);
    if(!select) return;
    const currentVal = select.value;
    select.innerHTML = '<option value="">Seleccione un proveedor</option>';
    const actives = suppliers.filter(s => (s.status === 'Activo' || String(s.id) === String(currentVal)) && (!typeFilter || s.supplier_type === typeFilter || (!s.supplier_type && typeFilter === 'inventory')));
    actives.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        select.appendChild(opt);
    });
    if (currentVal) select.value = currentVal;
}

async function handleSupplierSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('supp-id').value;
    const item = {
        name: document.getElementById('supp-name').value,
        identification: document.getElementById('supp-nit').value,
        contact: document.getElementById('supp-contact').value,
        phone: document.getElementById('supp-phone').value,
        email: document.getElementById('supp-email').value,
        address: document.getElementById('supp-address').value,
        city: document.getElementById('supp-city').value,
        observation: document.getElementById('supp-obs').value,
        supplier_type: document.getElementById('supp-type').value || 'inventory',
        status: document.getElementById('supp-status').value
    };

    try {
        const saved = await persistRecord('suppliers', id, item);
        if (!id && saved.id) document.getElementById('supp-id').value = saved.id;
        await refreshAllModules();
        closeModal('supplier-modal');
        e.target.reset();
        document.getElementById('supp-id').value = '';
    } catch (error) {
        alert(error.saved ? 'El cambio se guardó en la base de datos, pero no se pudo actualizar la pantalla. Recargue la aplicación.' : 'No se guardaron los cambios: ' + error.message);
    }
}

function editSupplier(id) {
    const s = suppliers.find(supp => String(supp.id) === String(id));
    if(!s) return;
    document.getElementById('supp-id').value = s.id;
    document.getElementById('supp-name').value = s.name;
    document.getElementById('supp-nit').value = s.identification || '';
    document.getElementById('supp-contact').value = s.contact || '';
    document.getElementById('supp-phone').value = s.phone || '';
    document.getElementById('supp-email').value = s.email || '';
    document.getElementById('supp-address').value = s.address || '';
    document.getElementById('supp-city').value = s.city || '';
    document.getElementById('supp-obs').value = s.observation || '';
    document.getElementById('supp-type').value = s.supplier_type || 'inventory';
    document.getElementById('supp-status').value = s.status || 'Activo';
    document.getElementById('supplier-modal-title').innerText = "Editar Proveedor";
    openModal('supplier-modal');
}

async function deleteSupplier(id) {
    if (!confirm("Â¿EstÃ¡s seguro de que deseas eliminar este proveedor?")) return;
    
    try {
        const res = await fetch(`/api/suppliers/${id}`, { method: 'DELETE' });
        if(res.ok) {
            suppliers = suppliers.filter(s => String(s.id) !== String(id));
        } else {
            const errData = await res.json();
            alert(errData.error || "Error al eliminar");
            return;
        }
    } catch(e) {
        return alert('No se guardó la eliminación: ' + e.message);
    }
    renderSuppliers();
    populateSuppliers('ent-supplier', 'inventory');
    populateExpenseSuppliers();
}

async function toggleSupplierStatus(id) {
    const record = suppliers.find(row => String(row.id) === String(id));
    if (!record) return;
    const status = record.status === 'Activo' ? 'Inactivo' : 'Activo';
    if (!confirm(`¿Deseas cambiar el estado de ${record.name} a ${status}?`)) return;
    try {
        await persistRecord('suppliers', id, { ...record, status });
        await refreshAllModules();
    } catch (error) { alert('No se guardó el estado: ' + error.message); }
}

function renderClients() {
    const tbody = document.querySelector('#clients-table tbody');
    if(!tbody) return;
    tbody.innerHTML = '';
    clients.forEach(c => {
        const tr = document.createElement('tr');
        const statusClass = c.status === 'Activo' ? 'success' : 'danger';
        tr.innerHTML = `
            <td>${escapeHtml(c.name)}</td>
            <td>${escapeHtml(c.identification || '')}</td>
            <td>${escapeHtml(c.contact || '')}</td>
            <td>${escapeHtml(c.phone || '')}</td>
            <td>${escapeHtml(c.email || '')}</td>
            <td>${escapeHtml(c.address || '')}</td>
            <td>${escapeHtml(c.city || '')}</td>
            <td style="color: var(--${escapeHtml(statusClass)}); font-weight: bold;">${escapeHtml(c.status)}</td>
            <td>
                <button class="btn btn-primary btn-small" onclick="editClient(${Number(c.id)})" title="Editar"><i class="fas fa-edit"></i></button>
                <button class="btn btn-warning btn-small" onclick="toggleClientStatus(${Number(c.id)})" title="${escapeHtml(c.status === 'Activo' ? 'Inactivar' : 'Activar')}"><i class="fas fa-${escapeHtml(c.status === 'Activo' ? 'ban' : 'check')}"></i></button>
                <button class="btn btn-danger btn-small" onclick="deleteClient(${Number(c.id)})" title="Eliminar"><i class="fas fa-trash"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });
    populateClients('sale-client');
}

function populateClients(selectId) {
    const select = document.getElementById(selectId);
    if(!select) return;
    const currentVal = select.value;
    select.innerHTML = '<option value="">Seleccione un cliente</option>';
    const actives = clients.filter(c => c.status === 'Activo' || String(c.id) === String(currentVal));
    actives.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        select.appendChild(opt);
    });
    if (currentVal) select.value = currentVal;
}

async function handleClientSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('cli-id').value;
    const item = {
        name: document.getElementById('cli-name').value,
        identification: document.getElementById('cli-nit').value,
        contact: document.getElementById('cli-contact').value,
        phone: document.getElementById('cli-phone').value,
        email: document.getElementById('cli-email').value,
        address: document.getElementById('cli-address').value,
        city: document.getElementById('cli-city').value,
        observation: document.getElementById('cli-obs').value,
        status: document.getElementById('cli-status').value
    };

    try {
        const saved = await persistRecord('clients', id, item);
        if (!id && saved.id) document.getElementById('cli-id').value = saved.id;
        await refreshAllModules();
        closeModal('client-modal');
        e.target.reset();
        document.getElementById('cli-id').value = '';
    } catch (error) {
        alert(error.saved ? 'El cambio se guardó en la base de datos, pero no se pudo actualizar la pantalla. Recargue la aplicación.' : 'No se guardaron los cambios: ' + error.message);
    }
}

function editClient(id) {
    const isClosed = isPeriodClosed(currentActivePeriod);
    if(isClosed) return alert("El período actual está cerrado. No se puede editar información.");

    const c = clients.find(cli => String(cli.id) === String(id));
    if(!c) return;
    document.getElementById('cli-id').value = c.id;
    document.getElementById('cli-name').value = c.name;
    document.getElementById('cli-nit').value = c.identification || '';
    document.getElementById('cli-contact').value = c.contact || '';
    document.getElementById('cli-phone').value = c.phone || '';
    document.getElementById('cli-email').value = c.email || '';
    document.getElementById('cli-address').value = c.address || '';
    document.getElementById('cli-city').value = c.city || '';
    document.getElementById('cli-obs').value = c.observation || '';
    document.getElementById('cli-status').value = c.status || 'Activo';
    document.getElementById('client-modal-title').innerText = "Editar Cliente";
    openModal('client-modal');
}

async function deleteClient(id) {
    const isClosed = isPeriodClosed(currentActivePeriod);
    if(isClosed) return alert("El período actual está cerrado. No se pueden eliminar clientes.");

    const hasSales = sales.some(s => String(s.client) === String(id) || s.client === clients.find(c => String(c.id) === String(id))?.name);
    if (hasSales) {
        if(confirm("Este cliente tiene ventas registradas en el historial. No se recomienda eliminarlo. ¿Deseas marcarlo como Inactivo en su lugar?")) {
            return toggleClientStatus(id);
        }
        return;
    }

    if (!confirm("¿Estás seguro de que deseas eliminar este cliente?")) return;
    try {
        const res = await fetch(`/api/clients/${id}`, { method: 'DELETE' });
        if(res.ok) {
            clients = clients.filter(c => String(c.id) !== String(id));
        } else {
            const errData = await res.json();
            alert(errData.error || "Error al eliminar");
            return;
        }
    } catch(e) {
        return alert('No se guardó la eliminación: ' + e.message);
    }
    renderClients();
}

async function toggleClientStatus(id) {
    const record = clients.find(row => String(row.id) === String(id));
    if (!record) return;
    const status = record.status === 'Activo' ? 'Inactivo' : 'Activo';
    if (!confirm(`¿Deseas cambiar el estado de ${record.name} a ${status}?`)) return;
    try {
        await persistRecord('clients', id, { ...record, status });
        await refreshAllModules();
    } catch (error) { alert('No se guardó el estado: ' + error.message); }
}

async function deleteEntrada(id) {
    const mov = inventoryMovements.find(m => String(m.id) === String(id));
    if (mov && isPeriodClosed(mov.period)) return alert("El período de esta entrada está cerrado.");
    if (!confirm("¿Estás seguro de que deseas eliminar esta entrada de inventario? El stock se ajustará automáticamente.")) return;
    try {
        const res = await fetch(`/api/inventory_movements/${id}`, { method: 'DELETE' });
        if (res.ok) {
            await refreshAllModules();
        } else {
            const err = await res.json();
            alert("Error: " + (err.error || 'No se pudo eliminar'));
        }
    } catch (e) {
        alert("Error de conexión: No se pudo eliminar el registro.");
    }
}

async function deleteSalida(id) {
    const mov = inventoryMovements.find(m => String(m.id) === String(id));
    if (mov && isPeriodClosed(mov.period)) return alert("El período de esta salida está cerrado.");
    if (!confirm("¿Estás seguro de que deseas eliminar esta salida de inventario? El stock se ajustará automáticamente.")) return;
    try {
        const res = await fetch(`/api/inventory_movements/${id}`, { method: 'DELETE' });
        if (res.ok) {
            await refreshAllModules();
        } else {
            const err = await res.json();
            alert("Error: " + (err.error || 'No se pudo eliminar'));
        }
    } catch (e) {
        alert("Error de conexión: No se pudo eliminar el registro.");
    }
}

async function deleteProduct(id) {
    const isClosed = isPeriodClosed(currentActivePeriod);
    if(isClosed) return alert("El perÃ­odo actual estÃ¡ cerrado.");

    // CondiciÃ³n 1: Verificar si otros meses estÃ¡n abiertos
    const otherOpen = periods.filter(p => p.month !== currentActivePeriod && p.status === 'ABIERTO');
    if (otherOpen.length > 0) {
        alert("AtenciÃ³n: Existen otros perÃ­odos abiertos. Para mantener la integridad, se recomienda cerrar los perÃ­odos anteriores antes de realizar eliminaciones definitivas.");
    }

    // CondiciÃ³n 2: Verificar si tiene movimientos en el mes actual
    const hasMovementsInPeriod = inventoryMovements.some(m => String(m.product_id) === String(id) && m.period === currentActivePeriod);
    if (hasMovementsInPeriod) {
        return alert("No se puede eliminar el producto porque ya tiene ventas, entradas o gastos registrados en el perÃ­odo actual.");
    }

    // CondiciÃ³n General: Si tiene historial en otros meses, no deberÃ­amos borrarlo fÃ­sicamente para no romper los reportes pasados.
    const hasAnyHistory = inventoryMovements.some(m => String(m.product_id) === String(id));
    if (hasAnyHistory) {
        if (confirm("Este producto tiene historial en otros perÃ­odos. No se puede eliminar fÃ­sicamente para no romper la integridad de los reportes pasados. Â¿Deseas marcarlo como INACTIVO en su lugar?")) {
            const item = inventory.find(i => String(i.id) === String(id));
            if (item) {

                try {
                    await persistRecord('inventory', id, { ...item, status: 'Inactivo' });
                    await refreshAllModules();
                } catch (error) { return alert('No se guardó el estado: ' + error.message); }
                renderInventoryModule();
                return;
            }
        }
        return;
    }

    if (!confirm("Â¿EstÃ¡s seguro de que deseas eliminar este producto permanentemente? Esta acciÃ³n no se puede deshacer.")) return;

    try {
        const res = await fetch(`/api/inventory/${id}`, { method: 'DELETE' });
        if (res.ok) {
            inventory = inventory.filter(i => String(i.id) !== String(id));
        } else throw new Error();
    } catch(e) {
        return alert('No se guardó la eliminación: ' + e.message);
    }
    renderInventoryModule();
}

function exportSalesToExcel() {



    const clientsData = clients.map(c => ({
        "Nombre / Razón Social": c.name,
        "NIT / Identificación": c.identification || '',
        "Contacto": c.contact || '',
        "Teléfono": c.phone || '',
        "Correo": c.email || '',
        "Dirección": c.address || '',
        "Ciudad": c.city || '',
        "Observación": c.observation || '',
        "Estado": c.status || 'Activo'
    }));

    const salesData = getVisibleSales().map(s => {
        const c = clients.find(cli => String(cli.id) === String(s.client));
        const clientName = c ? c.name : s.client;
        const cantidad = Number(s.quantity) || 0;
        const precioUnit = Number(s.price) || 0;
        const subtotal = cantidad * precioUnit;
        const ivaPercent = Number(s.iva_percent) || 0;
        const valorIva = Number(s.iva_amount) || 0;
        return {
            "Período": getSalePeriod(s),
            "Fecha": s.date,
            "ID Venta": s.id,
            "Cliente": clientName,
            "Producto": s.product_name,
            "Cantidad": s.quantity,
            "Precio Unitario": s.price,
            "Subtotal": subtotal,
            "IVA %": ivaPercent,
            "Valor IVA": valorIva,
            "Total": s.total,
            "Método de Pago": s.payment_method || '',
            "Observación": s.observation || '',
            "Retención %": Number(s.retention_percent) || 0
        };
    });

    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(wb, excelReportSheet(clientsData, ["Nombre / Razón Social", "NIT / Identificación", "Contacto", "Teléfono", "Correo", "Dirección", "Ciudad", "Observación", "Estado"]), "Clientes");
    XLSX.utils.book_append_sheet(wb, excelReportSheet(salesData, ["Período", "Fecha", "ID Venta", "Cliente", "Producto", "Cantidad", "Precio Unitario", "Subtotal", "IVA %", "Valor IVA", "Total", "Método de Pago", "Observación", "Retención %"]), "Ventas");
    const periodLabel = getSaleFilterState('ven').periodOnly && currentActivePeriod ? currentActivePeriod : 'todos_los_periodos';
    XLSX.writeFile(wb, `ventas_${periodLabel}.xlsx`);
}

// ========================
// Accounting Report Functions
// ========================

async function loadAccountingReport() {
    try {
        if (!currentActivePeriod) {
            document.querySelector('#accounting-report').style.display = 'none';
            return;
        }

        const response = await fetch(`/api/accounting-report?period=${currentActivePeriod}`);
        if (!response.ok) throw new Error('Error cargando informe');
        
        const report = await response.json();
        renderAccountingReport(report);
    } catch (error) {
        console.error('Error loading accounting report:', error);
        alert('Error cargando el informe contable: ' + error.message);
    }
}

function renderAccountingReport(report) {
    // Period info
    document.getElementById('report-period-badge').textContent = report.period;
    document.getElementById('rpt-period-label').textContent = report.period;
    document.getElementById('rpt-generated-date').textContent = report.statement_date;

    // Opening Balance
    const opening = report.opening_balance;
    if (document.getElementById('rpt-opening-bank')) document.getElementById('rpt-opening-bank').textContent = copFormatter.format(opening.opening_bank || 0);
    if (document.getElementById('rpt-opening-cash')) document.getElementById('rpt-opening-cash').textContent = copFormatter.format(opening.opening_cash || 0);
    document.getElementById('rpt-opening-merchandise').textContent = copFormatter.format(opening.opening_merchandise_value);
    document.getElementById('rpt-opening-other').textContent = copFormatter.format(opening.opening_other_assets);
    document.getElementById('rpt-opening-total').textContent = copFormatter.format(opening.opening_total);

    // Revenue
    const revenue = report.revenue;
    document.getElementById('rpt-sales-subtotal').textContent = copFormatter.format(revenue.sales_subtotal);
    document.getElementById('rpt-sales-tax-collected').textContent = copFormatter.format(revenue.sales_tax_collected);
    document.getElementById('rpt-sales-total').textContent = copFormatter.format(revenue.sales_total_with_tax);

    // COGS
    const cogs = report.cogs_section;
    document.getElementById('rpt-cogs').textContent = copFormatter.format(cogs.purchases_of_merchandise);
    document.getElementById('rpt-purchase-tax').textContent = copFormatter.format(cogs.purchase_tax_paid);
    document.getElementById('rpt-ending-inventory').textContent = copFormatter.format(cogs.ending_inventory_value);

    // Gross Profit
    document.getElementById('rpt-gross-profit').textContent = copFormatter.format(report.gross_profit);

    // Operating Expenses
    const expenses = report.operating_expenses;
    let expensesHtml = '';
    if (expenses.by_category && expenses.by_category.length > 0) {
        expenses.by_category.forEach(cat => {
            expensesHtml += `
                <div class="report-row">
                    <span>${escapeHtml(cat.category)}:</span>
                    <span>${escapeHtml(copFormatter.format(cat.amount))}</span>
                </div>
            `;
        });
    }
    document.getElementById('report-expenses-list').innerHTML = expensesHtml;
    document.getElementById('rpt-expense-tax').textContent = copFormatter.format(expenses.expenses_tax_paid);
    document.getElementById('rpt-total-expenses').textContent = copFormatter.format(expenses.total_expenses);

    // Operating Profit
    document.getElementById('rpt-operating-profit').textContent = copFormatter.format(report.operating_profit);

    // Tax Summary
    const taxes = report.tax_summary;
    document.getElementById('rpt-tax-collected').textContent = copFormatter.format(taxes.sales_tax_collected);
    document.getElementById('rpt-tax-purchase').textContent = copFormatter.format(taxes.purchase_tax_paid);
    document.getElementById('rpt-tax-expense').textContent = copFormatter.format(taxes.expense_tax_paid);
    document.getElementById('rpt-net-tax').textContent = copFormatter.format(taxes.net_tax_position);

    // Cash Position
    const cash = report.cash_position;
    if (document.getElementById('rpt-bank-opening')) document.getElementById('rpt-bank-opening').textContent = copFormatter.format(cash.opening_bank || 0);
    if (document.getElementById('rpt-bank-inflows')) document.getElementById('rpt-bank-inflows').textContent = copFormatter.format(cash.bank_inflows || 0);
    if (document.getElementById('rpt-bank-outflows')) document.getElementById('rpt-bank-outflows').textContent = copFormatter.format(cash.bank_outflows || 0);
    if (document.getElementById('rpt-bank-closing')) document.getElementById('rpt-bank-closing').textContent = copFormatter.format(cash.closing_bank || 0);

    document.getElementById('rpt-cash-opening').textContent = copFormatter.format(cash.opening_cash || 0);
    document.getElementById('rpt-cash-inflows').textContent = copFormatter.format(cash.cash_inflows || 0);
    document.getElementById('rpt-cash-outflows').textContent = copFormatter.format(cash.cash_outflows || 0);
    document.getElementById('rpt-cash-closing').textContent = copFormatter.format(cash.closing_cash || 0);

    // Summary
    const summary = report.summary;
    document.getElementById('rpt-sum-sales').textContent = copFormatter.format(summary.total_sales);
    document.getElementById('rpt-sum-purchases').textContent = copFormatter.format(summary.total_cogs);
    document.getElementById('rpt-sum-gross').textContent = copFormatter.format(summary.gross_profit);
    document.getElementById('rpt-sum-expenses').textContent = copFormatter.format(summary.total_expenses);
    document.getElementById('rpt-sum-net').textContent = copFormatter.format(summary.net_income);

    // Update opening balance form
    if (document.getElementById('report-opening-bank')) document.getElementById('report-opening-bank').value = opening.opening_bank || 0;
    document.getElementById('report-opening-cash').value = opening.opening_cash || 0;
    document.getElementById('report-opening-merchandise').value = opening.opening_merchandise_value || 0;
    document.getElementById('report-opening-other').value = opening.opening_other_assets || 0;
}

async function saveOpeningBalance() {
    try {
        if (!currentActivePeriod) {
            alert('Selecciona un período primero');
            return;
        }

        const openingBank = Number(document.getElementById('report-opening-bank')?.value) || 0;
        const openingCash = Number(document.getElementById('report-opening-cash').value) || 0;
        const openingMerchandise = Number(document.getElementById('report-opening-merchandise').value) || 0;
        const openingOther = Number(document.getElementById('report-opening-other').value) || 0;

        const response = await fetch(`/api/period-opening-balance/${currentActivePeriod}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                opening_bank: openingBank,
                opening_cash: openingCash,
                opening_merchandise_value: openingMerchandise,
                opening_other_assets: openingOther
            })
        });

        if (!response.ok) throw new Error('Error guardando saldo inicial');
        
        const result = await response.json();
        alert('Saldo inicial guardado correctamente');
        await loadActivePeriodOpeningBalance();
        await updateDashboard();
        await loadAccountingReport();
    } catch (error) {
        console.error('Error saving opening balance:', error);
        alert('Error: ' + error.message);
    }
}

async function exportReportExcel() {
    try {
        if (!currentActivePeriod) {
            alert('Selecciona un período primero');
            return;
        }

        // Fetch data directly from API to ensure all values are present
        const response = await fetch(`/api/accounting-report?period=${currentActivePeriod}`);
        if (!response.ok) throw new Error('Error obteniendo datos del informe');
        const r = await response.json();

        const fmt = (v) => Number(v || 0).toFixed(2);
        const opening  = r.opening_balance  || {};
        const revenue  = r.revenue          || {};
        const cogsS    = r.cogs_section     || {};
        const opExp    = r.operating_expenses || {};
        const taxes    = r.tax_summary      || {};
        const cash     = r.cash_position    || {};

        const wb = XLSX.utils.book_new();

        const reportData = [
            ['INFORME CONTABLE INTEGRAL', r.period],
            ['Fecha de Generación:', r.statement_date],
            [],
            ['══ SALDO INICIAL DEL PERÍODO ══', ''],
            ['Saldo en Banco (inicio mes):', fmt(opening.opening_bank)],
            ['Saldo en Efectivo (inicio mes):', fmt(opening.opening_cash)],
            ['Mercancía:', fmt(opening.opening_merchandise_value)],
            ['Otros Activos:', fmt(opening.opening_other_assets)],
            ['Total Inicial:', fmt(opening.opening_total)],
            [],
            ['══ INGRESOS ══', ''],
            ['Ventas (Subtotal sin IVA):', fmt(revenue.sales_subtotal)],
            ['IVA Cobrado:', fmt(revenue.sales_tax_collected)],
            ['Total Ingresos (con IVA):', fmt(revenue.sales_total_with_tax)],
            [],
            ['══ COSTO DE VENTAS ══', ''],
            ['Compras de Mercancía:', fmt(cogsS.purchases_of_merchandise)],
            ['IVA en Compras:', fmt(cogsS.purchase_tax_paid)],
            ['Inventario Final (valor actual):', fmt(cogsS.ending_inventory_value)],
            [],
            ['UTILIDAD BRUTA:', fmt(r.gross_profit)],
            [],
            ['══ GASTOS OPERATIVOS ══', ''],
            ...(opExp.by_category || []).map(c => [`  ${c.category}:`, fmt(c.amount)]),
            ['IVA en Gastos:', fmt(opExp.expenses_tax_paid)],
            ['Total Gastos:', fmt(opExp.total_expenses)],
            [],
            ['UTILIDAD OPERATIVA:', fmt(r.operating_profit)],
            [],
            ['══ RESUMEN FISCAL (IVA) ══', ''],
            ['IVA Cobrado en Ventas:', fmt(taxes.sales_tax_collected)],
            ['IVA Pagado en Compras:', fmt(taxes.purchase_tax_paid)],
            ['IVA Pagado en Gastos:', fmt(taxes.expense_tax_paid)],
            ['IVA Neto (a pagar / a favor):', fmt(taxes.net_tax_position)],
            [],
            ['══ FLUJO DE CAJA — BANCO ══', ''],
            ['Saldo Inicial Banco:', fmt(cash.opening_bank)],
            ['(+) Entradas Banco (ventas):', fmt(cash.bank_inflows)],
            ['(-) Salidas Banco (gastos + compras):', fmt(cash.bank_outflows)],
            ['Saldo Final Banco:', fmt(cash.closing_bank)],
            [],
            ['══ FLUJO DE CAJA — EFECTIVO ══', ''],
            ['Saldo Inicial Efectivo:', fmt(cash.opening_cash)],
            ['(+) Entradas Efectivo (ventas):', fmt(cash.cash_inflows)],
            ['(-) Salidas Efectivo (gastos + compras):', fmt(cash.cash_outflows)],
            ['Saldo Final Efectivo:', fmt(cash.closing_cash)],
        ];

        const ws = XLSX.utils.aoa_to_sheet(reportData);
        // Auto-width columns
        ws['!cols'] = [{ wch: 40 }, { wch: 18 }];
        XLSX.utils.book_append_sheet(wb, ws, 'Informe Contable');
        XLSX.writeFile(wb, `informe_contable_${currentActivePeriod}.xlsx`);
    } catch (error) {
        console.error('Error exporting report:', error);
        alert('Error exportando: ' + error.message);
    }
}

function exportReportPDF() {
    try {
        if (!currentActivePeriod) {
            alert('Selecciona un período primero');
            return;
        }

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        
        doc.setFontSize(16);
        doc.text('INFORME CONTABLE INTEGRAL', 20, 15);
        doc.setFontSize(10);
        doc.text(`Período: ${currentActivePeriod}`, 20, 22);
        doc.text(`Generado: ${new Date().toISOString().split('T')[0]}`, 20, 28);
        
        let yPos = 35;
        const lineHeight = 5;
        
        const addSection = (title, rows) => {
            doc.setFontSize(11);
            doc.setFont(undefined, 'bold');
            doc.text(title, 20, yPos);
            yPos += lineHeight + 2;
            
            doc.setFontSize(9);
            doc.setFont(undefined, 'normal');
            rows.forEach(row => {
                doc.text(`${row.label}: ${row.value}`, 25, yPos);
                yPos += lineHeight;
            });
            yPos += lineHeight;
        };

        // Add sections
        addSection('SALDO INICIAL', [
            { label: 'Saldo en Banco', value: document.getElementById('rpt-opening-bank')?.textContent || '$0.00' },
            { label: 'Saldo en Efectivo', value: document.getElementById('rpt-opening-cash')?.textContent || '$0.00' },
            { label: 'Mercancía', value: document.getElementById('rpt-opening-merchandise').textContent },
            { label: 'Total Inicial', value: document.getElementById('rpt-opening-total').textContent }
        ]);

        addSection('INGRESOS', [
            { label: 'Ventas', value: document.getElementById('rpt-sales-subtotal').textContent },
            { label: 'Total Ingresos', value: document.getElementById('rpt-sales-total').textContent }
        ]);

        addSection('COSTO DE VENTAS', [
            { label: 'Compras', value: document.getElementById('rpt-cogs').textContent },
            { label: 'Utilidad Bruta', value: document.getElementById('rpt-gross-profit').textContent }
        ]);

        addSection('GASTOS OPERATIVOS', [
            { label: 'Total Gastos', value: document.getElementById('rpt-total-expenses').textContent },
            { label: 'Utilidad Operativa', value: document.getElementById('rpt-operating-profit').textContent }
        ]);

        addSection('FLUJO DE CAJA BANCO', [
            { label: 'Saldo Inicial Banco', value: document.getElementById('rpt-bank-opening')?.textContent || '$0.00' },
            { label: 'Saldo Final Banco Estimado', value: document.getElementById('rpt-bank-closing')?.textContent || '$0.00' }
        ]);

        addSection('FLUJO DE CAJA EFECTIVO', [
            { label: 'Saldo Inicial Efectivo', value: document.getElementById('rpt-cash-opening')?.textContent || '$0.00' },
            { label: 'Saldo Final Efectivo Estimado', value: document.getElementById('rpt-cash-closing')?.textContent || '$0.00' }
        ]);

        doc.save(`informe_contable_${currentActivePeriod}.pdf`);
    } catch (error) {
        console.error('Error exporting PDF:', error);
        alert('Error exportando PDF: ' + error.message);
    }
}

// JSON para manejadores existentes; escape de atributo HTML por separado.
function htmlJsArg(value) { return escapeHtml(JSON.stringify(String(value)).replace(/</g, "\\u003c")); }
