const URL_API = "https://ojsjxyxvcznoydhzhsrt.supabase.co";
const KEY_API = "sb_publishable__4dVId8Vbc2lsHIZrhzoMA_sRnfpxuh";
const EMAILJS_SERVICE_ID = "service_snce9ja";
const EMAILJS_TEMPLATE_ID = "template_66ehu6p";
const EMAILJS_PUBLIC_KEY = "uYFGRrX_AbRYotS_Q";

let unidad = {};
let datosEmpresa = {};
let nroSiniestroFinal = ""; // ahora lo asigna el backend al crear la denuncia

// Cuando estamos AMPLIANDO una denuncia del mismo dia, este objeto guarda
// {id, nro_siniestro} de la denuncia que estamos modificando. Si es null,
// el flujo es "denuncia nueva" (default).
let modoAmpliacion = null;

// Cuando estamos AMPLIANDO, este array guarda las fotos del envio original
// que el usuario quiere CONSERVAR. Cada entry: {url, name, label, categoria}.
// Si quita una foto vieja con la X, se elimina de este array y NO va al PDF
// nuevo. Las fotos NUEVAS que sube van por separado por los <input type=file>.
let fotosViejasMantenidas = [];

// Categorias conocidas (deben coincidir con los IDs f_<cat> del step 5)
const CATEGORIAS_FOTO = ['propios', 'tercero', 'doc_cond', 'doc_terc', 'otros'];

// === Estado del croquis (Paso 3) ===
let croquisCanvas = null;
let croquisCtx = null;
let croquisDibujando = false;
let croquisFueUsado = false;
let croquisHistorial = [];
let croquisInicializado = false;
// URL del croquis previo cuando ampliamos. Se setea en iniciarAmpliacion y se
// pinta sobre el canvas en iniciarCroquis para no perder el dibujo original.
let croquisUrlPrevio = null;
const CROQUIS_SIZE = 500;

const localidadesData = {
    "CABA": ["Almagro", "Balvanera", "Belgrano", "Caballito", "Flores", "Palermo", "Recoleta", "Retiro", "San Telmo", "Villa Urquiza"],
    "BUENOS AIRES": ["Avellaneda", "Lanús", "Lomas de Zamora", "Quilmes", "La Plata", "San Isidro", "Tigre", "Vicente López", "Pilar", "Morón"]
};

const titulos = ["", "Paso 1: Lugar y Fecha", "Paso 2: Conductor", "Paso 3: Daños y Relato", "Paso 4: El Tercero", "Paso 5: Fotos"];

// Headers comunes para llamadas a Supabase (REST y RPC)
const sbHeaders = (extra = {}) => Object.assign({
    'apikey': KEY_API,
    'Authorization': `Bearer ${KEY_API}`
}, extra);

// Helper para llamar RPCs de Postgres
async function rpc(nombre, params) {
    const res = await fetch(`${URL_API}/rest/v1/rpc/${nombre}`, {
        method: 'POST',
        headers: sbHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(params)
    });
    const body = await res.text();
    let data;
    try { data = body ? JSON.parse(body) : null; } catch { data = body; }
    if (!res.ok) {
        const msg = (data && data.message) ? data.message : (typeof data === 'string' ? data : `HTTP ${res.status}`);
        throw new Error(msg);
    }
    return data;
}

function setVal(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerText = text || "";
}

// FUNCIÓN PARA LIMPIAR ARCHIVOS SELECCIONADOS
function limpiarAdjunto(id) { document.getElementById(id).value = ""; }

function actualizarLocalidades() {
    const prov = document.getElementById('provincia').value;
    const locSelect = document.getElementById('localidad');
    const manualInput = document.getElementById('manual_localidad');

    locSelect.innerHTML = '<option value="" disabled selected>Seleccione Localidad*</option>';
    manualInput.classList.add('hidden');
    manualInput.required = false;

    if (localidadesData[prov]) {
        localidadesData[prov].forEach(loc => {
            const opt = document.createElement('option');
            opt.value = loc.toUpperCase();
            opt.textContent = loc.toUpperCase();
            locSelect.appendChild(opt);
        });
        // Agregar opción OTRA al final
        const optOtra = document.createElement('option');
        optOtra.value = "OTRA";
        optOtra.textContent = "--- OTRA / NO FIGURA EN LISTA ---";
        locSelect.appendChild(optOtra);
    }
}

function chequearOtraLocalidad() {
    const locSelect = document.getElementById('localidad');
    const manualInput = document.getElementById('manual_localidad');
    if (locSelect.value === "OTRA") {
        manualInput.classList.remove('hidden');
        manualInput.required = true;
        manualInput.focus();
    } else {
        manualInput.classList.add('hidden');
        manualInput.required = false;
        manualInput.value = "";
    }
}

function showStatus(msg, type) {
    const el = document.getElementById('status-msg');
    el.innerText = msg;
    el.className = `status-${type}`;
    el.style.display = 'block';
    window.scrollTo(0,0);
}

// Flag global para que el modal sepa a que envio despachar (externo/ampliacion vs interno).
// Antes reescribiamos el onclick del boton del modal, lo que rompia "ampliar" si el user
// abria/cancelaba un modal interno antes. Ahora el boton llama siempre a un dispatcher.
let modoInterno = false;

function abrirModal() {
    // Texto distinto si estamos ampliando vs denuncia nueva
    modoInterno = false;
    const titulo = document.getElementById('modal-titulo');
    const detalle = document.getElementById('modal-detalle');
    if (modoAmpliacion) {
        titulo.innerText = `¿Confirmar ampliación de ${modoAmpliacion.nro_siniestro}?`;
        detalle.innerText = "Se actualizarán los datos de la denuncia y se generará un nuevo PDF (mismo número de siniestro).";
    } else {
        titulo.innerText = "¿Desea enviar la denuncia?";
        detalle.innerText = "Se generará el reporte PDF y se guardará la información en la base de datos.";
    }
    document.getElementById('modal-confirmacion').classList.remove('hidden');
}
function cerrarModal() { document.getElementById('modal-confirmacion').classList.add('hidden'); }

// Dispatcher unico que decide a que flujo despacha segun modoInterno.
function confirmarEnvioDispatcher() {
    cerrarModal();
    if (modoInterno) enviarSiniestroInterno();
    else enviarSiniestro();
}

// Compat: mantengo las dos funciones por si quedan referencias viejas.
async function confirmarYEnviar() { cerrarModal(); enviarSiniestro(); }
async function confirmarYEnviarInterno() { cerrarModal(); enviarSiniestroInterno(); }

function aplicarValidacionEstricta(id) {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('input', () => {
        let val = input.value.toUpperCase();
        if (!"NO INFORMA".startsWith(val)) {
            input.value = val.replace(/[^0-9]/g, '');
        } else { input.value = val; }
    });
}

// ============================================================================
// AUTOCOMPLETADO DEL CONDUCTOR POR DNI
// Al escribir el DNI se consulta la RPC buscar_chofer (padron de Choferes) y
// se rellenan nombre, telefono, domicilio, CP y localidad.
// Si el DNI no figura NO se bloquea nada: se avisa y el chofer carga a mano.
// Los campos del conductor no se muestran hasta que la busqueda termina.
// ============================================================================
let choferEncontrado = null;   // guardamos legajo/op para el payload
let ultimoDniBuscado = '';
let timerBusquedaDni = null;

const CAMPOS_AUTOCOMPLETABLES = [
    'nombre_chofer', 'tel_chofer', 'domicilio_chofer',
    'cp_chofer', 'loc_chofer', 'prov_chofer'
];

function marcarCampo(id, clase) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('autocompletado');
    if (clase) el.classList.add(clase);
}

function statusDni(msg, tipo) {
    const el = document.getElementById('dni-status');
    if (!el) return;
    el.innerText = msg || '';
    el.className = 'dni-status' + (tipo ? ' ' + tipo : '');
}

function limpiarAutocompletado() {
    choferEncontrado = null;
    CAMPOS_AUTOCOMPLETABLES.forEach(id => marcarCampo(id, null));
}

// Los campos del conductor arrancan ocultos. Recien se muestran cuando el
// backend contesto: con los datos cargados si el DNI figura, o vacios si no.
// Asi el chofer no empieza a escribir al pedo algo que se iba a completar solo.
function mostrarDatosConductor(mostrar) {
    const box = document.getElementById('datos-conductor');
    if (box) box.classList.toggle('hidden', !mostrar);
}

