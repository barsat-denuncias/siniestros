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

// Promesa de la carga de fotos de la denuncia original (ampliaciones).
// El envio la espera antes de armar el listado del PDF.
let cargaFotosViejas = null;

// Categorias conocidas (deben coincidir con los IDs f_<cat> del step 5)
const CATEGORIAS_FOTO = ['propios', 'tercero', 'doc_cond', 'doc_terc', 'otros', 'policial'];

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
// true mientras se esta bajando el croquis de la denuncia original. No se deja
// avanzar de paso hasta que termine: si no, se puede enviar una ampliacion con
// el croquis vacio sin darse cuenta.
let croquisPrevioPendiente = false;
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

// ============================================================================
// FECHAS
// Los <input type="date"> devuelven ISO ("2026-08-04") y toLocaleDateString()
// depende del idioma del navegador (en un equipo en ingles sale 8/4/2026).
// En los PDF siempre va formato argentino dd/mm/aaaa.
// ============================================================================
function fechaAR(valor) {
    if (!valor) return "";
    // Fecha ISO "2026-08-04" o "2026-08-04T..."
    const iso = String(valor).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
    // Ya viene en dd/mm/aaaa
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(String(valor).trim())) return String(valor).trim();
    return String(valor);
}

// ============================================================================
// TOKEN ANTI-ADIVINANZA PARA LOS ARCHIVOS
// El bucket 'denuncias' es publico: cualquiera que sepa la URL exacta puede
// abrir el archivo. Antes las carpetas eran PATENTE_<timestamp>, imposibles de
// adivinar. Ahora son PATENTE_SN12, que se adivina solo.
// Como los PDF tienen DNI, domicilio y telefono del chofer, se le agrega un
// token al azar al NOMBRE DEL ARCHIVO. La carpeta sigue siendo legible
// (PATENTE_SN12) pero el archivo no se puede adivinar.
// Listar el contenido de la carpeta no es posible: el bucket no tiene policy
// de SELECT para anon, solo de INSERT.
// ============================================================================
// ============================================================================
// COMPRESION DE FOTOS
// Una foto de celular pesa 3-5 MB. Redimensionada a 1600px de lado mayor queda
// en 250-400 KB, sin perder detalle para ver un choque.
// Esto ACELERA la carga: comprimir tarda milisegundos, subir 4 MB por datos
// moviles tarda varios segundos. Ademas alcanza para muchas mas denuncias en
// el mismo espacio.
// Si algo falla, se sube el archivo original: nunca bloquea la carga.
// ============================================================================
const FOTO_LADO_MAX = 1600;
const FOTO_CALIDAD  = 0.72;
// Debajo de este tamaño ya no vale la pena procesar. Estaba en 600 KB y era
// demasiado alto: dejaba pasar sin tocar capturas de pantalla PNG de 400-500 KB
// que convertidas a JPEG quedan en 50. Ademas se subian con extension .jpg
// pero contenido PNG, porque se reusaba el tipo del archivo original.
const FOTO_UMBRAL = 120 * 1024;

// Devuelve SIEMPRE un JPEG, salvo que el navegador no pueda leer la imagen.
// Que el resultado sea siempre del mismo tipo es lo que evita el desfasaje
// entre la extension del archivo y su contenido real.
function comprimirImagen(file) {
    return new Promise((resolve) => {
        // Los PDF (denuncia policial) y cualquier cosa que no sea imagen se
        // suben tal cual: no hay nada que redimensionar.
        if (!/^image\//i.test(file.type || '')) { resolve(file); return; }

        const yaEsJpegChico =
            file.size <= FOTO_UMBRAL &&
            /^image\/jpe?g$/i.test(file.type || '');
        if (yaEsJpegChico) { resolve(file); return; }

        const url = URL.createObjectURL(file);
        const img = new Image();

        img.onload = () => {
            try {
                let { width: w, height: h } = img;
                const escala = Math.min(1, FOTO_LADO_MAX / Math.max(w, h));
                w = Math.round(w * escala);
                h = Math.round(h * escala);

                const cv = document.createElement('canvas');
                cv.width = w; cv.height = h;
                const cx = cv.getContext('2d');
                cx.fillStyle = '#fff';       // los PNG con transparencia irian en negro
                cx.fillRect(0, 0, w, h);
                cx.drawImage(img, 0, 0, w, h);
                URL.revokeObjectURL(url);

                cv.toBlob(
                    (blob) => {
                        // Si el JPEG resultante pesa mas que el original (raro,
                        // pasa con imagenes muy chicas o planas), se queda el original
                        if (blob && blob.size && blob.size < file.size) resolve(blob);
                        else resolve(file);
                    },
                    'image/jpeg',
                    FOTO_CALIDAD
                );
            } catch {
                URL.revokeObjectURL(url);
                resolve(file);
            }
        };

        // El navegador no pudo leerla (HEIC viejo, archivo raro): va el original
        img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
        img.src = url;
    });
}

// Extension acorde al contenido real del blob que se va a subir.
// Sin esto, un PNG que no se pudo convertir terminaba llamandose .jpg
function extensionDe(blob) {
    const t = (blob && blob.type ? blob.type : '').toLowerCase();
    if (t === 'application/pdf') return 'pdf';
    if (t === 'image/png')  return 'png';
    if (t === 'image/webp') return 'webp';
    if (t === 'image/heic' || t === 'image/heif') return 'heic';
    return 'jpg';
}

// Muestra los datos de la dependencia solo si intervino la policia
function actualizarPolicia() {
    const sel = document.getElementById('intervino_policia');
    const box = document.getElementById('bloque-policia');
    if (!sel || !box) return;
    const hay = sel.value === 'SI';
    box.classList.toggle('hidden', !hay);
    ['dependencia_nombre', 'dependencia_nro'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.required = hay;
        if (!hay) { el.value = ''; el.style.borderColor = '#ddd'; }
    });
}

