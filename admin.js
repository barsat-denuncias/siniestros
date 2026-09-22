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

    // Al salir hay que vaciar lo que quedo en memoria y en pantalla. Antes solo
    // se ocultaba el panel: los datos seguian cargados y en una maquina
    // compartida el siguiente podia exportarlos.
    datosGlobales = [];
    const cuerpo = document.getElementById('cuerpoTabla');
    if (cuerpo) cuerpo.replaceChildren();
    const busq = document.getElementById('busqueda');
    if (busq) busq.value = '';
    const resumen = document.getElementById('resumen-internos');
    if (resumen) resumen.classList.add('hidden');
    if (chartMeses)      { chartMeses.destroy();      chartMeses = null; }
    if (chartProvincias) { chartProvincias.destroy(); chartProvincias = null; }
    mostrarErrorCarga('');

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
function mostrarErrorCarga(msg) {
    const el = document.getElementById('error-carga');
    if (el) {
        el.textContent = msg || '';
        el.style.display = msg ? 'block' : 'none';
    } else if (msg) {
        alert(msg);
    }
}

async function cargarDatos() {
    mostrarErrorCarga('');
    try {
        const { data: { session } } = await sb.auth.getSession();
        if (!session) { mostrarLogin(); return; }

        // PostgREST corta en 1000 filas por respuesta. Sin paginar, pasado ese
        // numero las denuncias mas viejas desaparecian del panel, del Excel y
        // de los graficos sin ningun aviso.
        const PAGINA = 1000;
        const todas = [];
        for (let desde = 0; ; desde += PAGINA) {
            const res = await fetch(
                `${URL_API}/rest/v1/Siniestros?select=*&order=id.desc`, {
                headers: {
                    'apikey': KEY_API,
                    'Authorization': `Bearer ${session.access_token}`,
                    'Range-Unit': 'items',
                    'Range': `${desde}-${desde + PAGINA - 1}`
                }
            });

            if (res.status === 401 || res.status === 403) { await signOut(); return; }
            if (!res.ok) {
                let detalle = '';
                try { detalle = (await res.json()).message || ''; } catch {}
                throw new Error(`HTTP ${res.status}${detalle ? ' — ' + detalle : ''}`);
            }

            const pagina = await res.json();
            if (!Array.isArray(pagina)) {
                throw new Error('La respuesta del servidor no tiene el formato esperado.');
            }
            todas.push(...pagina);
            if (pagina.length < PAGINA) break;
            if (desde > 50000) break;   // corte de seguridad
        }

        datosGlobales = todas;
        renderTabla(datosGlobales);
        renderResumenInternos(datosGlobales);
        renderGraficos(datosGlobales);
    } catch (err) {
        console.error("Error al conectar con Supabase:", err);
        // Antes esto quedaba solo en consola y el panel mostraba los datos
        // viejos como si fueran actuales.
        mostrarErrorCarga('No se pudieron cargar las denuncias: ' + err.message
            + '. Los datos que ves pueden estar desactualizados.');
    }
}

// ============================================================================
// RENDER DE LA TABLA
// IMPORTANTE: nada de innerHTML con datos de las denuncias.
// Los textos (nombre del chofer, lugar, patente) los escribe el chofer en el
// formulario y quedan guardados tal cual. Si se inyectaran como HTML, una
// denuncia con "<img src=x onerror=...>" en el nombre se ejecutaria al abrir
// este panel, con la sesion del administrador. Pasar todo a mayusculas NO
// neutraliza nada: las etiquetas HTML no distinguen mayusculas.
// Por eso cada celda se crea por DOM y el texto se asigna con textContent.
// ============================================================================

// Solo se permiten links al storage del propio proyecto, y por HTTPS.
// Asi un link_pdf manipulado no puede terminar en javascript: ni en otro sitio.
function linkPdfSeguro(valor) {
    if (!valor) return null;
    try {
        const u = new URL(String(valor), URL_API);
        if (u.protocol !== 'https:') return null;
        if (u.origin !== new URL(URL_API).origin) return null;
        if (!u.pathname.startsWith('/storage/v1/object/public/denuncias/')) return null;
        return u.href;
    } catch {
        return null;
    }
}

function celda(texto) {
    const td = document.createElement('td');
    td.textContent = (texto === null || texto === undefined) ? '' : String(texto);
    return td;
}