function resetearPaso2() {
    ultimoDniBuscado = '';
    limpiarAutocompletado();
    mostrarDatosConductor(false);
    statusDni('');
    ['dni_chofer'].concat(CAMPOS_AUTOCOMPLETABLES).forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.value = ''; el.style.borderColor = '#ddd'; }
    });
}

// Rellena un campo SOLO si esta vacio o si el valor lo habiamos puesto
// nosotros. Nunca pisamos algo que el chofer escribio a mano.
function rellenarCampoChofer(id, valor) {
    const el = document.getElementById(id);
    if (!el || !valor) return;
    if (el.value.trim() !== '' && !el.classList.contains('autocompletado')) return;
    el.value = valor;
    el.style.borderColor = '#ddd';
    marcarCampo(id, 'autocompletado');
}

async function buscarChoferPorDni() {
    const input = document.getElementById('dni_chofer');
    if (!input) return;
    const dni = input.value.replace(/\D/g, '');

    if (dni === ultimoDniBuscado) return;
    ultimoDniBuscado = dni;

    if (dni.length < 7) {
        statusDni('');
        limpiarAutocompletado();
        mostrarDatosConductor(false);
        return;
    }

    statusDni('Buscando conductor...', 'buscando');
    try {
        const data = await rpc('buscar_chofer', { p_dni: dni });

        // Si mientras tanto siguio tipeando, descartamos esta respuesta
        const actual = document.getElementById('dni_chofer').value.replace(/\D/g, '');
        if (actual !== dni) return;

        if (!data || !data.encontrado) {
            limpiarAutocompletado();
            statusDni('DNI no encontrado en el padrón. Completá los datos a mano.', 'aviso');
            mostrarDatosConductor(true);
            return;
        }

        const c = data.chofer || {};
        choferEncontrado = c;

        // Se completa lo que el padron tenga. Lo que no tenga queda vacio y el
        // chofer lo escribe (o pone NO INFORMA), como cualquier otro campo.
        rellenarCampoChofer('nombre_chofer',    c.nombre_completo);
        rellenarCampoChofer('domicilio_chofer', c.domicilio);
        rellenarCampoChofer('cp_chofer',        c.cp);
        rellenarCampoChofer('loc_chofer',       c.localidad);
        rellenarCampoChofer('prov_chofer',      c.provincia);
        rellenarCampoChofer('tel_chofer',       c.telefono);

        let msg = c.nombre_completo || 'Conductor encontrado';
        if (c.op) msg += ' — ' + c.op + (c.legajo ? ' (leg. ' + c.legajo + ')' : '');
        statusDni(msg, 'ok');
        mostrarDatosConductor(true);

    } catch (err) {
        limpiarAutocompletado();
        statusDni('No se pudo consultar el padrón. Cargá los datos a mano.', 'aviso');
        mostrarDatosConductor(true);
        console.warn('buscar_chofer fallo:', err.message);
    }
}

function initAutocompletadoChofer() {
    const input = document.getElementById('dni_chofer');
    if (!input) return;

    input.addEventListener('input', () => {
        clearTimeout(timerBusquedaDni);
        timerBusquedaDni = setTimeout(buscarChoferPorDni, 450);
    });
    input.addEventListener('blur', () => {
        clearTimeout(timerBusquedaDni);
        buscarChoferPorDni();
    });

    // Si el chofer corrige a mano un campo autocompletado, le sacamos la marca
    // para no volver a pisarselo en la proxima busqueda.
    CAMPOS_AUTOCOMPLETABLES.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => el.classList.remove('autocompletado'));
    });
}

// ---- Misma logica, version reducida, para el flujo INTERNO ----
// La constancia interna solo imprime nombre, DNI y telefono del conductor.
let ultimoDniInterno = '';
let timerDniInterno = null;

function statusDniInterno(msg, tipo) {
    const el = document.getElementById('i-dni-status');
    if (!el) return;
    el.innerText = msg || '';
    el.className = 'dni-status' + (tipo ? ' ' + tipo : '');
}

async function buscarChoferInterno() {
    const input = document.getElementById('i_dni_chofer');
    if (!input) return;
    const dni = input.value.replace(/\D/g, '');

    if (dni === ultimoDniInterno) return;
    ultimoDniInterno = dni;

    if (dni.length < 7) { statusDniInterno(''); return; }

    statusDniInterno('Buscando conductor...', 'buscando');
    try {
        const data = await rpc('buscar_chofer', { p_dni: dni });
        if (document.getElementById('i_dni_chofer').value.replace(/\D/g, '') !== dni) return;

        if (!data || !data.encontrado) {
            ['i_nombre_chofer', 'i_tel_chofer'].forEach(id => marcarCampo(id, null));
            statusDniInterno('DNI no encontrado en el padrón. Completá los datos a mano.', 'aviso');
            return;
        }
        const c = data.chofer || {};
        rellenarCampoChofer('i_nombre_chofer', c.nombre_completo);
        rellenarCampoChofer('i_tel_chofer',    c.telefono);

        let msg = c.nombre_completo || 'Conductor encontrado';
        if (c.op) msg += ' — ' + c.op + (c.legajo ? ' (leg. ' + c.legajo + ')' : '');
        statusDniInterno(msg, 'ok');
    } catch (err) {
        ['i_nombre_chofer', 'i_tel_chofer'].forEach(id => marcarCampo(id, null));
        statusDniInterno('No se pudo consultar el padrón. Cargá los datos a mano.', 'aviso');
        console.warn('buscar_chofer (interno) fallo:', err.message);
    }
}

function initAutocompletadoChoferInterno() {
    const input = document.getElementById('i_dni_chofer');
    if (!input) return;
    input.addEventListener('input', () => {
        clearTimeout(timerDniInterno);
        timerDniInterno = setTimeout(buscarChoferInterno, 450);
    });
    input.addEventListener('blur', () => {
        clearTimeout(timerDniInterno);
        buscarChoferInterno();
    });
    ['i_nombre_chofer', 'i_tel_chofer'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', () => el.classList.remove('autocompletado'));
    });
}

// Devuelve true si la fecha (formato YYYY-MM-DD) corresponde al dia de hoy
// segun la zona horaria LOCAL del navegador. Importante usar local y no UTC
// porque a la noche (Argentina UTC-3) el dia UTC ya cambio y rompe el chequeo.
function esHoy(fechaStr) {
    if (!fechaStr) return false;
    const ahora = new Date();
    const yyyy = ahora.getFullYear();
    const mm = String(ahora.getMonth() + 1).padStart(2, '0');
    const dd = String(ahora.getDate()).padStart(2, '0');
    const hoy = `${yyyy}-${mm}-${dd}`;
    // fecha_hecho puede venir como '2026-06-10' o '2026-06-10T00:00:00'
    return String(fechaStr).slice(0, 10) === hoy;
}

// ============================================================================
// CROQUIS (Paso 3): canvas con rosa de los vientos como fondo + dibujo libre
// del usuario. Se exporta como dataURL al PDF en enviarSiniestro.
// ============================================================================
function dibujarRosaVientos(ctx) {
    const W = CROQUIS_SIZE;
    const cx = W / 2;
    const cy = W / 2;

    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.lineCap = 'butt';

    // Calles verticales (4 segmentos). Las dos paralelas a 0.38 y 0.62
    // dejan una calle de 24% del ancho del canvas. La interseccion central
    // queda libre entre 0.34 y 0.66.
    ctx.beginPath();
    ctx.moveTo(W * 0.38, 0);        ctx.lineTo(W * 0.38, W * 0.34);
    ctx.moveTo(W * 0.38, W * 0.66); ctx.lineTo(W * 0.38, W);
    ctx.moveTo(W * 0.62, 0);        ctx.lineTo(W * 0.62, W * 0.34);
    ctx.moveTo(W * 0.62, W * 0.66); ctx.lineTo(W * 0.62, W);
    ctx.stroke();

    // Calles horizontales (4 segmentos)
    ctx.beginPath();
    ctx.moveTo(0, W * 0.38);        ctx.lineTo(W * 0.34, W * 0.38);
    ctx.moveTo(W * 0.66, W * 0.38); ctx.lineTo(W, W * 0.38);
    ctx.moveTo(0, W * 0.62);        ctx.lineTo(W * 0.34, W * 0.62);
    ctx.moveTo(W * 0.66, W * 0.62); ctx.lineTo(W, W * 0.62);
    ctx.stroke();

    // Letras N / S / O / E
    ctx.fillStyle = '#000';
    ctx.font = 'bold 56px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', cx, W * 0.08);
    ctx.fillText('S', cx, W * 0.92);
    ctx.fillText('O', W * 0.08, cy);
    ctx.fillText('E', W * 0.92, cy);
}

