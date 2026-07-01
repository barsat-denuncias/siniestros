const URL_API = "https://ojsjxyxvcznoydhzhsrt.supabase.co";
const KEY_API = "sb_publishable__4dVId8Vbc2lsHIZrhzoMA_sRnfpxuh";

// Cliente de Supabase con persistencia de sesion en localStorage.
const sb = supabase.createClient(URL_API, KEY_API, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
    }
});

let datosGlobales = [];
let chartMeses = null;
let chartProvincias = null;

// ============================================================================
// BOOTSTRAP: chequear sesion al cargar la pagina
// ============================================================================
async function init() {
    const { data: { session } } = await sb.auth.getSession();
    if (session && session.user) {
        mostrarAdmin(session.user);
    } else {
        mostrarLogin();
    }
}

function mostrarLogin() {
    document.getElementById('pantalla-login').classList.remove('hidden');
    document.getElementById('pantalla-admin').classList.add('hidden');
}

function mostrarAdmin(user) {
    document.getElementById('pantalla-login').classList.add('hidden');
    document.getElementById('pantalla-admin').classList.remove('hidden');
    document.getElementById('user-email').innerText = user.email;
    cargarDatos();
}

// ============================================================================
// LOGIN
// ============================================================================
document.getElementById('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const btn = e.target.querySelector('button');
    const errEl = document.getElementById('login-error');

    btn.innerText = "Entrando..."; btn.disabled = true;
    errEl.innerText = "";

    const { data, error } = await sb.auth.signInWithPassword({ email, password });

    btn.innerText = "Iniciar sesión"; btn.disabled = false;

    if (error) {
        errEl.innerText = error.message === 'Invalid login credentials'
            ? "Email o contraseña incorrectos."
            : "Error: " + error.message;
        return;
    }

    mostrarAdmin(data.user);
});

async function signOut() {
    await sb.auth.signOut();
    document.getElementById('login-password').value = "";
    mostrarLogin();
}

// ============================================================================
// CAMBIO DE CONTRASEÑA
// ============================================================================
function abrirCambioPass() {
    document.getElementById('modal-pass').classList.remove('hidden');
    document.getElementById('pass-status').innerText = "";
    document.getElementById('new-pass').value = "";
    document.getElementById('confirm-pass').value = "";
}

function cerrarCambioPass() {
    document.getElementById('modal-pass').classList.add('hidden');
}

async function guardarNuevaPass() {
    const newPass = document.getElementById('new-pass').value;
    const confirmPass = document.getElementById('confirm-pass').value;
    const status = document.getElementById('pass-status');

    if (newPass.length < 8) {
        status.style.color = "#d9534f";
        status.innerText = "La contraseña debe tener al menos 8 caracteres.";
        return;
    }
    if (newPass !== confirmPass) {
        status.style.color = "#d9534f";
        status.innerText = "Las contraseñas no coinciden.";
        return;
    }

    status.style.color = "#555";
    status.innerText = "Guardando...";

    const { error } = await sb.auth.updateUser({ password: newPass });

    if (error) {
        status.style.color = "#d9534f";
        status.innerText = "Error: " + error.message;
        return;
    }

    status.style.color = "#28a745";
    status.innerText = "¡Contraseña actualizada!";
    setTimeout(() => cerrarCambioPass(), 1500);
}

// ============================================================================
// CARGA DE DATOS
// Con la sesion autenticada, Supabase envia el JWT y las policies permiten
// el SELECT sobre Siniestros solo para rol authenticated.
// ============================================================================
async function cargarDatos() {
    try {
        const { data: { session } } = await sb.auth.getSession();
        if (!session) { mostrarLogin(); return; }

        const res = await fetch(`${URL_API}/rest/v1/Siniestros?select=*&order=id.desc`, {
            headers: {
                'apikey': KEY_API,
                'Authorization': `Bearer ${session.access_token}`
            }
        });

        if (res.status === 401 || res.status === 403) {
            await signOut();
            return;
        }

        datosGlobales = await res.json();

        renderTabla(datosGlobales);
        renderResumenInternos(datosGlobales);
        renderGraficos(datosGlobales);
    } catch (err) {
        console.error("Error al conectar con Supabase:", err);
    }
}