function tokenArchivo() {
    const b = new Uint8Array(6);
    crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

// ============================================================================
// MONTOS
// Formato argentino: punto para miles, coma para decimales.
// "1.234,56" -> 1234.56    "1234,5" -> 1234.5    "1234" -> 1234
// Tambien tolera "1,234.56" (formato ingles) mirando cual separador va ultimo.
// ============================================================================
function parseMontoAR(txt) {
    const s = String(txt == null ? '' : txt).trim().replace(/[^0-9.,]/g, '');
    if (!s) return null;
    const ultimaComa  = s.lastIndexOf(',');
    const ultimoPunto = s.lastIndexOf('.');
    let limpio;
    if (ultimaComa === -1 && ultimoPunto === -1) {
        limpio = s;
    } else if (ultimaComa > ultimoPunto) {
        // La coma es el decimal: se sacan los puntos de miles
        limpio = s.replace(/\./g, '').replace(',', '.');
    } else {
        // El punto es el decimal: se sacan las comas de miles
        limpio = s.replace(/,/g, '');
    }
    const n = parseFloat(limpio);
    return isNaN(n) ? null : n;
}

function formatMontoAR(n) {
    if (n === null || n === undefined || isNaN(n)) return '';
    return n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Fecha de hoy en formato argentino, sin depender del locale del navegador.
function hoyAR() {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getFullYear()}`;
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

// El cartel de estado es global (esta arriba de todas las pantallas). Si no se
// limpia, un "Unidad no encontrada" del paso inicial queda colgado hasta el
// final de la carga. Se borra al arrancar cualquier flujo.
function limpiarStatus() {
    const el = document.getElementById('status-msg');
    if (!el) return;
    el.innerText = '';
    el.className = '';
    el.style.display = 'none';
}

// Flag global para que el modal sepa a que envio despachar (externo/ampliacion vs interno).
// Antes reescribiamos el onclick del boton del modal, lo que rompia "ampliar" si el user
// abria/cancelaba un modal interno antes. Ahora el boton llama siempre a un dispatcher.
// Un unico valor con el flujo activo: 'EXTERNO' | 'INTERNO' | 'RC'.
// Antes eran dos booleanos sueltos (modoInterno / modoRC) y abrirModalInterno
// no reseteaba modoRC. Si alguien entraba a RC, abria el modal, cancelaba,
// volvia al inicio y cargaba un interno, el dispatcher veia modoRC todavia en
// true y enviaba la constancia interna por el flujo de RC, con los datos del
// formulario anterior. Con un solo valor eso no puede pasar.
let flujoActivo = 'EXTERNO';

// ============================================================================
// ENVIO REANUDABLE
// El envio tiene varias etapas: crear la denuncia, subir fotos, generar y subir
// el PDF, guardar los links y mandar el mail. Si falla una etapa tardia (tipico:
// el mail), el catch reactivaba el boton y al reintentar se volvia a llamar a
// crear_denuncia, generando una SEGUNDA denuncia del mismo hecho con otro
// numero. Esto guarda lo ya conseguido para retomar en vez de empezar de cero.
// ============================================================================
let envioEnCurso = null;   // { flujo, id, nro, folder, linkPdf, fotos }

function reiniciarEnvio() { envioEnCurso = null; }

// ============================================================================
// DESCARGA DEL PDF AL TERMINAR
// El PDF se genera en el celular antes de subirlo, asi que se puede ofrecer la
// descarga en el acto. Sirve para imprimirlo y que el chofer lo firme, y de
// paso deja de depender de que el link siga vivo.
// El blob se guarda en memoria hasta que el usuario lo baja o recarga.
// ============================================================================
let pdfParaDescargar = null;

function ofrecerDescargaPDF(blob, nombre) {
    pdfParaDescargar = { blob, nombre };
    const cont = document.getElementById('descarga-pdf');
    if (!cont) return;
    const btn = document.getElementById('btn-descargar-pdf');
    if (btn) btn.innerText = `Descargar ${nombre}`;
    cont.classList.remove('hidden');
}

// Al terminar no se recarga sola la pagina (se perderia el PDF descargable).
// Se muestra un boton para volver al inicio cuando el chofer ya lo bajo.
function mostrarVolverAlInicio() {
    const cont = document.getElementById('descarga-pdf');
    if (!cont || document.getElementById('btn-volver-inicio')) return;
    const b = document.createElement('button');
    b.id = 'btn-volver-inicio';
    b.type = 'button';
    b.className = 'btn-secundario';
    b.innerText = 'Cargar otra denuncia';
    b.onclick = () => location.reload();
    cont.appendChild(b);
}

function descargarPDFGenerado() {
    if (!pdfParaDescargar) return;
    const url = URL.createObjectURL(pdfParaDescargar.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = pdfParaDescargar.nombre;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Se libera despues, para no cortar la descarga en curso
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Bloquea todos los campos del formulario mientras se envia.
// Antes solo se deshabilitaba el boton Finalizar: se podia volver de paso y
// cambiar un dato mientras subian las fotos, con lo cual la base quedaba con
// un valor y el PDF con otro.
function congelarFormulario(pantallaId, congelar) {
    const cont = document.getElementById(pantallaId);
    if (!cont) return;
    cont.querySelectorAll('input, textarea, select, button').forEach(el => {
        if (el.id && el.id.startsWith('btn-descargar')) return;
        el.disabled = !!congelar;
    });
    cont.style.opacity = congelar ? '0.6' : '';
}

// Devuelve el envio a medias si corresponde al mismo flujo, o null
function envioReanudable(flujo) {
    if (envioEnCurso && envioEnCurso.flujo === flujo && envioEnCurso.id) {
        return envioEnCurso;
    }
    return null;
}

function abrirModal() {
    // Texto distinto si estamos ampliando vs denuncia nueva
    flujoActivo = 'EXTERNO';
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

// Dispatcher unico que decide a que flujo despacha segun flujoActivo.
function confirmarEnvioDispatcher() {
    cerrarModal();
    if (flujoActivo === 'RC')           enviarSiniestroRC();
    else if (flujoActivo === 'INTERNO') enviarSiniestroInterno();
    else                                enviarSiniestro();
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
// VINCULO TRACTOR / SEMIRREMOLQUE
// Un tractor casi siempre lleva un semi, y cada uno tiene su propia poliza,
// que puede ser distinta. Se hacen dos denuncias separadas, pero en cada una
// tiene que constar la otra unidad.
//   TRACTOR -> se pregunta si llevaba semi; si si, se pide el dominio
//   SEMI    -> se pide el tractor que lo traccionaba
//   CHASIS  -> no se pregunta nada (es la mayoria de la flota)
// La poliza de la unidad vinculada se busca en la base, no la escribe nadie.
// ============================================================================
let vinculoDatos = null;      // {dominio, poliza, tipo}
let timerVinculo = null;

function statusVinculo(msg, tipo) {
    const el = document.getElementById('vinculo-status');
    if (!el) return;
    el.innerText = msg || '';
    el.className = 'dni-status' + (tipo ? ' ' + tipo : '');
}

// Configura el bloque segun el tipo de la unidad que se esta denunciando
function configurarVinculo() {
    const bloque = document.getElementById('bloque-vinculo');
    if (!bloque) return;
    const tipo = String(unidad.TIPO_UNIDAD || '').toUpperCase();
    vinculoDatos = null;
    statusVinculo('');

    const inp = document.getElementById('vinculo_dominio');
    if (inp) { inp.value = ''; inp.style.borderColor = '#ddd'; }

    if (tipo === 'TRACTOR') {
        bloque.classList.remove('hidden');
        document.getElementById('vinculo-titulo').innerText = 'Semirremolque';
        document.getElementById('vinculo-label').innerText = '¿Llevaba semirremolque?*';
        document.getElementById('vinculo-pregunta').classList.remove('hidden');
        document.getElementById('vinculo_lleva').value = 'SI';
        if (inp) inp.placeholder = 'Dominio del semirremolque*';
    } else if (tipo === 'SEMI') {
        bloque.classList.remove('hidden');
        document.getElementById('vinculo-titulo').innerText = 'Tractor';
        // Un semi no circula solo: no se pregunta, se pide directo
        document.getElementById('vinculo-pregunta').classList.add('hidden');
        document.getElementById('vinculo_lleva').value = 'SI';
        if (inp) inp.placeholder = 'Dominio del tractor que lo traccionaba*';
    } else {
        bloque.classList.add('hidden');
        return;
    }
    actualizarVinculo();
}

function actualizarVinculo() {
    const lleva = (document.getElementById('vinculo_lleva') || {}).value || 'SI';
    const box = document.getElementById('vinculo-dominio-box');
    const inp = document.getElementById('vinculo_dominio');
    if (!box || !inp) return;
    const pide = lleva === 'SI';
    box.classList.toggle('hidden', !pide);
    inp.required = pide;
    if (!pide) { inp.value = ''; vinculoDatos = null; statusVinculo(''); }
}

async function buscarVinculo() {
    const inp = document.getElementById('vinculo_dominio');
    if (!inp) return;
    const dom = inp.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (dom.length < 6) { statusVinculo(''); vinculoDatos = null; return; }

    statusVinculo('Buscando unidad...', 'buscando');
    try {
        const d = await rpc('traer_datos_dominio', { p_dominio: dom });
        if (inp.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') !== dom) return;

        const esperado = String(unidad.TIPO_UNIDAD || '').toUpperCase() === 'TRACTOR' ? 'SEMI' : 'TRACTOR';

        if (!d || !d.encontrado) {
            vinculoDatos = { dominio: dom, poliza: '', tipo: esperado };
            statusVinculo('Ese dominio no figura en la base. Se va a registrar igual, pero sin número de póliza.', 'aviso');
            return;
        }
        const tipoReal = String(d.tipo_unidad || '').toUpperCase();
        vinculoDatos = { dominio: d.dominio, poliza: d.poliza || '', tipo: tipoReal || esperado };

        // Aviso si el dominio cargado no es del tipo que corresponde
        // (por ejemplo, un tractor donde se esperaba un semi). No bloquea:
        // puede haber unidades sin clasificar.
        if (tipoReal && tipoReal !== esperado) {
            statusVinculo(`${d.dominio} figura como ${tipoReal}, no como ${esperado}. Verificá el dominio. Póliza ${d.poliza || 'no registrada'}`, 'aviso');
        } else {
            statusVinculo(`${d.dominio} — Póliza ${d.poliza || 'no registrada'}`, 'ok');
        }
    } catch (err) {
        vinculoDatos = null;
        statusVinculo('No se pudo consultar. Revisá el dominio.', 'aviso');
        console.warn('traer_datos_dominio fallo:', err.message);
    }
}

function initVinculo() {
    const inp = document.getElementById('vinculo_dominio');
    if (!inp) return;
    inp.addEventListener('input', () => {
        inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        clearTimeout(timerVinculo);
        timerVinculo = setTimeout(buscarVinculo, 450);
    });
    inp.addEventListener('blur', () => { clearTimeout(timerVinculo); buscarVinculo(); });
}

// Linea que se agrega ARRIBA del relato, solo en el PDF. El relato que escribio
// el chofer no se toca.
function lineaVinculoPDF() {
    const tipoUnidad = String(unidad.TIPO_UNIDAD || '').toUpperCase();
    if (!vinculoDatos || !vinculoDatos.dominio) return '';
    const pol = vinculoDatos.poliza ? `, Póliza ${vinculoDatos.poliza}` : ', póliza no registrada';
    if (tipoUnidad === 'TRACTOR') {
        return `Llevaba al SEMIRREMOLQUE ${vinculoDatos.dominio}${pol}.`;
    }
    if (tipoUnidad === 'SEMI') {
        return `Traccionado por el TRACTOR ${vinculoDatos.dominio}${pol}.`;
    }
    return '';
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
// Cada consulta lleva un numero. Cuando vuelve, si ya se disparo otra mas
// nueva, la vieja se descarta. Sin esto, cambiar de DNI mientras hay una
// consulta en vuelo podia dejar los datos del chofer anterior, o peor: el
// catch de la consulta vieja borraba los datos de la nueva que si habia salido bien.
let seqBusquedaDni = 0;

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

// Solo saca la marca verde, deja los valores. Se usa en las ampliaciones,
// donde los campos vienen cargados de la denuncia original.
function limpiarAutocompletado() {
    choferEncontrado = null;
    CAMPOS_AUTOCOMPLETABLES.forEach(id => marcarCampo(id, null));
}

// VACIA los campos que habiamos completado nosotros. Se llama antes de cada
// busqueda nueva: si no, al cambiar de DNI quedaban colgados los datos del
// chofer anterior (y peor: si el chofer nuevo no tenia telefono, se quedaba
// el telefono del otro).
// Lo que el chofer escribio a mano no tiene la marca, asi que no se toca.
function limpiarCamposAutocompletados() {
    choferEncontrado = null;
    CAMPOS_AUTOCOMPLETABLES.forEach(id => {
        const el = document.getElementById(id);
        if (el && el.classList.contains('autocompletado')) {
            el.value = '';
            el.classList.remove('autocompletado');
        }
    });
}

// Los campos del conductor arrancan ocultos. Recien se muestran cuando el
// backend contesto: con los datos cargados si el DNI figura, o vacios si no.
// Asi el chofer no empieza a escribir al pedo algo que se iba a completar solo.
function mostrarDatosConductor(mostrar) {
    const box = document.getElementById('datos-conductor');
    if (box) box.classList.toggle('hidden', !mostrar);
    // El boton Siguiente acompaña al bloque, pero vive afuera para que se pueda
    // habilitar tambien en la carga manual sin DNI.
    const btn = document.getElementById('btn-paso2-siguiente');
    if (btn) btn.classList.toggle('hidden', !mostrar);
    // El atajo de carga manual solo tiene sentido mientras esta oculto
    const manual = document.getElementById('btn-cargar-manual');
    if (manual) manual.classList.toggle('hidden', !!mostrar);
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

    // "NO INFORMA" u otro texto sin digitos: no hay padron que consultar, pero
    // la carga tiene que poder seguir a mano.
    const textoLibre = /[A-Za-z]/.test(input.value) && dni.length === 0;
    if (textoLibre) {
        limpiarCamposAutocompletados();
        statusDni('Sin DNI: completá los datos del conductor a mano.', 'aviso');
        mostrarDatosConductor(true);
        return;
    }

    if (dni.length < 7) {
        statusDni(dni.length ? 'Seguí escribiendo el DNI…' : '');
        limpiarCamposAutocompletados();
        mostrarDatosConductor(false);
        return;
    }

    // Los datos del DNI anterior se borran YA, no cuando vuelve la respuesta:
    // mientras se consulta no tienen que quedar visibles datos de otra persona.
    limpiarCamposAutocompletados();
    statusDni('Buscando conductor...', 'buscando');

    const miTurno = ++seqBusquedaDni;
    try {
        const data = await rpc('buscar_chofer', { p_dni: dni });

        // Si mientras tanto se disparo otra consulta, esta llego tarde
        if (miTurno !== seqBusquedaDni) return;

        if (!data || !data.encontrado) {
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
        // Un error de una consulta vieja NO puede borrar los datos que trajo
        // una consulta posterior que si funciono.
        if (miTurno !== seqBusquedaDni) return;
        limpiarCamposAutocompletados();
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
let choferInterno = null;   // datos del padron para ESTE formulario, no el externo

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

    // Vacia lo que habiamos completado del DNI anterior
    const limpiarInternos = () => {
        choferInterno = null;
        ['i_nombre_chofer', 'i_tel_chofer'].forEach(id => {
            const el = document.getElementById(id);
            if (el && el.classList.contains('autocompletado')) {
                el.value = '';
                el.classList.remove('autocompletado');
            }
        });
    };

    if (dni.length < 7) { statusDniInterno(''); limpiarInternos(); return; }

    statusDniInterno('Buscando conductor...', 'buscando');
    try {
        const data = await rpc('buscar_chofer', { p_dni: dni });
        if (document.getElementById('i_dni_chofer').value.replace(/\D/g, '') !== dni) return;

        limpiarInternos();

        if (!data || !data.encontrado) {
            statusDniInterno('DNI no encontrado en el padrón. Completá los datos a mano.', 'aviso');
            return;
        }
        const c = data.chofer || {};
        // El interno tiene su PROPIA variable. Antes usaba choferEncontrado, que
        // es la del externo: si venias de cargar un externo, la constancia se
        // guardaba con el legajo y la operacion del OTRO chofer.
        choferInterno = c;
        rellenarCampoChofer('i_nombre_chofer', c.nombre_completo);
        rellenarCampoChofer('i_tel_chofer',    c.telefono);

        let msg = c.nombre_completo || 'Conductor encontrado';
        if (c.op) msg += ' — ' + c.op + (c.legajo ? ' (leg. ' + c.legajo + ')' : '');
        statusDniInterno(msg, 'ok');
    } catch (err) {
        limpiarInternos();
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
    // rosa de los vientos.
    // OJO: NO se marca como usado antes de que la imagen este efectivamente
    // pintada. Antes se marcaba de entrada, asi que si la descarga fallaba el
    // chofer podia avanzar con el fondo vacio y el croquis original se perdia
    // sin que nadie se enterara.
    if (croquisUrlPrevio) {
        croquisPrevioPendiente = true;
        const msg = document.getElementById('croquis-error');
        if (msg) {
            msg.style.display = 'block';
            msg.style.color = '#666';
            msg.innerText = 'Recuperando el croquis de la denuncia original...';
        }
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
    croquisPrevioPendiente = false;
}

// Carga la imagen del croquis previo sobre el canvas actual. Hacemos fetch como
// blob y la convertimos a object URL para evitar problemas de CORS al renderizar
// la imagen en el canvas (sino el canvas queda tainted y toBlob() falla).
async function cargarCroquisPrevio(url) {
    if (!url || !croquisCtx) return;

    const avisar = (texto, color) => {
        const msg = document.getElementById('croquis-error');
        if (!msg) return;
        msg.style.display = texto ? 'block' : 'none';
        msg.style.color = color || '#d9534f';
        msg.innerText = texto || '';
    };
    const fallo = (detalle) => {
        console.warn('Croquis previo:', detalle);
        croquisPrevioPendiente = false;
        croquisFueUsado = false;   // hay que volver a dibujarlo
        avisar('No se pudo recuperar el croquis de la denuncia original. '
             + 'Dibujalo de nuevo antes de continuar.');
    };

    try {
        const res = await fetch(url);
        if (!res.ok) { fallo('HTTP ' + res.status); return; }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            croquisCtx.drawImage(img, 0, 0, CROQUIS_SIZE, CROQUIS_SIZE);
            URL.revokeObjectURL(objectUrl);
            guardarEstadoCroquis();
            // Recien ACA vale como croquis valido
            croquisPrevioPendiente = false;
            croquisFueUsado = true;
            avisar('');
        };
        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            fallo('no se pudo renderizar la imagen');
        };
        img.src = objectUrl;
    } catch (err) {
        fallo(err && err.message ? err.message : 'fetch fallo');
    }
}

window.onload = function() {
    const hoy = new Date().toISOString().split('T')[0];
    document.getElementById('fecha_hecho').setAttribute('max', hoy);
    emailjs.init(EMAILJS_PUBLIC_KEY);
    ['dni_chofer', 'tel_chofer', 'prop_dni', 'prop_tel', 'cp', 'cp_chofer'].forEach(aplicarValidacionEstricta);
    initAutocompletadoChofer();
    initAutocompletadoChoferInterno();
    initAutocompletadoRC();
    initVinculo();
    ['rc_dni_chofer', 'rc_tel_contacto'].forEach(aplicarValidacionEstricta);
    document.getElementById('es_propietario').addEventListener('change', function() {
        document.getElementById('datos_propietario').classList.toggle('hidden', this.value === 'SI');
    });

    // ===== Validaciones del flujo INTERNO =====
    // DNI y telefono: solo numeros (sin "NO INFORMA", aca todo es obligatorio numerico)
    ['i_dni_chofer', 'i_tel_chofer'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
            el.value = el.value.replace(/[^0-9]/g, '');
        });
    });

    // El monto NO puede filtrarse borrando todo lo que no sea digito: pegar
    // "1.234,56" daba "123456", cien veces mas. Se aceptan puntos y coma, y al
    // salir del campo se normaliza a un numero con dos decimales.
    const inpMonto = document.getElementById('i_presup_monto');
    if (inpMonto) {
        inpMonto.addEventListener('input', () => {
            inpMonto.value = inpMonto.value.replace(/[^0-9.,]/g, '');
        });
        inpMonto.addEventListener('blur', () => {
            const n = parseMontoAR(inpMonto.value);
            inpMonto.value = (n === null) ? '' : formatMontoAR(n);
        });
    }
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

// El daño interno puede ser contra otra unidad de la flota o contra un bien
// de la empresa (porton, columna, rampa). Segun cual sea, se pide una cosa u
// otra y se ajusta que campo es obligatorio.
function actualizarTipoAfectado() {
    const tipo   = document.getElementById('i_tipo_afectado');
    const bUnid  = document.getElementById('bloque-unidad-afectada');
    const bBien  = document.getElementById('bloque-bien-afectado');
    const inpDom = document.getElementById('i_patente2');
    const inpBien= document.getElementById('i_bien_afectado');
    if (!tipo || !bUnid || !bBien) return;

    const esBien = tipo.value === 'BIEN';
    bUnid.classList.toggle('hidden', esBien);
    bBien.classList.toggle('hidden', !esBien);

    if (inpDom)  { inpDom.required  = !esBien; if (esBien) inpDom.value  = ''; }
    if (inpBien) { inpBien.required =  esBien; if (!esBien) inpBien.value = ''; }

    const st = document.getElementById('i_patente2_status');
    if (st) { st.innerText = ''; st.style.color = ''; }
    unidad2 = {};
}

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
    limpiarStatus();   // borra el error del intento anterior
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
                    Dominio: ${esc(s.dominio || '')}<br>
                    Siniestro: ${esc(fmtFecha(s.fecha_hecho))} ${esc(s.hora_hecho || '')} · Cargada: ${esc(fmtFecha(s.fecha_carga))}
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
    limpiarStatus();
    document.getElementById('pantalla-validacion').classList.add('hidden');
    document.getElementById('pantalla-seleccion').classList.add('hidden');
    document.getElementById('pantalla-formulario').classList.add('hidden');
    document.getElementById('pantalla-formulario-interno').classList.add('hidden');
    document.getElementById('pantalla-tipo-siniestro').classList.remove('hidden');
}

// Flujo EXTERNO (denuncia con tercero) — lo que existia antes.
function iniciarFlujoExterno() {
    modoAmpliacion = null;
    flujoActivo = 'EXTERNO';
    limpiarStatus();
    fotosViejasMantenidas = [];
    limpiarPreviewsFotosViejas();
    actualizarBannerAmpliacion();
    resetearCroquis();
    resetearPaso2();
    configurarVinculo();
    reiniciarEnvio();
    cargaFotosViejas = null;

    // Reset COMPLETO. Antes solo se limpiaba el conductor, el croquis y los
    // lesionados: relato, daños, datos del tercero y los archivos elegidos
    // quedaban de la carga anterior, y era facil terminar enviando datos
    // mezclados de dos siniestros distintos.
    [
        'fecha_hecho', 'hora_hecho', 'cp', 'calle', 'interseccion', 'manual_localidad',
        'danos_propios', 'descripcion',
        'patente_tercero', 'marca_tercero', 'seguro_tercero', 'poliza_tercero',
        'danos_tercero', 'nombre_cond_tercero', 'dni_cond_tercero', 'tel_cond_tercero',
        'prop_nombre', 'prop_dni', 'prop_tel'
    ].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.value = ''; el.style.borderColor = '#ddd'; }
    });

    const prov = document.getElementById('provincia');
    if (prov) { prov.selectedIndex = 0; actualizarLocalidades(); }
    const manual = document.getElementById('manual_localidad');
    if (manual) manual.classList.add('hidden');

    const selProp = document.getElementById('es_propietario');
    if (selProp) selProp.value = 'SI';
    const boxProp = document.getElementById('datos_propietario');
    if (boxProp) boxProp.classList.add('hidden');

    // Archivos elegidos en el paso 5
    CATEGORIAS_FOTO.forEach(c => {
        const f = document.getElementById(`f_${c}`);
        if (f) f.value = '';
    });

    // Reset de lesionados
    const selLes = document.getElementById('hubo_lesionados');
    if (selLes) selLes.value = 'NO';
    const listaLes = document.getElementById('lista-lesionados');
    if (listaLes) listaLes.innerHTML = '';
    contadorLesionados = 0;
    const bloqueLes = document.getElementById('bloque-lesionados');
    if (bloqueLes) bloqueLes.classList.add('hidden');

    // Por si venia de un envio anterior
    congelarFormulario('pantalla-formulario', false);
    const boxDesc = document.getElementById('descarga-pdf');
    if (boxDesc) boxDesc.classList.add('hidden');
    document.getElementById('pantalla-tipo-siniestro').classList.add('hidden');
    document.getElementById('pantalla-formulario-interno').classList.add('hidden');
    document.getElementById('pantalla-formulario').classList.remove('hidden');
    cambiarPaso(1);
}

// Flujo INTERNO (constancia entre dos vehiculos nuestros) — 2 pasos cortos.
function iniciarFlujoInterno() {
    modoAmpliacion = null;
    flujoActivo = 'INTERNO';
    limpiarStatus();
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
    // Reset del tipo de daño: por defecto contra otra unidad de la flota
    const selA = document.getElementById('i_tipo_afectado');
    if (selA) selA.value = 'UNIDAD';
    actualizarTipoAfectado();
    ultimoDniInterno = '';
    choferInterno = null;
    statusDniInterno('');
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
        // El croquis no es un adjunto: se dibuja aparte y tiene su propio lugar
        // en el PDF. El backend ya lo filtra; esto cubre denuncias viejas.
        const soloFotos = fotos.filter(f => {
            const base = (f.name || '').split('/').pop().toLowerCase();
            return !base.startsWith('croquis');
        });
        // Numerar dentro de cada categoria para los labels del PDF
        const counts = {};
        fotosViejasMantenidas = soloFotos.map(f => {
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
async function iniciarAmpliacion(idx) {
    const resumen = window.__siniestrosPrevios && window.__siniestrosPrevios[idx];
    if (!resumen) {
        showStatus("No se pudo recuperar la denuncia anterior. Refresque y reintente.", "error");
        return;
    }

    // La pantalla anterior solo tiene numero y fechas: los datos personales no
    // viajan hasta aca. Se piden ahora, y el backend solo los entrega si la
    // denuncia es de hoy, es externa y la patente coincide.
    let s;
    try {
        const resp = await rpc('traer_denuncia_ampliable', {
            p_id: resumen.id,
            p_patente: unidad.DOMINIO,
            p_chasis_suffix: unidad.__chasis_suffix || ''
        });
        if (!resp || !resp.ok) {
            showStatus("Esta denuncia ya no se puede ampliar. Hacé una denuncia nueva.", "error");
            return;
        }
        s = resp.denuncia;
    } catch (err) {
        showStatus("No se pudo recuperar la denuncia: " + err.message, "error");
        return;
    }

    modoAmpliacion = { id: s.id, nro_siniestro: s.nro_siniestro };
    limpiarStatus();
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

    // Se dispara en segundo plano para no trabar la pantalla, pero se guarda la
    // promesa: el envio la espera antes de armar el PDF. Antes no se esperaba,
    // asi que una carga rapida podia mandar la ampliacion SIN las fotos
    // originales, y el fallo solo quedaba en consola.
    cargaFotosViejas = cargarFotosViejas(s.id);
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

// ============================================================================
// LESIONADOS (Paso 4)
// Se guardan como array en la columna jsonb "lesionados" de Siniestros, asi
// se pueden cargar varios sin tocar el esquema.
// ============================================================================
let contadorLesionados = 0;

function actualizarLesionados() {
    const sel = document.getElementById('hubo_lesionados');
    const bloque = document.getElementById('bloque-lesionados');
    if (!sel || !bloque) return;
    const hay = sel.value === 'SI';
    bloque.classList.toggle('hidden', !hay);
    const lista = document.getElementById('lista-lesionados');
    if (hay && lista && lista.children.length === 0) {
        agregarLesionado();
    }
    if (!hay && lista) {
        lista.innerHTML = '';
        contadorLesionados = 0;
    }
}

function agregarLesionado(datos) {
    const lista = document.getElementById('lista-lesionados');
    if (!lista) return;
    const n = ++contadorLesionados;
    const d = datos || {};
    const esc = (s) => String(s == null ? '' : s).replace(/"/g, '&quot;');

    const card = document.createElement('div');
    card.className = 'lesionado-card';
    card.dataset.lesionado = '1';
    card.innerHTML = `
        <div class="lesionado-titulo">
            <span>Lesionado ${n}</span>
            <button type="button" class="quitar-lesionado">Quitar</button>
        </div>
        <input type="text" data-campo="apellido"  placeholder="Apellido*"          maxlength="40" value="${esc(d.apellido)}">
        <input type="text" data-campo="nombre"    placeholder="Nombre*"            maxlength="40" value="${esc(d.nombre)}">
        <input type="text" data-campo="dni"       placeholder="DNI*"               maxlength="10" inputmode="numeric" value="${esc(d.dni)}">
        <select data-campo="genero">
            <option value="">Género*</option>
            <option value="MASCULINO">Masculino</option>
            <option value="FEMENINO">Femenino</option>
            <option value="OTRO">Otro</option>
        </select>
        <input type="text" data-campo="domicilio" placeholder="Domicilio*"         maxlength="80" value="${esc(d.domicilio)}">
        <input type="text" data-campo="telefono"  placeholder="Teléfono*"          maxlength="15" value="${esc(d.telefono)}">
        <input type="text" data-campo="lesion"    placeholder="Tipo de lesión*"    maxlength="80" value="${esc(d.lesion)}">
        <input type="text" data-campo="hospital"  placeholder="Hospital donde se atendió*" maxlength="80" value="${esc(d.hospital)}">
    `;
    if (d.genero) {
        const sg = card.querySelector('[data-campo="genero"]');
        if (sg) sg.value = d.genero;
    }
    card.querySelector('.quitar-lesionado').addEventListener('click', () => {
        card.remove();
        renumerarLesionados();
        // Si se quitaron todos, volvemos el desplegable a NO
        const lista2 = document.getElementById('lista-lesionados');
        if (lista2 && lista2.children.length === 0) {
            const sel = document.getElementById('hubo_lesionados');
            if (sel) sel.value = 'NO';
            actualizarLesionados();
        }
    });
    lista.appendChild(card);
}

function renumerarLesionados() {
    const cards = document.querySelectorAll('#lista-lesionados .lesionado-card');
    contadorLesionados = cards.length;
    cards.forEach((c, i) => {
        const t = c.querySelector('.lesionado-titulo span');
        if (t) t.innerText = `Lesionado ${i + 1}`;
    });
}

// Devuelve el array listo para el payload. Solo se incluyen los que tengan
// al menos apellido o DNI cargado.
function leerLesionados() {
    const sel = document.getElementById('hubo_lesionados');
    if (!sel || sel.value !== 'SI') return [];
    const out = [];
    document.querySelectorAll('#lista-lesionados .lesionado-card').forEach(card => {
        const o = {};
        card.querySelectorAll('[data-campo]').forEach(inp => {
            o[inp.dataset.campo] = (inp.value || '').trim().toUpperCase();
        });
        if (o.apellido || o.dni) out.push(o);
    });
    return out;
}

// Valida que los lesionados cargados esten completos. Devuelve true si esta ok.
function validarLesionados() {
    const sel = document.getElementById('hubo_lesionados');
    if (!sel || sel.value !== 'SI') return true;
    const cards = document.querySelectorAll('#lista-lesionados .lesionado-card');
    if (cards.length === 0) return true;
    let ok = true;
    cards.forEach(card => {
        card.querySelectorAll('[data-campo]').forEach(inp => {
            if (!inp.value.trim()) { inp.style.borderColor = 'red'; ok = false; }
            else { inp.style.borderColor = '#ddd'; }
        });
    });
    return ok;
}

// Setea es_propietario a partir del valor GUARDADO. Antes se deducia de si
// prop_nombre estaba vacio, lo que daba la respuesta al reves en dos casos:
// un propietario cargado sin nombre se leia como "SI", y alguien que cargo
// propietario y despues cambio a "SI" se leia como "NO" (los campos quedan
// ocultos pero conservan el texto).
function setearEsPropietario(valorGuardado, propNombre) {
    const sel = document.getElementById('es_propietario');
    let v = String(valorGuardado || '').toUpperCase();
    if (v !== 'SI' && v !== 'NO') {
        // Denuncias viejas, anteriores a que se guardara el campo
        v = (propNombre && propNombre.trim()) ? 'NO' : 'SI';
    }
    sel.value = v;
    document.getElementById('datos_propietario').classList.toggle('hidden', v === 'SI');
}

function precargarFormulario(s) {
    // Paso 1
    setVal2('fecha_hecho', s.fecha_hecho);
    setVal2('hora_hecho', s.hora_hecho);
    setearProvinciaLocalidad(s.provincia, s.localidad);
    setVal2('cp', s.cp);

    // Unidad vinculada (semi o tractor) de la carga original
    configurarVinculo();
    if (s.semi_dominio) {
        vinculoDatos = {
            dominio: s.semi_dominio,
            poliza:  s.semi_poliza || '',
            tipo:    s.vinculo_tipo || ''
        };
        setVal2('vinculo_dominio', s.semi_dominio);
        const selLleva = document.getElementById('vinculo_lleva');
        if (selLleva) { selLleva.value = 'SI'; actualizarVinculo(); }
        statusVinculo(`${s.semi_dominio} — Póliza ${s.semi_poliza || 'no registrada'}`, 'ok');
    } else if (String(unidad.TIPO_UNIDAD || '').toUpperCase() === 'TRACTOR') {
        const selLleva = document.getElementById('vinculo_lleva');
        if (selLleva) { selLleva.value = 'NO'; actualizarVinculo(); }
    }

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
    setVal2('nombre_cond_tercero', s.nombre_cond_tercero);
    setVal2('dni_cond_tercero', s.dni_cond_tercero);
    setVal2('tel_cond_tercero', s.tel_cond_tercero);
    setearEsPropietario(s.es_propietario, s.prop_nombre);
    setVal2('prop_nombre', s.prop_nombre);
    setVal2('prop_dni', s.prop_dni);
    setVal2('prop_tel', s.prop_tel);

    // Lesionados: reconstruimos las fichas desde el jsonb guardado
    const selLes = document.getElementById('hubo_lesionados');
    const listaLes = document.getElementById('lista-lesionados');
    if (listaLes) { listaLes.innerHTML = ''; contadorLesionados = 0; }
    const previos = Array.isArray(s.lesionados) ? s.lesionados : [];
    if (selLes) selLes.value = (s.hubo_lesionados === 'SI' || previos.length) ? 'SI' : 'NO';
    const bloqueLes = document.getElementById('bloque-lesionados');
    if (bloqueLes) bloqueLes.classList.toggle('hidden', !(selLes && selLes.value === 'SI'));
    previos.forEach(l => agregarLesionado(l));
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
    if (proximoPaso === 4) {
        if (croquisPrevioPendiente) {
            showStatus("Esperá a que termine de cargar el croquis de la denuncia original.", "error");
            valido = false;
        } else if (!croquisFueUsado) {
            const msg = document.getElementById('croquis-error');
            if (msg) {
                msg.style.display = 'block';
                msg.style.color = '#d9534f';
                msg.innerText = 'Es obligatorio dibujar el croquis del siniestro.';
            }
            valido = false;
        }
    }

    // Al salir del paso 4: los lesionados cargados tienen que estar completos
    if (proximoPaso === 5 && !validarLesionados()) {
        valido = false;
    }

    if(valido) cambiarPaso(proximoPaso);
}

// ============================================================================
// ENVÍO DE SINIESTRO
// Flujo (el orden importa):
//   1. Crear/ampliar la denuncia en la base -> devuelve el numero de siniestro
//   2. Con ese SN se arma el nombre de la carpeta: PATENTE_SN
//   3. Subir fotos y croquis a esa carpeta
//   4. Llenar template, generar PDF y subirlo
//   5. Guardar en la denuncia los links del PDF y del croquis
//   6. Enviar mail por EmailJS
//
// Antes la carpeta se llamaba PATENTE_timestamp y la denuncia se creaba en el
// medio. Se invirtio para que el nombre de la carpeta sea rastreable contra el
// numero de siniestro.
// ============================================================================
async function enviarSiniestro() {
    const btn = document.getElementById('btn-finalizar');
    btn.innerText = "Enviando..."; btn.disabled = true;
    congelarFormulario('pantalla-formulario', true);
    const val = (id) => document.getElementById(id) ? document.getElementById(id).value.trim().toUpperCase() : "NO INFORMA";

    const getLocalidadFinal = () => {
        const sel = document.getElementById('localidad').value;
        const man = document.getElementById('manual_localidad').value.trim().toUpperCase();
        return (sel === "OTRA") ? man : sel;
    };
    const localidadFinal = getLocalidadFinal();

    const esAmpliacion = !!modoAmpliacion;

    try {
        // ---- 1. Crear (o ampliar) la denuncia PRIMERO, para tener el SN ----
        const payloadBase = {
            fecha_hecho: val('fecha_hecho'),
            hora_hecho: val('hora_hecho'),
            nombre_chofer: val('nombre_chofer'),
            dni_chofer: val('dni_chofer'),
            tel_chofer: val('tel_chofer'),
            domicilio_chofer: val('domicilio_chofer'),
            loc_chofer: val('loc_chofer'),
            prov_chofer: val('prov_chofer'),
            cp_chofer: val('cp_chofer'),
            legajo_chofer: (choferEncontrado && choferEncontrado.legajo) || '',
            op_chofer: (choferEncontrado && choferEncontrado.op) || '',
            danos_propios: val('danos_propios'),
            relato: val('descripcion'),
            patente_tercero: val('patente_tercero'),
            marca_tercero: val('marca_tercero'),
            seguro_tercero: val('seguro_tercero'),
            poliza_tercero: val('poliza_tercero'),
            danos_tercero: val('danos_tercero'),
            nombre_cond_tercero: val('nombre_cond_tercero'),
            dni_cond_tercero: val('dni_cond_tercero'),
            tel_cond_tercero: val('tel_cond_tercero'),
            // La respuesta explicita, no deducida despues de si prop_nombre
            // esta vacio. Si el conductor ES el propietario, los campos del
            // propietario se mandan vacios aunque hayan quedado escritos.
            es_propietario: val('es_propietario'),
            prop_nombre: val('es_propietario') === 'SI' ? '' : val('prop_nombre'),
            prop_dni:    val('es_propietario') === 'SI' ? '' : val('prop_dni'),
            prop_tel:    val('es_propietario') === 'SI' ? '' : val('prop_tel'),
            hubo_lesionados: val('hubo_lesionados'),
            lesionados: leerLesionados(),
            intervino_policia: val('intervino_policia'),
            dependencia_tipo:   val('intervino_policia') === 'SI' ? val('dependencia_tipo')   : '',
            dependencia_nombre: val('intervino_policia') === 'SI' ? val('dependencia_nombre') : '',
            dependencia_nro:    val('intervino_policia') === 'SI' ? val('dependencia_nro')    : '',
            provincia: val('provincia'),
            localidad: localidadFinal,
            cp: val('cp'),
            calle_interseccion: `${val('calle')} e ${val('interseccion')}`,
            dominio_asegurado: unidad.DOMINIO,
            // Unidad vinculada: el semi si esto es un tractor, o al reves
            semi_dominio: (vinculoDatos && vinculoDatos.dominio) || '',
            semi_poliza:  (vinculoDatos && vinculoDatos.poliza)  || '',
            vinculo_tipo: (vinculoDatos && vinculoDatos.tipo)    || ''
        };

        // Si venimos de un intento anterior que ya habia creado la denuncia,
        // NO se vuelve a crear: se retoma con el mismo numero.
        const previo = envioReanudable('EXTERNO');
        let idDenuncia;
        if (previo) {
            idDenuncia = previo.id;
            nroSiniestroFinal = previo.nro;
        } else {
            let resultado;
            if (esAmpliacion) {
                resultado = await rpc('ampliar_denuncia', {
                    p_id: modoAmpliacion.id,
                    p_patente: unidad.DOMINIO,
                    p_chasis_suffix: unidad.__chasis_suffix || '',
                    p_payload: payloadBase
                });
            } else {
                resultado = await rpc('crear_denuncia', { p_payload: payloadBase });
            }
            if (!resultado || !resultado.success) {
                throw new Error(esAmpliacion ? "Fallo al ampliar la denuncia." : "Fallo al crear denuncia en la base.");
            }
            nroSiniestroFinal = resultado.nro_siniestro;
            idDenuncia = resultado.id;
            envioEnCurso = {
                flujo: 'EXTERNO', id: idDenuncia, nro: nroSiniestroFinal,
                folder: null, linkPdf: null
            };
        }

        // ---- 2. Carpeta con el numero de siniestro ----
        // En una ampliacion los archivos van a una subcarpeta para no chocar
        // con los nombres de la carga original (el bucket no permite sobrescribir).
        const carpetaBase = `${unidad.DOMINIO}_${nroSiniestroFinal}`;
        // La subcarpeta de ampliacion se fija en el primer intento y se reusa,
        // para que un reintento no genere una segunda carpeta con la mitad.
        if (!envioEnCurso.folder) {
            envioEnCurso.folder = esAmpliacion
                ? `${carpetaBase}/ampliacion_${Date.now()}`
                : carpetaBase;
        }
        const folder = envioEnCurso.folder;
        const pdfPath = `${folder}/Denuncia_Final_${tokenArchivo()}.pdf`;
        const linkFinal = `${URL_API}/storage/v1/object/public/denuncias/${pdfPath}`;

        // ---- 3. Armar el listado de fotos del PDF ----
        //    - Arrancamos con las VIEJAS que el usuario mantuvo (solo en ampliacion).
        //      No se vuelven a subir, se reusa la URL original.
        //    - Despues subimos las NUEVAS y las concatenamos.
        const cats = ['propios', 'tercero', 'doc_cond', 'doc_terc', 'otros', 'policial'];
        let links;

        if (envioEnCurso.fotos) {
            // Reintento: las fotos ya estan arriba, no se vuelven a subir
            links = envioEnCurso.fotos;
        } else {
            links = [];
            // En una ampliacion hay que esperar a que terminen de listarse las
            // fotos de la carga original: si no, el PDF puede salir sin ellas.
            if (esAmpliacion && cargaFotosViejas) {
                btn.innerText = "Recuperando fotos anteriores...";
                try { await cargaFotosViejas; }
                catch (e) { console.warn('No se pudieron recuperar las fotos originales:', e); }
            }
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
                    const blob = await comprimirImagen(f[i]);
                    const path = `${folder}/${c}_${i}_${tokenArchivo()}.${extensionDe(blob)}`;
                    btn.innerText = "Subiendo fotos...";
                    const resUp = await fetch(`${URL_API}/storage/v1/object/denuncias/${path}`, {
                        method: 'POST',
                        headers: sbHeaders({ 'Content-Type': blob.type || 'image/jpeg' }),
                        body: blob
                    });
                    if (!resUp.ok) throw new Error("Error al subir archivo fotográfico: " + c);
                    links.push({
                        url: `${URL_API}/storage/v1/object/public/denuncias/${path}`,
                        label: `${c}_${yaContados + i + 1}`
                    });
                }
            }
            envioEnCurso.fotos = links;
        }
        btn.innerText = "Enviando...";

        // ---- 3.b. Subir el croquis como PNG. El canvas ya tiene la rosa de los
        // vientos + lo dibujado (trazo nuevo o el croquis viejo de la ampliacion).
        // Si falla la subida, dejamos croquis_url vacio y seguimos.
        let croquisUrl = '';
        if (croquisCanvas) {
            try {
                const croquisBlob = await new Promise(r => croquisCanvas.toBlob(r, 'image/png'));
                if (croquisBlob && croquisBlob.size > 0) {
                    const croquisPath = `${folder}/croquis_${tokenArchivo()}.png`;
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

        // ---- 4. Llenar template con el SN ya asignado ----
        setVal('p-sini-id', nroSiniestroFinal);
        setVal('p-v-aseg', unidad.ASEGURADORA_LEGAL || unidad.ASEGURADORA);
        setVal('p-v-pol', unidad.POLIZA);
        setVal('p-fecha', fechaAR(val('fecha_hecho'))); setVal('p-hora', val('hora_hecho'));
        setVal('p-fecha-den', hoyAR());
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
        setVal('p-v-dan', val('danos_propios'));
        // El relato del PDF lleva arriba la linea de la unidad vinculada
        // (semi o tractor). Lo que escribio el chofer queda intacto abajo.
        const lineaVin = lineaVinculoPDF();
        setVal('p-relato', lineaVin
            ? lineaVin + '\n\n' + val('descripcion')
            : val('descripcion'));

        setVal('p-c-nom', val('nombre_chofer')); setVal('p-c-dni', val('dni_chofer'));
        setVal('p-c-tel', val('tel_chofer'));
        // Domicilio va solo; localidad, provincia y CP tienen su propio campo.
        setVal('p-c-dom',  val('domicilio_chofer'));
        setVal('p-c-loc',  val('loc_chofer'));
        setVal('p-c-prov', val('prov_chofer'));
        setVal('p-cp',     val('cp_chofer'));

        // Conductor del tercero. OJO: antes esto caia por defecto en el nombre
        // de NUESTRO chofer cuando se marcaba "el conductor es el propietario".
        const esProp = val('es_propietario') === 'SI';
        setVal('p-t-c-no',    val('nombre_cond_tercero'));
        setVal('p-t-c-dn',    val('dni_cond_tercero'));
        setVal('p-t-c-tel',   val('tel_cond_tercero'));
        setVal('p-t-es-prop', esProp ? 'SI' : 'NO');
        // Si el conductor es el propietario, se repiten sus datos; si no, van
        // los del propietario que se cargaron aparte.
        setVal('p-t-p-no', esProp ? val('nombre_cond_tercero') : val('prop_nombre'));
        setVal('p-t-p-dn', esProp ? val('dni_cond_tercero')    : val('prop_dni'));
        setVal('p-t-ma', val('marca_tercero'));
        setVal('p-t-mo', val('marca_tercero')); setVal('p-t-do', val('patente_tercero'));
        setVal('p-t-se', val('seguro_tercero')); setVal('p-t-po', val('poliza_tercero'));
        setVal('p-t-dan', val('danos_tercero'));

        // Seccion 7: intervencion policial
        const contPol = document.getElementById('p-policia');
        if (contPol) {
            if (val('intervino_policia') === 'SI') {
                const tipos = { COMISARIA: 'Comisaría', FISCALIA: 'Fiscalía', AMBAS: 'Comisaría y Fiscalía' };
                const t = tipos[val('dependencia_tipo')] || val('dependencia_tipo');
                contPol.innerHTML = `
                    <div style="display:grid; grid-template-columns:1fr 1.4fr 1fr;">
                      <div><b>Intervino:</b> SÍ</div>
                      <div><b>Dependencia:</b> ${t} ${val('dependencia_nombre')}</div>
                      <div><b>Nº actuación:</b> ${val('dependencia_nro')}</div>
                    </div>`;
            } else {
                contPol.innerHTML = '<span>No intervino la policía.</span>';
            }
        }

        // Seccion 8: lesionados.
        // Va como tabla compacta y no como fichas sueltas: la hoja 2 tiene alto
        // fijo (296mm) y las fichas ocupaban ~89px cada una, con lo cual entraba
        // una sola antes de desbordar. Asi entran hasta 6 comodos.
        // Si hubiera mas, se achica la letra en vez de romper la maquetacion.
        const contLes = document.getElementById('p-lesionados');
        if (contLes) {
            const les = leerLesionados();
            if (!les.length) {
                contLes.innerHTML = '<span>No hubo personas lesionadas.</span>';
            } else {
                const escP = (s) => String(s == null ? '' : s)
                    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                // Ajuste de tamaño segun cuantos sean, para no desbordar la hoja
                const pt = les.length <= 4 ? '8.5pt' : (les.length <= 6 ? '7.5pt' : '6.5pt');
                contLes.style.fontSize = pt;

                const filas = les.map((l, i) => `
                    <tr style="border-top:1px solid #ddd;">
                      <td style="padding:2px 4px; vertical-align:top; white-space:nowrap;"><b>${i + 1}</b></td>
                      <td style="padding:2px 4px; vertical-align:top;">
                        <b>${escP(l.apellido)} ${escP(l.nombre)}</b> ·
                        DNI ${escP(l.dni)} · ${escP(l.genero)} · Tel ${escP(l.telefono)}<br>
                        ${escP(l.domicilio)}
                      </td>
                      <td style="padding:2px 4px; vertical-align:top;">
                        ${escP(l.lesion)}<br>${escP(l.hospital)}
                      </td>
                    </tr>`).join('');

                contLes.innerHTML = `
                    <table style="width:100%; border-collapse:collapse; line-height:1.25;">
                      <tr style="font-weight:bold; text-align:left;">
                        <td style="padding:2px 4px; width:16px;">#</td>
                        <td style="padding:2px 4px;">Datos de la persona</td>
                        <td style="padding:2px 4px; width:38%;">Lesión / Hospital</td>
                      </tr>
                      ${filas}
                    </table>`;
            }
        }

        // Las fotos van como links, no impresas: el PDF tiene que ser liviano
        // (AON maneja archivos de ~300 KB). Las imagenes quedan guardadas en el
        // bucket y se abren desde el link.
        const fotoContainer = document.getElementById('p-lista-fotos');
        if (fotoContainer) {
            fotoContainer.innerHTML = links.length
                ? links.map(l => `<a href="${l.url}" target="_blank" style="text-decoration:none; color:#444; margin-right:15px;">• ${l.label}</a>`).join(' ')
                : '<span style="color:#666;">Sin fotos adjuntas.</span>';
        }

        // Inyectar el croquis dibujado por el usuario en el PDF
        const imgCroquis = document.getElementById('p-croquis');
        if (imgCroquis && croquisCanvas) {
            imgCroquis.src = croquisCanvas.toDataURL('image/png');
        }

        // ---- 5. Generar y subir PDF ----
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
                // Con tokenArchivo() y no Date.now(): el nombre tiene que seguir
                // siendo imposible de adivinar tambien en los reintentos.
                : `${folder}/Denuncia_Final_r${intento}_${tokenArchivo()}.pdf`;
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
        // ---- 6. Guardar en la denuncia los links del PDF y del croquis ----
        // Como la denuncia se creo antes de subir los archivos, estos dos campos
        // se completan recien ahora.
        // Si esto falla, la denuncia queda en la base pero sin el PDF vinculado:
        // el panel la muestra como "Sin PDF". Antes el error iba solo a consola
        // y se anunciaba EXITO igual. Ahora corta.
        const cierre = await rpc('finalizar_denuncia', {
            p_id: idDenuncia,
            p_patente: unidad.DOMINIO,
            p_link_pdf: linkPdfFinalReal,
            p_croquis_url: croquisUrl
        });
        if (!cierre || !cierre.success) {
            throw new Error("El PDF se generó pero no quedó vinculado a la denuncia "
                + nroSiniestroFinal + ". Reintentá; si sigue fallando, avisá a administración.");
        }
        envioEnCurso.linkPdf = linkPdfFinalReal;

        // ---- 7. Enviar mail ----
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

        reiniciarEnvio();
        ofrecerDescargaPDF(pdfBlob, `Denuncia_${nroSiniestroFinal}_${unidad.DOMINIO}.pdf`);
        const msgFinal = esAmpliacion
            ? `¡ÉXITO! Denuncia ${nroSiniestroFinal} ampliada correctamente.`
            : `¡ÉXITO! Denuncia cargada: ${nroSiniestroFinal}`;
        showStatus(msgFinal, "success");
        // No se recarga sola: si lo hiciera, se perderia el PDF descargable.
        // El chofer recarga cuando termina, con el boton de abajo.
        mostrarVolverAlInicio();
    } catch (e) {
        congelarFormulario('pantalla-formulario', false);
        // Si la denuncia ya se creo, hay que decirlo: el chofer tiene que saber
        // que NO se perdio y que reintentar no la va a duplicar.
        const yaCreada = envioEnCurso && envioEnCurso.id;
        showStatus(yaCreada
            ? `La denuncia ${envioEnCurso.nro} YA quedó guardada, pero falló un paso posterior: `
              + e.message + ' Podés reintentar: se retoma la misma denuncia, no se crea otra.'
            : "ERROR: " + e.message + ' La denuncia NO se guardó.',
            "error");
        btn.disabled = false;
        btn.innerText = yaCreada ? "Reintentar envío" : "Finalizar Denuncia";
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

        // Si el daño fue contra un bien de la empresa no hay segundo dominio
        const tipoAfect = (document.getElementById('i_tipo_afectado') || {}).value || 'UNIDAD';
        if (tipoAfect === 'BIEN') {
            const inpBien = document.getElementById('i_bien_afectado');
            if (!inpBien || !inpBien.value.trim()) {
                if (inpBien) inpBien.style.borderColor = "red";
                return;
            }
            inpBien.style.borderColor = "#ddd";
            unidad2 = {};
            cambiarPasoInterno(2);
            return;
        }

        // Contra otra unidad: tiene que estar en la flota Y bajo la MISMA POLIZA.
        // Si son polizas distintas hay reclamo entre companias y corresponde
        // denuncia con tercero, no constancia interna.
        const dom2 = document.getElementById('i_patente2').value.trim().toUpperCase();
        const status = document.getElementById('i_patente2_status');
        const inputP2 = document.getElementById('i_patente2');

        status.style.color = "#555";
        status.innerText = "Validando dominio...";
        try {
            const chequeo = await rpc('validar_unidad_interna', {
                p_dominio1: unidad.DOMINIO,
                p_dominio2: dom2
            });

            if (!chequeo || !chequeo.ok) {
                inputP2.style.borderColor = "red";
                status.style.color = "#d9534f";
                status.innerText = (chequeo && chequeo.mensaje)
                    ? chequeo.mensaje
                    : `Dominio ${dom2} no figura en la flota.`;
                return;
            }

            // El dominio pudo haber cambiado mientras se validaba: si no
            // coincide con lo que hay en el campo, no se avanza.
            const domAhora = document.getElementById('i_patente2').value.trim().toUpperCase();
            if (domAhora !== dom2) {
                status.style.color = "#d9534f";
                status.innerText = "El dominio cambió mientras se validaba. Probá de nuevo.";
                return;
            }

            inputP2.style.borderColor = "#ddd";
            unidad2 = {
                DOMINIO: dom2,
                MODELO: chequeo.modelo,
                RAZON_SOCIAL: chequeo.razon_social,
                POLIZA: chequeo.poliza
            };
            status.style.color = "#28a745";
            status.innerText = `✓ ${chequeo.modelo || ''} — misma póliza (${chequeo.poliza})`;
        } catch (err) {
            status.style.color = "#d9534f";
            status.innerText = "Error al validar: " + err.message;
            return;
        }
    }
    cambiarPasoInterno(proximoPaso);
}

function abrirModalInterno() {
    // Validar ANTES de abrir el modal. Estos pasos no son un submit nativo,
    // asi que el required del HTML no se dispara solo: se podia confirmar una
    // constancia sin relato.
    if (!validarPasoInterno2()) return;

    flujoActivo = 'INTERNO';
    const titulo = document.getElementById('modal-titulo');
    const detalle = document.getElementById('modal-detalle');
    titulo.innerText = "¿Generar constancia interna?";
    detalle.innerText = "Se guardará el registro en la base, se generará el PDF y se enviará por mail. No inicia trámite con aseguradora.";
    document.getElementById('modal-confirmacion').classList.remove('hidden');
}

// Chequea los obligatorios del ultimo paso del interno. Ademas de checkValidity
// se exige contenido real: un campo con solo espacios no cuenta como completo.
function validarPasoInterno2() {
    const paso = document.getElementById('step-int-2');
    if (!paso) return true;
    let ok = true;
    paso.querySelectorAll('[required]').forEach(i => {
        const vacio = !String(i.value || '').trim();
        if (vacio || !i.checkValidity()) { i.style.borderColor = 'red'; ok = false; }
        else { i.style.borderColor = '#ddd'; }
    });
    if (!ok) showStatus("Faltan datos obligatorios en este paso.", "error");
    return ok;
}

// ============================================================================
// FLUJO RC — RESPONSABILIDAD CIVIL
// Un empleado dana un bien de un tercero sin que intervenga un camion.
// No hay patente que validar, asi que arranca directo desde la pantalla
// inicial. Comparte la numeracion SN con el resto de las denuncias.
// ============================================================================
let ultimoDniRC = '';
let timerDniRC = null;
let choferRC = null;

function statusDniRC(msg, tipo) {
    const el = document.getElementById('rc-dni-status');
    if (!el) return;
    el.innerText = msg || '';
    el.className = 'dni-status' + (tipo ? ' ' + tipo : '');
}

async function buscarChoferRC() {
    const input = document.getElementById('rc_dni_chofer');
    if (!input) return;
    const dni = input.value.replace(/\D/g, '');
    if (dni === ultimoDniRC) return;
    ultimoDniRC = dni;

    const limpiar = () => {
        choferRC = null;
        ['rc_nombre_chofer', 'rc_tel_contacto'].forEach(id => {
            const el = document.getElementById(id);
            if (el && el.classList.contains('autocompletado')) {
                el.value = '';
                el.classList.remove('autocompletado');
            }
        });
    };

    if (dni.length < 7) { statusDniRC(''); limpiar(); return; }

    statusDniRC('Buscando empleado...', 'buscando');
    try {
        const data = await rpc('buscar_chofer', { p_dni: dni });
        if (document.getElementById('rc_dni_chofer').value.replace(/\D/g, '') !== dni) return;
        limpiar();
        if (!data || !data.encontrado) {
            statusDniRC('DNI no encontrado en el padrón. Completá los datos a mano.', 'aviso');
            return;
        }
        const c = data.chofer || {};
        choferRC = c;
        rellenarCampoChofer('rc_nombre_chofer', c.nombre_completo);
        rellenarCampoChofer('rc_tel_contacto', c.telefono);
        let msg = c.nombre_completo || 'Empleado encontrado';
        if (c.op) msg += ' — ' + c.op + (c.legajo ? ' (leg. ' + c.legajo + ')' : '');
        statusDniRC(msg, 'ok');
    } catch (err) {
        limpiar();
        statusDniRC('No se pudo consultar el padrón. Cargá los datos a mano.', 'aviso');
        console.warn('buscar_chofer (RC) fallo:', err.message);
    }
}

function initAutocompletadoRC() {
    const input = document.getElementById('rc_dni_chofer');
    if (!input) return;
    input.addEventListener('input', () => {
        clearTimeout(timerDniRC);
        timerDniRC = setTimeout(buscarChoferRC, 450);
    });
    input.addEventListener('blur', () => {
        clearTimeout(timerDniRC);
        buscarChoferRC();
    });
    ['rc_nombre_chofer', 'rc_tel_contacto'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', () => el.classList.remove('autocompletado'));
    });
}

// ============================================================================
// AMPLIACION DE RIESGOS VARIOS — solo administracion
// A diferencia de las de camion, estas no tienen limite de "mismo dia": el caso
// de uso es justamente que los datos del damnificado llegan despues.
// Por eso se protegen con clave, que se valida CONTRA EL SERVIDOR. La clave no
// esta en este archivo: solo viaja lo que escribe el usuario, y el backend la
// compara contra un hash. Tiene freno de 10 intentos fallidos por hora.
// ============================================================================
let claveRV = '';            // solo en memoria, mientras dura la pantalla
let ampliandoRV = null;      // {id, nro} de la denuncia que se esta ampliando

function abrirAmpliarRV() {
    limpiarStatus();
    claveRV = '';
    document.getElementById('rv_clave').value = '';
    document.getElementById('rv-lista').innerHTML = '';
    document.getElementById('rv-clave-status').innerText = '';
    document.getElementById('pantalla-validacion').classList.add('hidden');
    document.getElementById('pantalla-ampliar-rv').classList.remove('hidden');
}

function cerrarAmpliarRV() {
    claveRV = '';
    document.getElementById('pantalla-ampliar-rv').classList.add('hidden');
    document.getElementById('pantalla-validacion').classList.remove('hidden');
}

async function listarRVAmpliables() {
    const clave = document.getElementById('rv_clave').value;
    const st = document.getElementById('rv-clave-status');
    const lista = document.getElementById('rv-lista');
    lista.innerHTML = '';
    st.innerText = 'Verificando...'; st.className = 'dni-status buscando';

    try {
        const r = await rpc('listar_rv_ampliables', { p_clave: clave });
        if (!r || !r.ok) {
            st.innerText = 'Clave incorrecta.'; st.className = 'dni-status aviso';
            return;
        }
        claveRV = clave;
        const denuncias = r.denuncias || [];
        if (!denuncias.length) {
            st.innerText = 'No hay denuncias de Riesgos Varios para ampliar.';
            st.className = 'dni-status aviso';
            return;
        }
        st.innerText = `${denuncias.length} denuncia${denuncias.length === 1 ? '' : 's'} disponible${denuncias.length === 1 ? '' : 's'}.`;
        st.className = 'dni-status ok';

        const esc = (s) => String(s == null ? '' : s)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;');
        const fmt = (f) => {
            if (!f) return 'S/D';
            const p = String(f).slice(0,10).split('-');
            return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : f;
        };
        window.__rvPrevias = {};
        lista.innerHTML = denuncias.map((d, i) => {
            window.__rvPrevias[i] = d;
            return `
            <div class="sin-card ampliable">
                <div class="sin-info">
                    <strong>${esc(d.nro_siniestro)}</strong><br>
                    ${esc(fmt(d.fecha_hecho))} ${esc(d.hora_hecho || '')} · ${esc(d.nombre_chofer || 'S/D')}<br>
                    ${esc(d.lugar || '')}
                </div>
                <button class="btn-ampliar" onclick="iniciarAmpliacionRV(${i})">Ampliar</button>
            </div>`;
        }).join('');
    } catch (err) {
        st.innerText = 'Error: ' + err.message;
        st.className = 'dni-status aviso';
    }
}

async function iniciarAmpliacionRV(idx) {
    const resumen = window.__rvPrevias && window.__rvPrevias[idx];
    if (!resumen) return;
    try {
        const r = await rpc('traer_rv_ampliable', { p_id: resumen.id, p_clave: claveRV });
        if (!r || !r.ok) { showStatus('No se pudo recuperar la denuncia.', 'error'); return; }
        const d = r.denuncia;

        ampliandoRV = { id: d.id, nro: d.nro_siniestro };
        iniciarFlujoRC();          // deja el formulario limpio y visible
        ampliandoRV = { id: d.id, nro: d.nro_siniestro };   // iniciarFlujoRC lo borra

        // Precarga
        const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
        set('rc_dni_chofer', d.dni_chofer);       set('rc_nombre_chofer', d.nombre_chofer);
        set('rc_fecha', d.fecha_hecho);           set('rc_hora', d.hora_hecho);
        set('rc_calle', d.calle_interseccion);    set('rc_localidad', d.localidad);
        set('rc_provincia', d.provincia);         set('rc_tel_contacto', d.tel_chofer);
        set('rc_mail_contacto', d.mail_contacto); set('rc_danos', d.danos_tercero);
        set('rc_relato', d.relato);
        set('rc_terc_nombre', d.nombre_cond_tercero); set('rc_terc_doc', d.dni_cond_tercero);
        set('rc_terc_tel', d.tel_cond_tercero);       set('rc_terc_dom', d.tercero_domicilio);
        set('rc_terc_bien', d.patente_tercero);
        const selA = document.getElementById('rc_autoridad');
        if (selA && d.intervino_autoridad) selA.value = d.intervino_autoridad;
        choferRC = (d.legajo_chofer || d.op_chofer)
            ? { legajo: d.legajo_chofer, op: d.op_chofer } : null;
        ultimoDniRC = String(d.dni_chofer || '').replace(/\D/g, '');

        showStatus(`Ampliando la denuncia ${d.nro_siniestro}. Completá lo que falte y finalizá.`, 'success');
    } catch (err) {
        showStatus('Error: ' + err.message, 'error');
    }
}

function iniciarFlujoRC() {
    modoAmpliacion = null;
    ampliandoRV = null;
    flujoActivo = 'RC';
    limpiarStatus();
    reiniciarEnvio();
    document.getElementById('pantalla-ampliar-rv').classList.add('hidden');
    unidad = {};
    datosEmpresa = {};
    choferRC = null;
    ultimoDniRC = '';
    statusDniRC('');

    ['rc_dni_chofer','rc_nombre_chofer','rc_calle','rc_localidad','rc_provincia',
     'rc_tel_contacto','rc_mail_contacto','rc_danos','rc_relato',
     'rc_terc_nombre','rc_terc_doc','rc_terc_tel','rc_terc_dom','rc_terc_bien'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.value = ''; el.style.borderColor = '#ddd'; el.classList.remove('autocompletado'); }
    });
    const selA = document.getElementById('rc_autoridad');
    if (selA) selA.value = 'NO';
    const f = document.getElementById('rc_fotos');
    if (f) f.value = '';

    const hoy = new Date().toISOString().split('T')[0];
    const fech = document.getElementById('rc_fecha');
    if (fech) fech.setAttribute('max', hoy);

    document.getElementById('pantalla-validacion').classList.add('hidden');
    document.getElementById('pantalla-seleccion').classList.add('hidden');
    document.getElementById('pantalla-tipo-siniestro').classList.add('hidden');
    document.getElementById('pantalla-formulario').classList.add('hidden');
    document.getElementById('pantalla-formulario-interno').classList.add('hidden');
    document.getElementById('pantalla-formulario-rc').classList.remove('hidden');
    cambiarPasoRC(1);
}

function volverAInicioRC() {
    limpiarStatus();
    document.getElementById('pantalla-formulario-rc').classList.add('hidden');
    document.getElementById('pantalla-validacion').classList.remove('hidden');
}

function cambiarPasoRC(paso) {
    ['step-rc-1', 'step-rc-2'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
    const actual = document.getElementById(`step-rc-${paso}`);
    if (actual) actual.classList.remove('hidden');
    const prog = document.getElementById('progress-rc');
    if (prog) prog.style.width = (paso * 50) + '%';
    const tit = document.getElementById('titulo-paso-rc');
    if (tit) tit.innerText = paso === 1 ? 'Paso 1: El hecho' : 'Paso 2: Daños y damnificado';
    const ind = document.getElementById('indicador-paso-rc');
    if (ind) ind.innerText = `Paso ${paso} de 2`;
    window.scrollTo(0, 0);
}

function validarYPasarRC(proximoPaso) {
    const inputs = document.getElementById(`step-rc-${proximoPaso - 1}`).querySelectorAll('[required]');
    let valido = true;
    inputs.forEach(i => {
        if (!i.checkValidity()) { i.style.borderColor = 'red'; valido = false; }
        else { i.style.borderColor = '#ddd'; }
    });
    if (valido) cambiarPasoRC(proximoPaso);
}

function abrirModalRC() {
    // Misma validacion que el interno: sin esto se podia confirmar sin daños
    // ni relato y el error aparecia recien cuando lo rechazaba la base.
    const paso = document.getElementById('step-rc-2');
    if (paso) {
        let ok = true;
        paso.querySelectorAll('[required]').forEach(i => {
            const vacio = !String(i.value || '').trim();
            if (vacio || !i.checkValidity()) { i.style.borderColor = 'red'; ok = false; }
            else { i.style.borderColor = '#ddd'; }
        });
        if (!ok) { showStatus("Faltan datos obligatorios en este paso.", "error"); return; }
    }

    flujoActivo = 'RC';
    document.getElementById('modal-titulo').innerText = "¿Generar la denuncia?";
    document.getElementById('modal-detalle').innerText =
        "Se guardará el registro, se generará el PDF y se enviará por mail.";
    document.getElementById('modal-confirmacion').classList.remove('hidden');
}

async function enviarSiniestroRC() {
    const btn = document.getElementById('btn-finalizar-rc');
    btn.innerText = "Enviando..."; btn.disabled = true;
    congelarFormulario('pantalla-formulario-rc', true);
    const val    = (id) => { const e = document.getElementById(id); return e ? e.value.trim().toUpperCase() : ""; };
    const valRaw = (id) => { const e = document.getElementById(id); return e ? e.value.trim() : ""; };

    try {
        // 1. Crear la denuncia primero, para tener el numero
        const payload = {
            tipo_siniestro: 'RC',
            fecha_hecho: valRaw('rc_fecha'),
            hora_hecho: valRaw('rc_hora'),
            nombre_chofer: val('rc_nombre_chofer'),
            dni_chofer: val('rc_dni_chofer'),
            tel_chofer: val('rc_tel_contacto'),
            legajo_chofer: (choferRC && choferRC.legajo) || '',
            op_chofer: (choferRC && choferRC.op) || '',
            calle_interseccion: val('rc_calle'),
            localidad: val('rc_localidad'),
            provincia: val('rc_provincia'),
            danos_tercero: val('rc_danos'),
            relato: valRaw('rc_relato'),
            intervino_autoridad: val('rc_autoridad'),
            mail_contacto: valRaw('rc_mail_contacto'),
            // Damnificado (opcional)
            nombre_cond_tercero: val('rc_terc_nombre'),
            dni_cond_tercero: val('rc_terc_doc'),
            tel_cond_tercero: val('rc_terc_tel'),
            tercero_domicilio: val('rc_terc_dom'),
            patente_tercero: val('rc_terc_bien')
        };

        const previo = envioReanudable('RC');
        let idDenuncia;
        if (previo) {
            idDenuncia = previo.id;
            nroSiniestroFinal = previo.nro;
        } else if (ampliandoRV) {
            // Ampliacion: actualiza la denuncia existente, no crea una nueva
            const r = await rpc('ampliar_rv', {
                p_id: ampliandoRV.id, p_clave: claveRV, p_payload: payload
            });
            if (!r || !r.success) throw new Error("Fallo al ampliar la denuncia.");
            nroSiniestroFinal = r.nro_siniestro;
            idDenuncia = r.id;
            envioEnCurso = { flujo: 'RC', id: idDenuncia, nro: nroSiniestroFinal };
        } else {
            const resultado = await rpc('crear_denuncia', { p_payload: payload });
            if (!resultado || !resultado.success) throw new Error("Fallo al crear la denuncia en la base.");
            nroSiniestroFinal = resultado.nro_siniestro;
            idDenuncia = resultado.id;
            envioEnCurso = { flujo: 'RC', id: idDenuncia, nro: nroSiniestroFinal };
        }

        // 2. Carpeta con el numero de denuncia. Las ampliaciones van a una
        // subcarpeta para no chocar con los archivos de la carga original.
        const folder = ampliandoRV
            ? `RV_${nroSiniestroFinal}/ampliacion_${Date.now()}`
            : `RV_${nroSiniestroFinal}`;
        const pdfPath = `${folder}/Denuncia_RV_${tokenArchivo()}.pdf`;
        const linkFinal = `${URL_API}/storage/v1/object/public/denuncias/${pdfPath}`;

        // 3. Fotos. En un reintento no se vuelven a subir.
        const links = envioEnCurso.fotos || [];
        const files = envioEnCurso.fotos ? [] : document.getElementById('rc_fotos').files;
        for (let i = 0; i < files.length; i++) {
            const blob = await comprimirImagen(files[i]);
            const path = `${folder}/rc_${i}_${tokenArchivo()}.${extensionDe(blob)}`;
            btn.innerText = "Subiendo fotos...";
            const resUp = await fetch(`${URL_API}/storage/v1/object/denuncias/${path}`, {
                method: 'POST',
                headers: sbHeaders({ 'Content-Type': blob.type || 'image/jpeg' }),
                body: blob
            });
            if (!resUp.ok) throw new Error("Error al subir foto " + (i + 1));
            links.push({ url: `${URL_API}/storage/v1/object/public/denuncias/${path}`, label: `foto_${i + 1}` });
        }
        envioEnCurso.fotos = links;
        btn.innerText = "Enviando...";

        // 4. Llenar el template.
        // Es una constancia interna: no lleva datos de poliza ni de aseguradora.
        // Puede que ni siquiera termine siendo un siniestro; el objetivo es que
        // quede el registro de lo que paso.
        setVal('prc-sini-id', nroSiniestroFinal);
        setVal('prc-fecha-den', hoyAR());
        setVal('prc-fecha', fechaAR(valRaw('rc_fecha')));
        setVal('prc-hora', valRaw('rc_hora'));
        setVal('prc-calle', val('rc_calle'));
        setVal('prc-localidad', val('rc_localidad'));
        setVal('prc-provincia', val('rc_provincia'));
        setVal('prc-emp-nom', val('rc_nombre_chofer'));
        setVal('prc-emp-dni', val('rc_dni_chofer'));
        setVal('prc-emp-op', choferRC
            ? `${choferRC.op || ''}${choferRC.legajo ? ' / ' + choferRC.legajo : ''}` : '');
        setVal('prc-tel', val('rc_tel_contacto'));
        setVal('prc-mail', valRaw('rc_mail_contacto'));
        setVal('prc-danos', val('rc_danos'));
        setVal('prc-relato', valRaw('rc_relato'));
        const etiquetasAut = { NO: 'No intervino', POLICIA: 'Policía',
                               BOMBEROS: 'Bomberos', AMBOS: 'Policía y bomberos' };
        setVal('prc-autoridad', etiquetasAut[val('rc_autoridad')] || val('rc_autoridad'));

        const dam = document.getElementById('prc-damnificado');
        if (dam) {
            const n = val('rc_terc_nombre'), d = val('rc_terc_doc');
            const t = val('rc_terc_tel'),    b = val('rc_terc_bien');
            const dm = val('rc_terc_dom');
            dam.innerHTML = (n || d || t || b || dm)
                ? `<div><b>Nombre / Razón social:</b> ${n || '—'}</div>
                   <div style="display:grid; grid-template-columns:1fr 1fr;">
                     <div><b>DNI / CUIT:</b> ${d || '—'}</div>
                     <div><b>Teléfono:</b> ${t || '—'}</div>
                   </div>
                   <div><b>Domicilio:</b> ${dm || '—'}</div>
                   <div><b>Bien dañado:</b> ${b || '—'}</div>`
                : '<span style="color:#666;">No se registraron datos del damnificado al momento de la denuncia.</span>';
        }

        const contF = document.getElementById('prc-lista-fotos');
        if (contF) {
            contF.innerHTML = links.length
                ? links.map(l => `<a href="${l.url}" target="_blank" style="text-decoration:none; color:#444; margin-right:15px;">• ${l.label}</a>`).join(' ')
                : '<span style="color:#888;">Sin fotos adjuntas.</span>';
        }

        // 5. Generar y subir el PDF
        await new Promise(r => setTimeout(r, 1000));
        const opt = {
            margin: 0,
            filename: `Denuncia_RC_${nroSiniestroFinal}.pdf`,
            html2canvas: { scale: 2, useCORS: true, scrollY: 0 },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };
        const pdfBlob = await html2pdf().set(opt)
            .from(document.getElementById('pdf-template-rc')).output('blob');
        if (!pdfBlob || pdfBlob.size === 0) throw new Error("El PDF salió vacío. Contactar administración.");

        let pdfOk = false, ultimoError = '', linkPdfFinalReal = linkFinal;
        for (let intento = 0; intento < 3 && !pdfOk; intento++) {
            const pathIntento = (intento === 0)
                ? pdfPath : `${folder}/Denuncia_RV_r${intento}_${tokenArchivo()}.pdf`;
            try {
                const resPdfUp = await fetch(`${URL_API}/storage/v1/object/denuncias/${pathIntento}`, {
                    method: 'POST',
                    headers: sbHeaders({ 'Content-Type': 'application/pdf' }),
                    body: pdfBlob
                });
                if (resPdfUp.ok) {
                    pdfOk = true;
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
        if (!pdfOk) throw new Error("Se cargó la denuncia pero falló al subir el PDF (" + ultimoError + ").");

        // 6. Guardar el link. Si falla, corta: no se anuncia exito con el PDF suelto.
        const cierreRC = await rpc('finalizar_denuncia', {
            p_id: idDenuncia, p_patente: '',
            p_link_pdf: linkPdfFinalReal, p_croquis_url: ''
        });
        if (!cierreRC || !cierreRC.success) {
            throw new Error("El PDF se generó pero no quedó vinculado al registro "
                + nroSiniestroFinal + ". Reintentá.");
        }

        // 7. Mail
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
            // OJO: no decir "daño a terceros" a secas, que es como se llama la
            // denuncia normal de camion. Esta es la de Riesgos Varios.
            asunto: "Denuncia Riesgos Varios - " + nroSiniestroFinal
                    + " - " + val('rc_nombre_chofer'),
            link_pdf: linkPdfFinalReal,
            link: linkPdfFinalReal,
            dominio: 'SIN VEHICULO',
            nro_siniestro: nroSiniestroFinal,
            tipo_envio: 'RC'
        });

        reiniciarEnvio();
        ofrecerDescargaPDF(pdfBlob, `Riesgos_Varios_${nroSiniestroFinal}.pdf`);
        showStatus(`¡ÉXITO! Registro ${nroSiniestroFinal} generado.`, "success");
        mostrarVolverAlInicio();

    } catch (e) {
        congelarFormulario('pantalla-formulario-rc', false);
        const yaCreada = envioEnCurso && envioEnCurso.id;
        showStatus(yaCreada
            ? `El registro ${envioEnCurso.nro} YA quedó guardado, pero falló un paso posterior: `
              + e.message + ' Podés reintentar: se retoma el mismo registro.'
            : "ERROR: " + e.message + ' El registro NO se guardó.', "error");
        btn.innerText = yaCreada ? "Reintentar envío" : "Finalizar Denuncia";
        btn.disabled = false;
    }
}

// Volver desde un flujo (externo/interno) al selector inicial sin recargar la pagina.
function volverASelector() {
    limpiarStatus();
    document.getElementById('pantalla-formulario').classList.add('hidden');
    document.getElementById('pantalla-formulario-interno').classList.add('hidden');
    document.getElementById('pantalla-tipo-siniestro').classList.remove('hidden');
}

async function enviarSiniestroInterno() {
    const btn = document.getElementById('btn-finalizar-int');
    btn.innerText = "Enviando..."; btn.disabled = true;
    congelarFormulario('pantalla-formulario-interno', true);
    const val = (id) => {
        const el = document.getElementById(id);
        return el ? el.value.trim().toUpperCase() : "";
    };
    const valRaw = (id) => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : "";
    };

    try {
        // ---- 1. Crear la constancia PRIMERO para tener el numero ----
        // Aprovechamos los campos existentes:
        //   patente_tercero -> dominio de la 2da unidad (si el daño fue contra otra unidad)
        //   marca_tercero   -> modelo de esa unidad
        //   bien_afectado   -> descripcion del bien, si fue contra algo de la empresa
        const payload = {
            fecha_hecho: valRaw('i_fecha'),
            hora_hecho: valRaw('i_hora'),
            nombre_chofer: val('i_nombre_chofer'),
            dni_chofer: val('i_dni_chofer'),
            tel_chofer: val('i_tel_chofer'),
            relato: valRaw('i_relato'),
            patente_tercero: val('i_patente2'),
            marca_tercero: (unidad2 && unidad2.MODELO) ? unidad2.MODELO : '',
            calle_interseccion: valRaw('i_lugar'),
            dominio_asegurado: unidad.DOMINIO,
            tipo_siniestro: 'INTERNO',
            tipo_afectado: val('i_tipo_afectado') || 'UNIDAD',
            bien_afectado: valRaw('i_bien_afectado'),
            legajo_chofer: (choferInterno && choferInterno.legajo) || '',
            op_chofer: (choferInterno && choferInterno.op) || '',
            // Se guarda el numero normalizado, no lo que se vio en pantalla
            presupuesto_monto: (() => {
                const n = parseMontoAR(valRaw('i_presup_monto'));
                return n === null ? '' : String(n);
            })(),
            presupuesto_tipo: val('i_presup_tipo')
        };

        const previo = envioReanudable('INTERNO');
        let idDenuncia;
        if (previo) {
            idDenuncia = previo.id;
            nroSiniestroFinal = previo.nro;
        } else {
            const resultado = await rpc('crear_denuncia', { p_payload: payload });
            if (!resultado || !resultado.success) {
                throw new Error("Fallo al crear constancia en la base.");
            }
            nroSiniestroFinal = resultado.nro_siniestro;
            idDenuncia = resultado.id;
            envioEnCurso = { flujo: 'INTERNO', id: idDenuncia, nro: nroSiniestroFinal };
        }

        // ---- 2. Carpeta con el numero de constancia ----
        const folder = `${unidad.DOMINIO}_${nroSiniestroFinal}`;
        const pdfPath = `${folder}/Constancia_Interna_${tokenArchivo()}.pdf`;
        const linkFinal = `${URL_API}/storage/v1/object/public/denuncias/${pdfPath}`;

        // ---- 3. Subir fotos. En un reintento no se vuelven a subir. ----
        const links = envioEnCurso.fotos || [];
        const files = envioEnCurso.fotos ? [] : document.getElementById('i_fotos').files;
        for (let i = 0; i < files.length; i++) {
            const blob = await comprimirImagen(files[i]);
            const path = `${folder}/interno_${i}_${tokenArchivo()}.${extensionDe(blob)}`;
            btn.innerText = "Subiendo fotos...";
            const resUp = await fetch(`${URL_API}/storage/v1/object/denuncias/${path}`, {
                method: 'POST',
                headers: sbHeaders({ 'Content-Type': blob.type || 'image/jpeg' }),
                body: blob
            });
            if (!resUp.ok) throw new Error("Error al subir foto " + (i + 1));
            links.push({
                url: `${URL_API}/storage/v1/object/public/denuncias/${path}`,
                label: `foto_${i + 1}`
            });
        }
        envioEnCurso.fotos = links;
        btn.innerText = "Enviando...";

        // ---- 4. Llenar template PDF interno ----
        setVal('pi-sini-id', nroSiniestroFinal);
        setVal('pi-fecha-den', hoyAR());
        setVal('pi-fecha', fechaAR(valRaw('i_fecha')));
        setVal('pi-hora', valRaw('i_hora'));
        setVal('pi-lugar', valRaw('i_lugar'));
        setVal('pi-c-nom', val('i_nombre_chofer'));
        setVal('pi-c-dni', val('i_dni_chofer'));
        setVal('pi-c-tel', val('i_tel_chofer'));

        setVal('pi-v1-do', unidad.DOMINIO);
        if ((val('i_tipo_afectado') || 'UNIDAD') === 'BIEN') {
            setVal('pi-v2-label', 'Bien de la empresa afectado:');
            setVal('pi-v2-do', valRaw('i_bien_afectado'));
        } else {
            setVal('pi-v2-label', 'Parte embestida:');
            setVal('pi-v2-do', (unidad2 && unidad2.DOMINIO) || val('i_patente2'));
        }
        setVal('pi-poliza', unidad.POLIZA || '');

        setVal('pi-relato', valRaw('i_relato'));

        const tipoP = val('i_presup_tipo');
        const tipoLabel = tipoP === 'DEFINITIVO' ? 'Definitivo'
            : tipoP === 'ESTIMADO' ? 'Estimado'
            : 'A presupuestar';
        setVal('pi-presup-tipo', tipoLabel);
        const montoN = parseMontoAR(valRaw('i_presup_monto'));
        setVal('pi-presup-monto', montoN === null ? '—' : '$ ' + formatMontoAR(montoN));

        const cont = document.getElementById('pi-lista-fotos');
        if (cont) {
            cont.innerHTML = links.length
                ? links.map(l => `<a href="${l.url}" target="_blank" style="text-decoration:none; color:#444; margin-right:15px;">• ${l.label}</a>`).join(' ')
                : '<span style="color:#888;">Sin fotos adjuntas.</span>';
        }

        // ---- 5. Generar y subir PDF (1 carilla) ----
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
                : `${folder}/Constancia_Interna_r${intento}_${tokenArchivo()}.pdf`;
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
        // ---- 6. Guardar el link del PDF en la constancia ----
        const cierreInt = await rpc('finalizar_denuncia', {
            p_id: idDenuncia,
            p_patente: unidad.DOMINIO,
            p_link_pdf: linkPdfFinalReal,
            p_croquis_url: ''
        });
        if (!cierreInt || !cierreInt.success) {
            throw new Error("El PDF se generó pero no quedó vinculado a la constancia "
                + nroSiniestroFinal + ". Reintentá.");
        }

        // ---- 7. Enviar mail con asunto distinto ----
        const contraQue = (val('i_tipo_afectado') || 'UNIDAD') === 'BIEN'
            ? valRaw('i_bien_afectado')
            : val('i_patente2');
        const asuntoMail = "Constancia Interna - " + nroSiniestroFinal
            + " - " + unidad.DOMINIO + " vs " + contraQue;
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

        reiniciarEnvio();
        ofrecerDescargaPDF(pdfBlob, `Constancia_${nroSiniestroFinal}_${unidad.DOMINIO}.pdf`);
        showStatus(`¡ÉXITO! Constancia interna ${nroSiniestroFinal} generada.`, "success");
        mostrarVolverAlInicio();
    } catch (e) {
        congelarFormulario('pantalla-formulario-interno', false);
        const yaCreada = envioEnCurso && envioEnCurso.id;
        showStatus(yaCreada
            ? `La constancia ${envioEnCurso.nro} YA quedó guardada, pero falló un paso posterior: `
              + e.message + ' Podés reintentar: se retoma la misma constancia.'
            : "ERROR: " + e.message + ' La constancia NO se guardó.', "error");
        btn.disabled = false;
        btn.innerText = yaCreada ? "Reintentar envío" : "Finalizar Constancia";
    }
}