function guardarEstadoCroquis() {
    if (!croquisCtx) return;
    const snap = croquisCtx.getImageData(0, 0, CROQUIS_SIZE, CROQUIS_SIZE);
    croquisHistorial.push(snap);
    if (croquisHistorial.length > 30) croquisHistorial.shift();
}

function obtenerCoordsCroquis(clientX, clientY) {
    const rect = croquisCanvas.getBoundingClientRect();
    const scaleX = croquisCanvas.width / rect.width;
    const scaleY = croquisCanvas.height / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

function iniciarTrazo(clientX, clientY) {
    croquisDibujando = true;
    croquisFueUsado = true;
    const { x, y } = obtenerCoordsCroquis(clientX, clientY);
    croquisCtx.beginPath();
    croquisCtx.moveTo(x, y);
    const msg = document.getElementById('croquis-error');
    if (msg) msg.style.display = 'none';
}

function continuarTrazo(clientX, clientY) {
    if (!croquisDibujando) return;
    const { x, y } = obtenerCoordsCroquis(clientX, clientY);
    croquisCtx.lineTo(x, y);
    croquisCtx.stroke();
}

function finalizarTrazo() {
    if (!croquisDibujando) return;
    croquisDibujando = false;
    guardarEstadoCroquis();
}

function deshacerCroquis() {
    if (croquisHistorial.length <= 1) return;
    croquisHistorial.pop();
    const previo = croquisHistorial[croquisHistorial.length - 1];
    croquisCtx.putImageData(previo, 0, 0);
    if (croquisHistorial.length === 1) croquisFueUsado = false;
}

function limpiarCroquis() {
    if (!croquisCtx) return;
    croquisCtx.fillStyle = '#fff';
    croquisCtx.fillRect(0, 0, CROQUIS_SIZE, CROQUIS_SIZE);
    dibujarRosaVientos(croquisCtx);
    croquisHistorial = [];
    guardarEstadoCroquis();
    croquisFueUsado = false;
    // Restaurar configuracion del trazo del usuario (porque dibujarRosaVientos cambia lineWidth)
    croquisCtx.strokeStyle = '#000';
    croquisCtx.lineWidth = 6;
    croquisCtx.lineCap = 'round';
    croquisCtx.lineJoin = 'round';
}

function iniciarCroquis() {
    if (croquisInicializado) return;

    croquisCanvas = document.getElementById('croquis-canvas');
    if (!croquisCanvas) return;

    croquisCtx = croquisCanvas.getContext('2d');
    croquisCanvas.width = CROQUIS_SIZE;
    croquisCanvas.height = CROQUIS_SIZE;

    // Fondo blanco + rosa de los vientos como base
    croquisCtx.fillStyle = '#fff';
    croquisCtx.fillRect(0, 0, CROQUIS_SIZE, CROQUIS_SIZE);
    dibujarRosaVientos(croquisCtx);
    croquisHistorial = [];
    guardarEstadoCroquis();
    croquisFueUsado = false;

    // Si estamos ampliando una denuncia con croquis previo, lo pintamos sobre la
    // rosa de los vientos. Marcamos como usado para que la validacion pase aunque
    // el usuario no agregue nada (la imagen vieja vale por si sola).
    if (croquisUrlPrevio) {
        croquisFueUsado = true;
        cargarCroquisPrevio(croquisUrlPrevio);
    }

    // Estilo del trazo del usuario
    croquisCtx.strokeStyle = '#000';
    croquisCtx.lineWidth = 6;
    croquisCtx.lineCap = 'round';
    croquisCtx.lineJoin = 'round';

    // Mouse
    croquisCanvas.addEventListener('mousedown', (e) => iniciarTrazo(e.clientX, e.clientY));
    croquisCanvas.addEventListener('mousemove', (e) => continuarTrazo(e.clientX, e.clientY));
    croquisCanvas.addEventListener('mouseup', finalizarTrazo);
    croquisCanvas.addEventListener('mouseleave', finalizarTrazo);

    // Touch
    croquisCanvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const t = e.touches[0];
        iniciarTrazo(t.clientX, t.clientY);
    }, { passive: false });
    croquisCanvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const t = e.touches[0];
        continuarTrazo(t.clientX, t.clientY);
    }, { passive: false });
    croquisCanvas.addEventListener('touchend', (e) => {
        e.preventDefault();
        finalizarTrazo();
    }, { passive: false });

    croquisInicializado = true;
}

// Resetea el estado del croquis para que arranque limpio en la proxima carga
// (denuncia nueva o ampliacion). El canvas en si se re-inicializa cuando el
// usuario entra al paso 3 (cambiarPaso).
function resetearCroquis() {
    croquisInicializado = false;
    croquisCanvas = null;
    croquisCtx = null;
    croquisDibujando = false;
    croquisFueUsado = false;
    croquisHistorial = [];
    croquisUrlPrevio = null;
}

// Carga la imagen del croquis previo sobre el canvas actual. Hacemos fetch como
// blob y la convertimos a object URL para evitar problemas de CORS al renderizar
// la imagen en el canvas (sino el canvas queda tainted y toBlob() falla).
async function cargarCroquisPrevio(url) {
    if (!url || !croquisCtx) return;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.warn('Croquis previo HTTP', res.status, url);
            return;
        }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            croquisCtx.drawImage(img, 0, 0, CROQUIS_SIZE, CROQUIS_SIZE);
            URL.revokeObjectURL(objectUrl);
            guardarEstadoCroquis();
        };
        img.onerror = () => {
            console.warn('Croquis previo: error al renderizar la imagen');
            URL.revokeObjectURL(objectUrl);
        };
        img.src = objectUrl;
    } catch (err) {
        console.warn('Croquis previo: fetch fallo', err);
    }
}

window.onload = function() {
    const hoy = new Date().toISOString().split('T')[0];
    document.getElementById('fecha_hecho').setAttribute('max', hoy);
    emailjs.init(EMAILJS_PUBLIC_KEY);
    ['dni_chofer', 'tel_chofer', 'prop_dni', 'prop_tel', 'cp', 'cp_chofer'].forEach(aplicarValidacionEstricta);
    initAutocompletadoChofer();
    initAutocompletadoChoferInterno();
    document.getElementById('es_propietario').addEventListener('change', function() {
        document.getElementById('datos_propietario').classList.toggle('hidden', this.value === 'SI');
    });

    // ===== Validaciones del flujo INTERNO =====
    // DNI y telefono: solo numeros (sin "NO INFORMA", aca todo es obligatorio numerico)
    ['i_dni_chofer', 'i_tel_chofer', 'i_presup_monto'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
            el.value = el.value.replace(/[^0-9]/g, '');
        });
    });
    // Patente afectada: mayusculas + solo letras y numeros
    const inpP2 = document.getElementById('i_patente2');
    if (inpP2) {
        inpP2.addEventListener('input', () => {
            inpP2.value = inpP2.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        });
    }
    // Nombre conductor: solo letras y espacios
    const inpNom = document.getElementById('i_nombre_chofer');
    if (inpNom) {
        inpNom.addEventListener('input', () => {
            inpNom.value = inpNom.value.replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñÜü\s'-]/g, '');
        });
    }
};

// Muestra/oculta el input de monto segun el tipo de presupuesto seleccionado.
function actualizarVisibilidadMonto() {
    const tipo = document.getElementById('i_presup_tipo').value;
    const monto = document.getElementById('i_presup_monto');
    if (!monto) return;
    if (tipo === 'PENDIENTE') {
        monto.classList.add('hidden');
        monto.value = '';
    } else {
        monto.classList.remove('hidden');
    }
}