function renderTabla(datos) {
    const tabla = document.getElementById('cuerpoTabla');
    tabla.innerHTML = datos.map(s => {
        const esInterno = (s.tipo_siniestro || 'EXTERNO').toUpperCase() === 'INTERNO';
        const chip = esInterno
            ? '<span class="chip chip-interno">Interno</span>'
            : '<span class="chip chip-externo">Externo</span>';
        // En internos, "provincia" y "patente_tercero" se reutilizan para guardar
        // el lugar libre (en calle_interseccion) y la 2da patente nuestra.
        const lugar = esInterno ? (s.calle_interseccion || 'S/D') : (s.provincia || 'S/D');
        const empresa = esInterno
            ? 'INTERNO'
            : (s.prop_nombre || 'SIN DATOS');
        const presup = esInterno
            ? formatPresupuesto(s.presupuesto_monto, s.presupuesto_tipo)
            : '—';
        return `
            <tr>
                <td>${chip}</td>
                <td>${s.fecha_hecho || ''}</td>
                <td>${empresa}</td>
                <td>${s.nombre_chofer || ''}</td>
                <td>${s.patente_tercero || 'S/D'}</td>
                <td>${lugar}</td>
                <td>${presup}</td>
                <td>${s.link_pdf ? `<a href="${s.link_pdf}" target="_blank" class="btn-pdf">Ver PDF</a>` : 'Sin PDF'}</td>
            </tr>
        `;
    }).join('');
}

function formatPresupuesto(monto, tipo) {
    if (!monto && !tipo) return '—';
    const t = (tipo || '').toUpperCase();
    const tipoLabel = t === 'DEFINITIVO' ? 'Definitivo'
        : t === 'ESTIMADO' ? 'Estimado'
        : 'A presupuestar';
    return monto ? `$ ${monto} <span style="color:#888; font-size:11px;">(${tipoLabel})</span>` : tipoLabel;
}

function renderResumenInternos(datos) {
    const internos = datos.filter(s => (s.tipo_siniestro || '').toUpperCase() === 'INTERNO');
    const box = document.getElementById('resumen-internos');
    if (!internos.length) {
        box.classList.add('hidden');
        return;
    }
    const total = internos.reduce((acc, s) => {
        const n = parseFloat(String(s.presupuesto_monto || '0').replace(/[^0-9.,-]/g, '').replace(/\./g, '').replace(',', '.'));
        return acc + (isNaN(n) ? 0 : n);
    }, 0);
    document.getElementById('total-internos').innerText = '$ ' + total.toLocaleString('es-AR');
    document.getElementById('cant-internos').innerText = internos.length;
    box.classList.remove('hidden');
}

function aplicarFiltroTipo() {
    const tipo = document.getElementById('filtro-tipo').value;
    const filtrados = tipo === 'TODOS'
        ? datosGlobales
        : datosGlobales.filter(s => (s.tipo_siniestro || 'EXTERNO').toUpperCase() === tipo);
    renderTabla(filtrados);
    // Re-aplicamos el filtro de texto si habia algo escrito
    filtrarTabla();
}

function renderGraficos(datos) {
    // Destruir instancias previas para evitar error "Canvas is already in use"
    if (chartMeses) { chartMeses.destroy(); chartMeses = null; }
    if (chartProvincias) { chartProvincias.destroy(); chartProvincias = null; }

    const mesesLabels = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
    const mesesData = {};
    mesesLabels.forEach(m => mesesData[m] = 0);

    const zonaData = { "CABA": 0, "PROVINCIA": 0 };

    datos.forEach(s => {
        if (s.fecha_hecho) {
            const mesSiniestro = s.fecha_hecho.substring(0, 7);
            if (mesesData.hasOwnProperty(mesSiniestro)) {
                mesesData[mesSiniestro]++;
            }
        }

        const prov = (s.provincia || "").toUpperCase();
        if (prov.includes("CABA") || prov.includes("CAPITAL")) {
            zonaData["CABA"]++;
        } else {
            zonaData["PROVINCIA"]++;
        }
    });

    chartMeses = new Chart(document.getElementById('chartMeses'), {
        type: 'line',
        data: {
            labels: mesesLabels,
            datasets: [{
                label: 'Cantidad de Siniestros',
                data: Object.values(mesesData),
                borderColor: '#0056b3',
                tension: 0.2,
                fill: false
            }]
        },
        options: {
            scales: {
                y: {
                    beginAtZero: true,
                    max: 50,
                    ticks: {
                        stepSize: 1,
                        callback: function(value) { return value; }
                    }
                }
            }
        }
    });

    chartProvincias = new Chart(document.getElementById('chartProvincias'), {
        type: 'pie',
        data: {
            labels: ["CABA", "PROVINCIA"],
            datasets: [{
                data: [zonaData["CABA"], zonaData["PROVINCIA"]],
                backgroundColor: ['#3498db', '#e67e22']
            }]
        }
    });
}

function descargarExcel() {
    if (!datosGlobales.length) return;
    const ws = XLSX.utils.json_to_sheet(datosGlobales);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Siniestros");
    XLSX.writeFile(wb, "Reporte_Siniestros_BARSAT.xlsx");
}

function filtrarTabla() {
    const input = document.getElementById("busqueda").value.toUpperCase();
    const filas = document.getElementById("tablaSiniestros").getElementsByTagName("tr");
    for (let i = 1; i < filas.length; i++) {
        filas[i].style.display = filas[i].textContent.toUpperCase().includes(input) ? "" : "none";
    }
}

// Arrancar
window.addEventListener('DOMContentLoaded', init);