function renderTabla(datos) {
    const tabla = document.getElementById('cuerpoTabla');
    tabla.replaceChildren();

    (datos || []).forEach(s => {
        const tipo = (s.tipo_siniestro || 'EXTERNO').toUpperCase();
        const esInterno = tipo === 'INTERNO';
        const esRC = tipo === 'RC';

        const tr = document.createElement('tr');

        // Chip de tipo. Es el unico contenido con markup, y es nuestro.
        const tdChip = document.createElement('td');
        const chip = document.createElement('span');
        chip.className = esInterno ? 'chip chip-interno'
                        : esRC     ? 'chip chip-rc'
                                   : 'chip chip-externo';
        chip.textContent = esInterno ? 'Interno' : esRC ? 'Riesgos Varios' : 'Externo';
        tdChip.appendChild(chip);
        tr.appendChild(tdChip);

        // En internos, calle_interseccion guarda el lugar libre.
        const lugar = (esInterno || esRC)
            ? (s.calle_interseccion || 'S/D')
            : (s.provincia || 'S/D');
        const empresa = esInterno ? 'INTERNO'
                      : esRC      ? 'RIESGOS VARIOS'
                                  : (s.prop_nombre || 'SIN DATOS');

        tr.appendChild(celda(s.fecha_hecho));
        tr.appendChild(celda(empresa));
        tr.appendChild(celda(s.nombre_chofer));
        tr.appendChild(celda(s.patente_tercero || 'S/D'));
        tr.appendChild(celda(lugar));

        // Presupuesto: monto como texto y la etiqueta en su propio span
        const tdPres = document.createElement('td');
        if (esInterno) {
            const p = formatPresupuesto(s.presupuesto_monto, s.presupuesto_tipo);
            tdPres.textContent = p.texto;
            if (p.etiqueta) {
                const sp = document.createElement('span');
                sp.style.cssText = 'color:#888; font-size:11px;';
                sp.textContent = ' (' + p.etiqueta + ')';
                tdPres.appendChild(sp);
            }
        } else {
            tdPres.textContent = '—';
        }
        tr.appendChild(tdPres);

        // Link al PDF, validado
        const tdPdf = document.createElement('td');
        const href = linkPdfSeguro(s.link_pdf);
        if (href) {
            const a = document.createElement('a');
            a.href = href;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.className = 'btn-pdf';
            a.textContent = 'Ver PDF';
            tdPdf.appendChild(a);
        } else {
            tdPdf.textContent = s.link_pdf ? 'PDF inválido' : 'Sin PDF';
        }
        tr.appendChild(tdPdf);

        tabla.appendChild(tr);
    });
}

// Devuelve las partes por separado para no tener que armar HTML
function formatPresupuesto(monto, tipo) {
    const t = (tipo || '').toUpperCase();
    const tipoLabel = t === 'DEFINITIVO' ? 'Definitivo'
        : t === 'ESTIMADO' ? 'Estimado'
        : 'A presupuestar';
    if (!monto && !tipo) return { texto: '—', etiqueta: '' };
    if (!monto)          return { texto: tipoLabel, etiqueta: '' };
    return { texto: '$ ' + monto, etiqueta: tipoLabel };
}

function renderResumenInternos(datos) {
    const internos = datos.filter(s => (s.tipo_siniestro || '').toUpperCase() === 'INTERNO');
    const box = document.getElementById('resumen-internos');
    if (!internos.length) {
        box.classList.add('hidden');
        return;
    }
    // Los montos nuevos se guardan normalizados ("1234.56"). Los viejos pueden
    // venir en formato argentino. Se detecta cual separador es el decimal
    // mirando cual aparece ultimo, en vez de borrar los puntos a ciegas.
    const aNumero = (txt) => {
        const s = String(txt == null ? '' : txt).replace(/[^0-9.,-]/g, '');
        if (!s) return 0;
        const c = s.lastIndexOf(','), p = s.lastIndexOf('.');
        const limpio = (c === -1 && p === -1) ? s
                     : (c > p) ? s.replace(/\./g, '').replace(',', '.')
                               : s.replace(/,/g, '');
        const n = parseFloat(limpio);
        return isNaN(n) ? 0 : n;
    };
    const total = internos.reduce((acc, s) => acc + aNumero(s.presupuesto_monto), 0);
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

    // Los meses se calculan a partir de los datos, no se escriben a mano.
    // Antes estaban fijos de enero a agosto de 2026: cualquier denuncia de
    // septiembre en adelante no se contaba y el grafico mentia en silencio.
    // Se muestran los ultimos 12 meses contados desde la denuncia mas reciente.
    const mesesConDatos = (datos || [])
        .map(s => (s.fecha_hecho || '').substring(0, 7))
        .filter(m => /^\d{4}-\d{2}$/.test(m))
        .sort();

    const mesesLabels = [];
    if (mesesConDatos.length) {
        const ultimo = mesesConDatos[mesesConDatos.length - 1];
        let [anio, mes] = ultimo.split('-').map(Number);
        for (let i = 11; i >= 0; i--) {
            const d = new Date(anio, mes - 1 - i, 1);
            mesesLabels.push(
                d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
            );
        }
    }
    const mesesData = {};
    mesesLabels.forEach(m => mesesData[m] = 0);

    // Tercera categoria para lo que no se puede clasificar, en vez de
    // mandar todo lo desconocido a PROVINCIA.
    const zonaData = { "CABA": 0, "PROVINCIA": 0, "SIN DATO": 0 };

    datos.forEach(s => {
        if (s.fecha_hecho) {
            const mesSiniestro = s.fecha_hecho.substring(0, 7);
            if (mesesData.hasOwnProperty(mesSiniestro)) {
                mesesData[mesSiniestro]++;
            }
        }

        const prov = (s.provincia || "").trim().toUpperCase();
        if (!prov) {
            zonaData["SIN DATO"]++;
        } else if (prov.includes("CABA") || prov.includes("CAPITAL")) {
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
                    // Sin tope fijo: antes estaba clavado en 50 y con mas
                    // denuncias en un mes el grafico se cortaba.
                    ticks: { precision: 0 }
                }
            }
        }
    });

    chartProvincias = new Chart(document.getElementById('chartProvincias'), {
        type: 'pie',
        data: {
            labels: ["CABA", "PROVINCIA", "SIN DATO"],
            datasets: [{
                data: [zonaData["CABA"], zonaData["PROVINCIA"], zonaData["SIN DATO"]],
                backgroundColor: ['#3498db', '#e67e22', '#95a5a6']
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