// ============================================================================
// VALIDACIÓN DE UNIDAD
// Un solo viaje al backend via RPC validar_unidad, que devuelve camion +
// empresa + siniestros_previos (con flag puede_ampliar).
// ============================================================================
document.getElementById('form-validacion').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.innerText = "Buscando..."; btn.disabled = true;
    const patente = document.getElementById('patente').value.trim().toUpperCase();

    try {
        // Mandamos p_chasis_suffix explicito ('') para evitar que PostgREST
        // se confunda con el DEFAULT NULL de la RPC.
        const data = await rpc('validar_unidad', { p_patente: patente, p_chasis_suffix: '' });

        if (!data || !data.encontrado) {
            showStatus("Unidad no encontrada.", "error");
            return;
        }

        unidad = data.camion || {};
        datosEmpresa = data.empresa || {};
        // Ya no se pide chasis al usuario; las RPCs lo aceptan como opcional.
        unidad.__chasis_suffix = '';

        const siniestrosPrevios = data.siniestros_previos || [];

        if (siniestrosPrevios.length > 0) {
            mostrarPasoIntermedio(siniestrosPrevios);
        } else {
            iniciarFormulario();
        }
    } catch (err) {
        showStatus("Error de conexión: " + err.message, "error");
    } finally {
        btn.innerText = "Validar Unidad"; btn.disabled = false;
    }
});

// Render de la pantalla intermedia. Las denuncias del mismo dia se muestran
// con un boton "Ampliar"; las demas solo como referencia. Si hay mas de 3,
// se ocultan con un toggle para que el boton "Hacer Nueva Denuncia" no
// quede empujado fuera de pantalla.
const MAX_PREVIAS_VISIBLES = 3;

function mostrarPasoIntermedio(siniestros) {
    const lista = document.getElementById('lista-siniestros-hoy');
    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    window.__siniestrosPrevios = {};
    siniestros.forEach((s, i) => { window.__siniestrosPrevios[i] = s; });

    const renderItem = (s, idx) => {
        // El backend decide si se puede ampliar segun la fecha de CARGA (created_at)
        // y el tipo de siniestro. La fecha del hecho es solo informativa.
        const ampliable = !!s.puede_ampliar;
        const fmtFecha = (f) => {
            if (!f) return 'S/D';
            const partes = String(f).slice(0, 10).split('-');
            if (partes.length !== 3) return f;
            return `${partes[2]}/${partes[1]}/${partes[0]}`;
        };
        const tipo = (s.tipo_siniestro || 'EXTERNO').toUpperCase();
        const chipTipo = tipo === 'INTERNO'
            ? '<span class="chip chip-interno">Interno</span>'
            : '<span class="chip chip-externo">Externo</span>';
        // Hint cuando no es ampliable: explicamos el motivo
        let hintNoAmpliable = '';
        if (!ampliable) {
            if (tipo === 'INTERNO') {
                hintNoAmpliable = '<span class="ampliable-hint">Las constancias internas no se amplían.</span>';
            } else {
                hintNoAmpliable = '<span class="ampliable-hint">Solo se puede ampliar el mismo día de la carga.</span>';
            }
        }
        return `
            <div class="sin-card ${ampliable ? 'ampliable' : ''}">
                <div class="sin-info">
                    <strong>SN: ${esc(s.nro_siniestro)}</strong> ${chipTipo}<br>
                    Siniestro: ${esc(fmtFecha(s.fecha_hecho))} · Cargada: ${esc(fmtFecha(s.fecha_carga))}<br>
                    Conductor: ${esc(s.nombre_chofer || 'S/D')}
                    ${hintNoAmpliable}
                </div>
                ${ampliable ? `<button class="btn-ampliar" onclick="iniciarAmpliacion(${idx})">Ampliar esta denuncia</button>` : ''}
            </div>
        `;
    };

    const visibles = siniestros.slice(0, MAX_PREVIAS_VISIBLES);
    const ocultas  = siniestros.slice(MAX_PREVIAS_VISIBLES);

    let html = visibles.map((s, i) => renderItem(s, i)).join('');
    if (ocultas.length > 0) {
        html += `<button class="btn-ver-mas" type="button" onclick="expandirPrevias(this)">Ver ${ocultas.length} denuncia${ocultas.length === 1 ? '' : 's'} anterior${ocultas.length === 1 ? '' : 'es'}</button>`;
        html += `<div id="previas-extra" class="hidden">` +
            ocultas.map((s, i) => renderItem(s, MAX_PREVIAS_VISIBLES + i)).join('') +
            `</div>`;
    }

    lista.innerHTML = html;
    document.getElementById('pantalla-validacion').classList.add('hidden');
    document.getElementById('pantalla-seleccion').classList.remove('hidden');
}

function expandirPrevias(btn) {
    const cont = document.getElementById('previas-extra');
    if (cont) cont.classList.remove('hidden');
    if (btn) btn.style.display = 'none';
}

// Punto de entrada cuando no hay denuncias previas (o el user elige "Hacer
// Nueva Denuncia"): mostramos primero el selector Externo / Interno y desde
// ahi se bifurca el flujo. Las AMPLIACIONES no pasan por aca, van directo al
// formulario externo via iniciarAmpliacion().
function iniciarFormulario() {
    modoAmpliacion = null;
    document.getElementById('pantalla-validacion').classList.add('hidden');
    document.getElementById('pantalla-seleccion').classList.add('hidden');
    document.getElementById('pantalla-formulario').classList.add('hidden');
    document.getElementById('pantalla-formulario-interno').classList.add('hidden');
    document.getElementById('pantalla-tipo-siniestro').classList.remove('hidden');
}

// Flujo EXTERNO (denuncia con tercero) — lo que existia antes.
function iniciarFlujoExterno() {
    modoAmpliacion = null;
    fotosViejasMantenidas = [];
    limpiarPreviewsFotosViejas();
    actualizarBannerAmpliacion();
    resetearCroquis();
    resetearPaso2();
    document.getElementById('pantalla-tipo-siniestro').classList.add('hidden');
    document.getElementById('pantalla-formulario-interno').classList.add('hidden');
    document.getElementById('pantalla-formulario').classList.remove('hidden');
    cambiarPaso(1);
}

// Flujo INTERNO (constancia entre dos vehiculos nuestros) — 2 pasos cortos.
function iniciarFlujoInterno() {
    modoAmpliacion = null;
    document.getElementById('pantalla-tipo-siniestro').classList.add('hidden');
    document.getElementById('pantalla-formulario').classList.add('hidden');
    document.getElementById('pantalla-formulario-interno').classList.remove('hidden');
    // Inicializa max fecha y status del patente2 cada vez por si quedo de un intento anterior
    const hoy = new Date().toISOString().split('T')[0];
    const f = document.getElementById('i_fecha');
    if (f) f.setAttribute('max', hoy);
    const st = document.getElementById('i_patente2_status');
    if (st) { st.innerText = ''; st.style.color = ''; }
    // Reset del presupuesto: tipo en PENDIENTE y monto oculto
    const selT = document.getElementById('i_presup_tipo');
    if (selT) selT.value = 'PENDIENTE';
    actualizarVisibilidadMonto();
    cambiarPasoInterno(1);
}

// Borra los previews de fotos viejas en cada upload-group del step 5.
function limpiarPreviewsFotosViejas() {
    CATEGORIAS_FOTO.forEach(cat => {
        const cont = document.getElementById(`fotos-viejas-${cat}`);
        if (cont) cont.innerHTML = '';
    });
}

// Determina la categoria a partir del nombre del archivo en el storage.
// Ej: "AF773FD_177.../doc_cond_0.jpg" -> "doc_cond"
function categoriaDeFoto(name) {
    const base = (name || '').split('/').pop() || '';
    // Probamos las mas largas primero para evitar que "doc_cond" matchee "doc"
    const ordenadas = [...CATEGORIAS_FOTO].sort((a, b) => b.length - a.length);
    for (const c of ordenadas) {
        if (base.toLowerCase().startsWith(c + '_') || base.toLowerCase().startsWith(c + '.')) {
            return c;
        }
    }
    return 'otros';
}

// Render de los previews. Lee fotosViejasMantenidas y dibuja un thumbnail
// con boton X en el container que corresponde a su categoria.
function renderFotosViejas() {
    limpiarPreviewsFotosViejas();
    fotosViejasMantenidas.forEach(f => {
        const cont = document.getElementById(`fotos-viejas-${f.categoria}`);
        if (!cont) return;
        const div = document.createElement('div');
        div.className = 'foto-vieja';
        div.title = f.label || f.name;
        div.innerHTML = `
            <img src="${f.url}" alt="">
            <button type="button" class="quitar-foto" data-name="${encodeURIComponent(f.name)}" title="Quitar foto">×</button>
        `;
        div.querySelector('.quitar-foto').addEventListener('click', () => quitarFotoVieja(f.name));
        cont.appendChild(div);
    });
}

function quitarFotoVieja(name) {
    fotosViejasMantenidas = fotosViejasMantenidas.filter(f => f.name !== name);
    renderFotosViejas();
}

// Llama a la RPC para traer las fotos viejas de la denuncia que estamos
// ampliando. Si falla, no rompe el flujo (el usuario igual puede subir nuevas).
async function cargarFotosViejas(idDenuncia) {
    try {
        const fotos = await rpc('listar_fotos_denuncia', {
            p_id: idDenuncia,
            p_patente: unidad.DOMINIO,
            p_chasis_suffix: unidad.__chasis_suffix || ''
        });
        if (!Array.isArray(fotos)) return;
        // Numerar dentro de cada categoria para los labels del PDF
        const counts = {};
        fotosViejasMantenidas = fotos.map(f => {
            const cat = categoriaDeFoto(f.name);
            counts[cat] = (counts[cat] || 0) + 1;
            return {
                name: f.name,
                url: f.url,
                categoria: cat,
                label: `${cat}_${counts[cat]}`
            };
        });
        renderFotosViejas();
    } catch (err) {
        console.warn('No se pudieron listar las fotos viejas:', err.message);
    }
}

// ============================================================================
// AMPLIACIÓN: precarga del formulario con los datos de la denuncia anterior
// ============================================================================
function iniciarAmpliacion(idx) {
    const s = window.__siniestrosPrevios && window.__siniestrosPrevios[idx];
    if (!s) {
        showStatus("No se pudo recuperar la denuncia anterior. Refresque y reintente.", "error");
        return;
    }
    modoAmpliacion = { id: s.id, nro_siniestro: s.nro_siniestro };
    fotosViejasMantenidas = [];
    limpiarPreviewsFotosViejas();
    resetearCroquis();
    // Guardamos la URL del croquis previo para que iniciarCroquis (cuando el
    // usuario llegue al paso 3) lo pinte sobre el canvas.
    croquisUrlPrevio = s.croquis_url || null;
    precargarFormulario(s);
    actualizarBannerAmpliacion();

    document.getElementById('pantalla-validacion').classList.add('hidden');
    document.getElementById('pantalla-seleccion').classList.add('hidden');
    document.getElementById('pantalla-tipo-siniestro').classList.add('hidden');
    document.getElementById('pantalla-formulario-interno').classList.add('hidden');
    document.getElementById('pantalla-formulario').classList.remove('hidden');
    cambiarPaso(1);

    // Disparamos la carga de fotos viejas en segundo plano. Cuando llega la
    // respuesta se renderizan los thumbs en el step 5; si el usuario ya esta
    // mirando ese paso, va a verlos aparecer.
    cargarFotosViejas(s.id);
}

function actualizarBannerAmpliacion() {
    const banner = document.getElementById('banner-ampliacion');
    if (modoAmpliacion) {
        banner.innerHTML = `Modo AMPLIACIÓN — modificando denuncia <span>${modoAmpliacion.nro_siniestro}</span>`;
        banner.classList.remove('hidden');
    } else {
        banner.classList.add('hidden');
    }
}

function setVal2(id, value) {
    const el = document.getElementById(id);
    if (el && value != null) el.value = value;
}

// Setea provincia + localidad disparando el cambio de localidades.
// Si la localidad no está en la lista predefinida, marca "OTRA" + manual_localidad.
function setearProvinciaLocalidad(provincia, localidad) {
    const provSel = document.getElementById('provincia');
    const locSel = document.getElementById('localidad');
    const manualInput = document.getElementById('manual_localidad');

    if (!provincia) return;
    provSel.value = provincia;
    actualizarLocalidades(); // repuebla las opciones según la provincia

    if (!localidad) return;
    const opciones = Array.from(locSel.options).map(o => o.value);
    if (opciones.includes(localidad)) {
        locSel.value = localidad;
        manualInput.classList.add('hidden');
        manualInput.value = '';
        manualInput.required = false;
    } else {
        // Localidad personalizada → modo OTRA
        locSel.value = "OTRA";
        manualInput.classList.remove('hidden');
        manualInput.required = true;
        manualInput.value = localidad;
    }
}

// Setea es_propietario y dispara el toggle de los campos del propietario
function setearEsPropietario(propNombre) {
    const sel = document.getElementById('es_propietario');
    const tieneProp = !!(propNombre && propNombre.trim());
    sel.value = tieneProp ? 'NO' : 'SI';
    document.getElementById('datos_propietario').classList.toggle('hidden', !tieneProp);
}

function precargarFormulario(s) {
    // Paso 1
    setVal2('fecha_hecho', s.fecha_hecho);
    setVal2('hora_hecho', s.hora_hecho);
    setearProvinciaLocalidad(s.provincia, s.localidad);
    setVal2('cp', s.cp);

    // calle_interseccion viene como "CALLE e INTERSECCION". Splitear el primer " e "
    if (s.calle_interseccion) {
        const partes = s.calle_interseccion.split(/\s+e\s+/i);
        setVal2('calle', partes[0] || s.calle_interseccion);
        setVal2('interseccion', partes.slice(1).join(' e ') || '');
    }

    // Paso 2
    setVal2('nombre_chofer', s.nombre_chofer);
    setVal2('dni_chofer', s.dni_chofer);
    setVal2('tel_chofer', s.tel_chofer);
    setVal2('domicilio_chofer', s.domicilio_chofer);
    setVal2('loc_chofer', s.loc_chofer);
    setVal2('prov_chofer', s.prov_chofer);
    setVal2('cp_chofer', s.cp_chofer);
    // En ampliacion respetamos lo que se cargo la primera vez: los campos
    // quedan sin marca de "autocompletado" asi la busqueda por DNI no los pisa,
    // y se muestran directamente porque ya vienen llenos.
    limpiarAutocompletado();
    mostrarDatosConductor(true);
    ultimoDniBuscado = String(s.dni_chofer || '').replace(/\D/g, '');

    // Paso 3
    setVal2('danos_propios', s.danos_propios);
    setVal2('descripcion', s.relato);

    // Paso 4
    setVal2('patente_tercero', s.patente_tercero);
    setVal2('marca_tercero', s.marca_tercero);
    setVal2('seguro_tercero', s.seguro_tercero);
    setVal2('poliza_tercero', s.poliza_tercero);
    setVal2('danos_tercero', s.danos_tercero);
    setearEsPropietario(s.prop_nombre);
    setVal2('prop_nombre', s.prop_nombre);
    setVal2('prop_dni', s.prop_dni);
    setVal2('prop_tel', s.prop_tel);
}

function cambiarPaso(paso) {
    document.querySelectorAll('.step').forEach(s => s.classList.add('hidden'));
    document.getElementById(`step-${paso}`).classList.remove('hidden');
    document.getElementById('progress').style.width = (paso * 20) + "%";
    document.getElementById('titulo-paso').innerText = titulos[paso];
    document.getElementById('indicador-paso').innerText = `Paso ${paso} de 5`;
    const msg = document.getElementById('msg-obligatorio');
    if (paso >= 1 && paso <= 4) { msg.style.display = 'block'; }
    else { msg.style.display = 'none'; }
    if (paso === 3) iniciarCroquis();
    window.scrollTo(0,0);
}

function validarYPasar(proximoPaso) {
    const inputs = document.getElementById(`step-${proximoPaso - 1}`).querySelectorAll('[required]');
    let valido = true;
    inputs.forEach(i => {
        if(!i.checkValidity()){ i.style.borderColor = "red"; valido = false; }
        else { i.style.borderColor = "#ddd"; }
    });

    // Validacion extra al salir del paso 3: el croquis es obligatorio
    if (proximoPaso === 4 && !croquisFueUsado) {
        const msg = document.getElementById('croquis-error');
        if (msg) msg.style.display = 'block';
        valido = false;
    }

    if(valido) cambiarPaso(proximoPaso);
}

// ============================================================================
// ENVÍO DE SINIESTRO
// Flujo:
//   1. Subir fotos al bucket
//   2. Llamar RPC crear_denuncia (nuevo) o ampliar_denuncia (ampliacion)
//   3. Llenar template con el SN asignado y generar PDF
//   4. Subir PDF al bucket
//   5. Enviar mail por EmailJS (con flag tipo_envio para distinguir nueva vs ampliacion)
// ============================================================================
async function enviarSiniestro() {
    const btn = document.getElementById('btn-finalizar');
    btn.innerText = "Enviando..."; btn.disabled = true;
    const ts = Date.now();
    const folder = `${unidad.DOMINIO}_${ts}`;
    const pdfPath = `${folder}/Denuncia_Final.pdf`;
    const linkFinal = `${URL_API}/storage/v1/object/public/denuncias/${pdfPath}`;
    const val = (id) => document.getElementById(id) ? document.getElementById(id).value.trim().toUpperCase() : "NO INFORMA";

    const getLocalidadFinal = () => {
        const sel = document.getElementById('localidad').value;
        const man = document.getElementById('manual_localidad').value.trim().toUpperCase();
        return (sel === "OTRA") ? man : sel;
    };
    const localidadFinal = getLocalidadFinal();

    const esAmpliacion = !!modoAmpliacion;

    try {
        // 1. Armar el listado de fotos del PDF.
        //    - Arrancamos con las VIEJAS que el usuario mantuvo (solo en ampliacion).
        //      No se vuelven a subir, se reusa la URL original.
        //    - Despues subimos las NUEVAS al folder nuevo y las concatenamos.
        const cats = ['propios', 'tercero', 'doc_cond', 'doc_terc', 'otros'];
        const links = [];

        if (esAmpliacion && fotosViejasMantenidas.length > 0) {
            // Las viejas ya tienen url y categoria; renumeramos los labels por categoria
            const counts = {};
            // Ordenamos por categoria para que en el PDF aparezcan agrupadas
            const orden = (a, b) => cats.indexOf(a.categoria) - cats.indexOf(b.categoria);
            fotosViejasMantenidas.slice().sort(orden).forEach(f => {
                counts[f.categoria] = (counts[f.categoria] || 0) + 1;
                links.push({ url: f.url, label: `${f.categoria}_${counts[f.categoria]}` });
            });
        }

        for (const c of cats) {
            const f = document.getElementById(`f_${c}`).files;
            // Si ya hay viejas mantenidas de esta categoria, seguimos numerando
            const yaContados = links.filter(l => l.label.startsWith(c + '_')).length;
            for (let i = 0; i < f.length; i++) {
                const path = `${folder}/${c}_${i}.jpg`;
                // Sin x-upsert: el bucket solo tiene policy de INSERT (no UPDATE),
                // y el folder es nuevo por timestamp asi que no hay colision.
                const resUp = await fetch(`${URL_API}/storage/v1/object/denuncias/${path}`, {
                    method: 'POST',
                    headers: sbHeaders({ 'Content-Type': f[i].type }),
                    body: f[i]
                });
                if (!resUp.ok) throw new Error("Error al subir archivo fotográfico: " + c);
                links.push({ url: `${URL_API}/storage/v1/object/public/denuncias/${path}`, label: `${c}_${yaContados + i + 1}` });
            }
        }

        // 1.b. Subir el croquis como PNG al bucket. El canvas ya tiene la rosa
        // de los vientos + lo dibujado (sea trazo nuevo o el croquis viejo de la
        // ampliacion). Si falla la subida, dejamos croquis_url vacio y seguimos.
        let croquisUrl = '';
        if (croquisCanvas) {
            try {
                const croquisBlob = await new Promise(r => croquisCanvas.toBlob(r, 'image/png'));
                if (croquisBlob && croquisBlob.size > 0) {
                    const croquisPath = `${folder}/croquis.png`;
                    const resCroquis = await fetch(`${URL_API}/storage/v1/object/denuncias/${croquisPath}`, {
                        method: 'POST',
                        headers: sbHeaders({ 'Content-Type': 'image/png' }),
                        body: croquisBlob
                    });
                    if (resCroquis.ok) {
                        croquisUrl = `${URL_API}/storage/v1/object/public/denuncias/${croquisPath}`;
                    } else {
                        console.warn('No se pudo subir el croquis (status', resCroquis.status, ')');
                    }
                }
            } catch (errCroquis) {
                console.warn('Excepcion al subir croquis:', errCroquis);
            }
        }

        // 2. Crear o ampliar denuncia
        const payload = {
            fecha_hecho: val('fecha_hecho'),
            hora_hecho: val('hora_hecho'),
            nombre_chofer: val('nombre_chofer'),
            dni_chofer: val('dni_chofer'),
            tel_chofer: val('tel_chofer'),
            domicilio_chofer: val('domicilio_chofer'),
            loc_chofer: val('loc_chofer'),
            prov_chofer: val('prov_chofer'),
            cp_chofer: val('cp_chofer'),
            // Trazabilidad: si el conductor salio del padron guardamos legajo y
            // operacion para poder cruzar siniestralidad por OP en el reporte.
            legajo_chofer: (choferEncontrado && choferEncontrado.legajo) || '',
            op_chofer: (choferEncontrado && choferEncontrado.op) || '',
            link_pdf: linkFinal,
            danos_propios: val('danos_propios'),
            relato: val('descripcion'),
            patente_tercero: val('patente_tercero'),
            marca_tercero: val('marca_tercero'),
            seguro_tercero: val('seguro_tercero'),
            poliza_tercero: val('poliza_tercero'),
            danos_tercero: val('danos_tercero'),
            prop_nombre: val('prop_nombre'),
            prop_dni: val('prop_dni'),
            prop_tel: val('prop_tel'),
            provincia: val('provincia'),
            localidad: localidadFinal,
            cp: val('cp'),
            calle_interseccion: `${val('calle')} e ${val('interseccion')}`,
            dominio_asegurado: unidad.DOMINIO,
            croquis_url: croquisUrl
        };

        let resultado;
        if (esAmpliacion) {
            resultado = await rpc('ampliar_denuncia', {
                p_id: modoAmpliacion.id,
                p_patente: unidad.DOMINIO,
                p_chasis_suffix: unidad.__chasis_suffix || '',
                p_payload: payload
            });
        } else {
            resultado = await rpc('crear_denuncia', { p_payload: payload });
        }
        if (!resultado || !resultado.success) {
            throw new Error(esAmpliacion ? "Fallo al ampliar la denuncia." : "Fallo al crear denuncia en la base.");
        }
        nroSiniestroFinal = resultado.nro_siniestro;

        // 3. Llenar template con el SN asignado
        setVal('p-sini-id', nroSiniestroFinal);
        setVal('p-v-aseg', unidad.ASEGURADORA); setVal('p-v-pol', unidad.POLIZA);
        setVal('p-fecha', val('fecha_hecho')); setVal('p-hora', val('hora_hecho'));
        setVal('p-fecha-den', new Date().toLocaleDateString());
        setVal('p-loc', localidadFinal); setVal('p-prov', val('provincia'));
        setVal('p-calle', val('calle')); setVal('p-int', val('interseccion'));

        // Mostrar etiqueta (AMPLIACIÓN) en el header del PDF si corresponde
        const tagAmp = document.getElementById('p-ampliacion-tag');
        if (tagAmp) tagAmp.style.display = esAmpliacion ? 'inline' : 'none';

        setVal('p-aseg-razon', datosEmpresa.razon_social_completa || unidad.RAZON_SOCIAL);
        setVal('p-aseg-cuit', datosEmpresa.cuit); setVal('p-aseg-tel', datosEmpresa.telefono);
        setVal('p-aseg-dom', datosEmpresa.domicilio); setVal('p-aseg-cp', datosEmpresa.cp);

        let m = unidad.MODELO || "";
        let marcaFinal = (m.includes("MERCEDES") || m.includes("BENZ")) ? "MERCEDES BENZ" : (m.includes("CITROEN") ? "CITROEN" : m.split(' ')[0]);
        setVal('p-v-ma', marcaFinal); setVal('p-v-mo', m);
        setVal('p-v-do', unidad.DOMINIO); setVal('p-v-anio', unidad.ANIO);
        setVal('p-v-mot', unidad.MOTOR); setVal('p-v-cha', unidad.CHASIS);
        setVal('p-v-dan', val('danos_propios')); setVal('p-relato', val('descripcion'));

        setVal('p-c-nom', val('nombre_chofer')); setVal('p-c-dni', val('dni_chofer'));
        setVal('p-c-tel', val('tel_chofer')); setVal('p-c-dom', val('domicilio_chofer') + ", " + val('loc_chofer'));
        setVal('p-cp', val('cp_chofer'));

        setVal('p-t-p-no', val('prop_nombre') || val('nombre_chofer'));
        setVal('p-t-p-dn', val('prop_dni')); setVal('p-t-ma', val('marca_tercero'));
        setVal('p-t-mo', val('marca_tercero')); setVal('p-t-do', val('patente_tercero'));
        setVal('p-t-se', val('seguro_tercero')); setVal('p-t-po', val('poliza_tercero'));
        setVal('p-t-dan', val('danos_tercero'));

        const fotoContainer = document.getElementById('p-lista-fotos');
        if (fotoContainer) {
            fotoContainer.innerHTML = links.map(l => `<a href="${l.url}" target="_blank" style="text-decoration:none; color:#444; margin-right:15px;">• ${l.label}</a>`).join(' ');
        }

        // Inyectar el croquis dibujado por el usuario en el PDF
        const imgCroquis = document.getElementById('p-croquis');
        if (imgCroquis && croquisCanvas) {
            imgCroquis.src = croquisCanvas.toDataURL('image/png');
        }

        // 4. Generar y subir PDF
        await new Promise(r => setTimeout(r, 1200));
        const opt = { margin: 0, filename: `Denuncia_${unidad.DOMINIO}.pdf`, html2canvas: { scale: 2, useCORS: true, scrollY: 0 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } };
        const pdfBlob = await html2pdf().set(opt).from(document.getElementById('pdf-template')).output('blob');

        // Sanity check: el blob debe tener bytes
        if (!pdfBlob || pdfBlob.size === 0) {
            throw new Error("Se cargó la denuncia pero el PDF salió vacío. Contactar administración.");
        }

        // Subida del PDF con retry en path nuevo si falla. NO usamos x-upsert
        // porque el bucket solo tiene policy INSERT (no UPDATE).
        let pdfOk = false, ultimoError = '', pathFinalPdf = pdfPath, linkPdfFinalReal = linkFinal;
        for (let intento = 0; intento < 3 && !pdfOk; intento++) {
            const pathIntento = (intento === 0)
                ? pdfPath
                : `${folder}/Denuncia_Final_r${intento}_${Date.now()}.pdf`;
            try {
                const resPdfUp = await fetch(`${URL_API}/storage/v1/object/denuncias/${pathIntento}`, {
                    method: 'POST',
                    headers: sbHeaders({ 'Content-Type': 'application/pdf' }),
                    body: pdfBlob
                });
                if (resPdfUp.ok) {
                    pdfOk = true;
                    pathFinalPdf = pathIntento;
                    linkPdfFinalReal = `${URL_API}/storage/v1/object/public/denuncias/${pathIntento}`;
                    break;
                }
                // Capturamos el body del error para poder diagnosticar
                let detalle = '';
                try { detalle = await resPdfUp.text(); } catch {}
                console.warn(`Upload PDF intento ${intento+1} falló (${resPdfUp.status}):`, detalle);
                ultimoError = `HTTP ${resPdfUp.status}` + (detalle ? ` — ${detalle.slice(0,180)}` : '');
            } catch (errUp) {
                ultimoError = errUp && errUp.message ? errUp.message : 'fallo de red';
                console.warn('Upload PDF excepcion:', errUp);
            }
            if (intento < 2) await new Promise(r => setTimeout(r, 1000));
        }
        if (!pdfOk) {
            throw new Error("Se cargó la denuncia pero falló al subir el PDF (" + ultimoError + "). Contactar administración.");
        }
        // Si el path final difiere del original, actualizamos link_pdf del row
        if (pathFinalPdf !== pdfPath) {
            try {
                await rpc('actualizar_link_pdf', {
                    p_id: resultado.id,
                    p_patente: unidad.DOMINIO,
                    p_link_pdf: linkPdfFinalReal
                });
            } catch (e) {
                console.warn('No se pudo actualizar link_pdf en DB:', e.message);
            }
        }

        // 5. Enviar mail
        // Variables disponibles en el template de EmailJS:
        //   - asunto                       → "Alta SN20 AC963GK" o "Ampliacion SN20 AC963GK" (corto, listo para usar como subject)
        //   - link_pdf  / link             → URL del PDF
        //   - dominio   / dominio_nuestro  → patente del vehiculo asegurado (alias)
        //   - tipo_envio                   → "DENUNCIA NUEVA" o "AMPLIACION DE DENUNCIA"
        //   - nro_siniestro                → numero del SN
        const asuntoMail = (esAmpliacion ? "Ampliacion Siniestro" : "Alta Siniestro")
            + " - " + nroSiniestroFinal
            + " - " + unidad.DOMINIO;
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
            asunto: asuntoMail,
            link_pdf: linkPdfFinalReal,
            link: linkPdfFinalReal,
            dominio: unidad.DOMINIO,
            dominio_nuestro: unidad.DOMINIO,
            tipo_envio: esAmpliacion ? "AMPLIACION DE DENUNCIA" : "DENUNCIA NUEVA",
            nro_siniestro: nroSiniestroFinal,
            aviso_ampliacion: esAmpliacion ? " - AMPLIACION" : ""
        });

        const msgFinal = esAmpliacion
            ? `¡ÉXITO! Denuncia ${nroSiniestroFinal} ampliada correctamente.`
            : `¡ÉXITO! Denuncia cargada: ${nroSiniestroFinal}`;
        showStatus(msgFinal, "success");
        setTimeout(() => location.reload(), 3500);
    } catch (e) {
        showStatus("ERROR CRÍTICO: " + e.message, "error");
        btn.disabled = false;
        btn.innerText = "Finalizar Denuncia";
    }
}

// ============================================================================
// FLUJO INTERNO: 2 pasos, PDF de 1 carilla, asunto de mail distinto.
// Reusa el bucket de fotos (categoria "interno") y el mismo template de EmailJS.
// ============================================================================

// Datos del segundo vehiculo (validado contra la flota antes de pasar al paso 2)
let unidad2 = null;

function cambiarPasoInterno(paso) {
    document.querySelectorAll('#pantalla-formulario-interno .step').forEach(s => s.classList.add('hidden'));
    document.getElementById(`step-int-${paso}`).classList.remove('hidden');
    document.getElementById('progress-int').style.width = (paso * 50) + "%";
    document.getElementById('titulo-paso-int').innerText = paso === 1
        ? "Paso 1: Datos del hecho"
        : "Paso 2: Relato, presupuesto y fotos";
    document.getElementById('indicador-paso-int').innerText = `Paso ${paso} de 2`;
    window.scrollTo(0, 0);
}

async function validarYPasarInterno(proximoPaso) {
    if (proximoPaso === 2) {
        // Validacion estandar del paso 1
        const inputs = document.getElementById('step-int-1').querySelectorAll('[required]');
        let valido = true;
        inputs.forEach(i => {
            if (!i.checkValidity()) { i.style.borderColor = "red"; valido = false; }
            else { i.style.borderColor = "#ddd"; }
        });
        if (!valido) return;

        // Validacion extra: el segundo dominio debe ser de la flota Y distinto al primero
        const dom2 = document.getElementById('i_patente2').value.trim().toUpperCase();
        const status = document.getElementById('i_patente2_status');
        const inputP2 = document.getElementById('i_patente2');

        if (dom2 === unidad.DOMINIO) {
            inputP2.style.borderColor = "red";
            status.style.color = "#d9534f";
            status.innerText = "El segundo dominio no puede ser el mismo que el primero.";
            return;
        }

        status.style.color = "#555";
        status.innerText = "Validando dominio...";
        try {
            const data = await rpc('validar_unidad', { p_patente: dom2, p_chasis_suffix: '' });
            if (!data || !data.encontrado) {
                inputP2.style.borderColor = "red";
                status.style.color = "#d9534f";
                status.innerText = `Dominio ${dom2} no figura en la flota.`;
                return;
            }
            unidad2 = data.camion || {};
            status.style.color = "#28a745";
            status.innerText = `✓ ${unidad2.MODELO || ''}`;
        } catch (err) {
            status.style.color = "#d9534f";
            status.innerText = "Error al validar: " + err.message;
            return;
        }
    }
    cambiarPasoInterno(proximoPaso);
}

function abrirModalInterno() {
    modoInterno = true;
    const titulo = document.getElementById('modal-titulo');
    const detalle = document.getElementById('modal-detalle');
    titulo.innerText = "¿Generar constancia interna?";
    detalle.innerText = "Se guardará el registro en la base, se generará el PDF y se enviará por mail. No inicia trámite con aseguradora.";
    document.getElementById('modal-confirmacion').classList.remove('hidden');
}

// Volver desde un flujo (externo/interno) al selector inicial sin recargar la pagina.
function volverASelector() {
    document.getElementById('pantalla-formulario').classList.add('hidden');
    document.getElementById('pantalla-formulario-interno').classList.add('hidden');
    document.getElementById('pantalla-tipo-siniestro').classList.remove('hidden');
}

async function enviarSiniestroInterno() {
    const btn = document.getElementById('btn-finalizar-int');
    btn.innerText = "Enviando..."; btn.disabled = true;
    const ts = Date.now();
    const folder = `${unidad.DOMINIO}_INT_${ts}`;
    const pdfPath = `${folder}/Constancia_Interna.pdf`;
    const linkFinal = `${URL_API}/storage/v1/object/public/denuncias/${pdfPath}`;
    const val = (id) => {
        const el = document.getElementById(id);
        return el ? el.value.trim().toUpperCase() : "";
    };
    const valRaw = (id) => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : "";
    };

    try {
        // 1. Subir fotos (todas con categoria "interno")
        const links = [];
        const files = document.getElementById('i_fotos').files;
        for (let i = 0; i < files.length; i++) {
            const path = `${folder}/interno_${i}.jpg`;
            const resUp = await fetch(`${URL_API}/storage/v1/object/denuncias/${path}`, {
                method: 'POST',
                headers: sbHeaders({ 'Content-Type': files[i].type }),
                body: files[i]
            });
            if (!resUp.ok) throw new Error("Error al subir foto " + (i + 1));
            links.push({
                url: `${URL_API}/storage/v1/object/public/denuncias/${path}`,
                label: `foto_${i + 1}`
            });
        }

        // 2. Crear denuncia (tipo INTERNO). Aprovechamos los campos existentes:
        //    patente_tercero  -> dominio del 2do vehiculo nuestro
        //    marca_tercero    -> modelo del 2do vehiculo nuestro
        //    danos_tercero    -> no se usa (el relato cubre ambos)
        const payload = {
            fecha_hecho: valRaw('i_fecha'),
            hora_hecho: valRaw('i_hora'),
            nombre_chofer: val('i_nombre_chofer'),
            dni_chofer: val('i_dni_chofer'),
            tel_chofer: val('i_tel_chofer'),
            link_pdf: linkFinal,
            relato: valRaw('i_relato'),
            patente_tercero: val('i_patente2'),
            marca_tercero: (unidad2 && unidad2.MODELO) ? unidad2.MODELO : '',
            calle_interseccion: valRaw('i_lugar'),
            dominio_asegurado: unidad.DOMINIO,
            tipo_siniestro: 'INTERNO',
            presupuesto_monto: valRaw('i_presup_monto'),
            presupuesto_tipo: val('i_presup_tipo')
        };

        const resultado = await rpc('crear_denuncia', { p_payload: payload });
        if (!resultado || !resultado.success) {
            throw new Error("Fallo al crear constancia en la base.");
        }
        nroSiniestroFinal = resultado.nro_siniestro;

        // 3. Llenar template PDF interno
        setVal('pi-sini-id', nroSiniestroFinal);
        setVal('pi-fecha-den', new Date().toLocaleDateString());
        setVal('pi-fecha', valRaw('i_fecha'));
        setVal('pi-hora', valRaw('i_hora'));
        setVal('pi-lugar', valRaw('i_lugar'));
        setVal('pi-c-nom', val('i_nombre_chofer'));
        setVal('pi-c-dni', val('i_dni_chofer'));
        setVal('pi-c-tel', val('i_tel_chofer'));

        setVal('pi-v1-do', unidad.DOMINIO);
        setVal('pi-v2-do', (unidad2 && unidad2.DOMINIO) || val('i_patente2'));

        setVal('pi-relato', valRaw('i_relato'));

        const tipoP = val('i_presup_tipo');
        const tipoLabel = tipoP === 'DEFINITIVO' ? 'Definitivo'
            : tipoP === 'ESTIMADO' ? 'Estimado'
            : 'A presupuestar';
        setVal('pi-presup-tipo', tipoLabel);
        const monto = valRaw('i_presup_monto');
        setVal('pi-presup-monto', monto ? `$ ${monto}` : '—');

        const cont = document.getElementById('pi-lista-fotos');
        if (cont) {
            cont.innerHTML = links.length
                ? links.map(l => `<a href="${l.url}" target="_blank" style="text-decoration:none; color:#444; margin-right:15px;">• ${l.label}</a>`).join(' ')
                : '<span style="color:#888;">Sin fotos adjuntas.</span>';
        }

        // 4. Generar y subir PDF (1 carilla)
        await new Promise(r => setTimeout(r, 1000));
        const opt = {
            margin: 0,
            filename: `Constancia_Interna_${unidad.DOMINIO}.pdf`,
            html2canvas: { scale: 2, useCORS: true, scrollY: 0 },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };
        const pdfBlob = await html2pdf().set(opt).from(document.getElementById('pdf-template-interno')).output('blob');
        if (!pdfBlob || pdfBlob.size === 0) {
            throw new Error("El PDF salió vacío. Contactar administración.");
        }

        let pdfOk = false, ultimoError = '', pathFinalPdf = pdfPath, linkPdfFinalReal = linkFinal;
        for (let intento = 0; intento < 3 && !pdfOk; intento++) {
            const pathIntento = (intento === 0)
                ? pdfPath
                : `${folder}/Constancia_Interna_r${intento}_${Date.now()}.pdf`;
            try {
                const resPdfUp = await fetch(`${URL_API}/storage/v1/object/denuncias/${pathIntento}`, {
                    method: 'POST',
                    headers: sbHeaders({ 'Content-Type': 'application/pdf' }),
                    body: pdfBlob
                });
                if (resPdfUp.ok) {
                    pdfOk = true;
                    pathFinalPdf = pathIntento;
                    linkPdfFinalReal = `${URL_API}/storage/v1/object/public/denuncias/${pathIntento}`;
                    break;
                }
                let detalle = '';
                try { detalle = await resPdfUp.text(); } catch {}
                ultimoError = `HTTP ${resPdfUp.status}` + (detalle ? ` — ${detalle.slice(0,180)}` : '');
            } catch (errUp) {
                ultimoError = errUp && errUp.message ? errUp.message : 'fallo de red';
            }
            if (intento < 2) await new Promise(r => setTimeout(r, 1000));
        }
        if (!pdfOk) {
            throw new Error("Se cargó la constancia pero falló al subir el PDF (" + ultimoError + ").");
        }
        if (pathFinalPdf !== pdfPath) {
            try {
                await rpc('actualizar_link_pdf', {
                    p_id: resultado.id,
                    p_patente: unidad.DOMINIO,
                    p_link_pdf: linkPdfFinalReal
                });
            } catch (e) {
                console.warn('No se pudo actualizar link_pdf:', e.message);
            }
        }

        // 5. Enviar mail con asunto distinto
        const asuntoMail = "Constancia Interna - " + nroSiniestroFinal
            + " - " + unidad.DOMINIO + " vs " + (val('i_patente2'));
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
            asunto: asuntoMail,
            link_pdf: linkPdfFinalReal,
            link: linkPdfFinalReal,
            dominio: unidad.DOMINIO,
            dominio_nuestro: unidad.DOMINIO,
            tipo_envio: "CONSTANCIA INTERNA",
            nro_siniestro: nroSiniestroFinal,
            aviso_ampliacion: ""
        });

        showStatus(`¡ÉXITO! Constancia interna ${nroSiniestroFinal} generada.`, "success");
        setTimeout(() => location.reload(), 3500);
    } catch (e) {
        showStatus("ERROR: " + e.message, "error");
        btn.disabled = false;
        btn.innerText = "Finalizar Constancia";
    }
}
