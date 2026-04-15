const URL_API = "https://ojsjxyxvcznoydhzhsrt.supabase.co";
const KEY_API = "sb_publishable__4dVId8Vbc2lsHIZrhzoMA_sRnfpxuh";
const EMAIL_DESTINO = "mbenitez@barsat.com.ar";
const EMAILJS_SERVICE_ID = "service_snce9ja";
const EMAILJS_TEMPLATE_ID = "template_66ehu6p";
const EMAILJS_PUBLIC_KEY = "uYFGRrX_AbRYotS_Q";

let datosVehiculoValidado = {}; // Guardaremos dominio, marca, modelo, poliza, motor, chasis

window.onload = function() {
    const today = new Date().toISOString().split('T')[0];
    const fInput = document.getElementById('fecha_hecho');
    if(fInput) fInput.setAttribute('max', today); // Bloqueo fecha futura
    emailjs.init(EMAILJS_PUBLIC_KEY);
    
    // Lógica para mostrar/ocultar propietario tercero
    document.getElementById('conductor_es_propietario').addEventListener('change', function() {
        const divPropietario = document.getElementById('datos_propietario_tercero');
        const inputs = divPropietario.querySelectorAll('input');
        if (this.value === 'NO') {
            divPropietario.classList.remove('hidden');
            inputs.forEach(i => i.setAttribute('required', ''));
        } else {
            divPropietario.classList.add('hidden');
            inputs.forEach(i => i.removeAttribute('required'));
        }
    });
};

// 1. VALIDACIÓN UNIDAD (SUPABASE Camiones)
document.getElementById('form-validacion').addEventListener('submit', async (e) => {
    e.preventDefault();
    const patente = document.getElementById('patente').value.trim().toUpperCase();
    const chasis = document.getElementById('chasis').value.trim();
    
    // CAPTURAMOS TODOS LOS DATOS: Dominio, Marca, Modelo, Poliza, Motor, Chasis
    const res = await fetch(`${URL_API}/rest/v1/Camiones?DOMINIO=eq.${patente}&CHASIS=like.*${chasis}`, {
        headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}` }
    });
    const datos = await res.json();
    
    if (datos.length > 0) {
        datosVehiculoValidado = {
            dom: datos[0].DOMINIO,
            mm: `${datos[0].MARCA} ${datos[0].MODELO}`,
            pol: datos[0].NUMERO_POLIZA || "NO INFORMA",
            mot: datos[0].N_MOTOR || "NO INFORMA",
            cha: datos[0].N_CHASIS || "NO INFORMA"
        };
        document.getElementById('pantalla-validacion').classList.add('hidden');
        document.getElementById('pantalla-formulario').classList.remove('hidden');
    } else { document.getElementById('mensaje-error').innerText = "Unidad no encontrada en base de datos."; }
});

// NAVEGACIÓN Y TÍTULOS DE PASOS
const titulosPasos = [
    "", // Paso 0 no usado
    "Paso 1: Hecho",
    "Paso 2: Conductor Asegurado",
    "Paso 3: Detalles y Relato (Nuestros)",
    "Paso 4: Tercero y Daños (Otros)",
    "Paso 5: Fotos"
];

function cambiarPaso(paso) {
    document.querySelectorAll('.step').forEach(s => s.classList.add('hidden'));
    document.getElementById(`step-${paso}`).classList.remove('hidden');
    document.getElementById('progress').style.width = (paso * 16.6) + "%";
    document.getElementById('titulo-paso').innerText = titulosPasos[paso]; // Actualiza el título arriba
    window.scrollTo(0,0);
}

function validarYPasar(proximoPaso) {
    const currentStep = document.getElementById(`step-${proximoPaso - 1}`);
    const inputs = currentStep.querySelectorAll('[required]');
    let valido = true;
    inputs.forEach(i => {
        if(!i.value || !i.checkValidity()) { i.style.borderColor = "red"; valido = false; } 
        else { i.style.borderColor = "#ddd"; }
    });
    if(valido) cambiarPaso(proximoPaso);
    else alert("Campos obligatorios incompletos o DNI inválido.");
}

// 2. ENVÍO FINAL
async function enviarSiniestro() {
    const btn = document.getElementById('btn-finalizar');
    const inputFotos = document.getElementById('input-fotos');
    if(inputFotos.files.length === 0) return alert("Debe subir al menos una foto del siniestro.");

    btn.innerText = "Cargando Denuncia..."; btn.disabled = true;

    const timestamp = Date.now();
    const folder = `${datosVehiculoValidado.dom}_${timestamp}`;
    const val = (id) => document.getElementById(id).value.trim() || "NO INFORMA";

    try {
        // A. SUBIR FOTOS
        const linksFotos = [];
        for (let i = 0; i < inputFotos.files.length; i++) {
            const file = inputFotos.files[i];
            const path = `${folder}/foto_${i}.jpg`;
            await fetch(`${URL_API}/storage/v1/object/denuncias/${path}`, {
                method: 'POST',
                headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': file.type },
                body: file
            });
            linksFotos.push(`${URL_API}/storage/v1/object/public/denuncias/${path}`);
        }

        // B. POBLAR PDF PROFESIONAL (3 HOJAS)
        document.getElementById('p-sini-id').innerText = timestamp;
        
        // Hoja 1
        document.getElementById('p-fecha').innerText = val('fecha_hecho');
        document.getElementById('p-hora').innerText = val('hora_hecho');
        document.getElementById('p-localidad').innerText = val('localidad');
        document.getElementById('p-provincia').innerText = val('provincia');
        document.getElementById('p-cp').innerText = val('cp');
        document.getElementById('p-calle').innerText = val('calle');
        
        document.getElementById('p-c-nom').innerText = val('nombre_chofer');
        document.getElementById('p-c-dni').innerText = val('dni_chofer');
        document.getElementById('p-c-dom').innerText = `${val('calle_chofer')}, ${val('localidad_chofer')}, ${val('provincia_chofer')}`;
        document.getElementById('p-c-tel').innerText = val('tel_chofer');

        // Datos automáticos de Supabase
        document.getElementById('p-v-dom').innerText = datosVehiculoValidado.dom;
        document.getElementById('p-v-mm').innerText = datosVehiculoValidado.mm;
        document.getElementById('p-v-pol').innerText = datosVehiculoValidado.pol;
        document.getElementById('p-v-mot').innerText = datosVehiculoValidado.mot;
        document.getElementById('p-v-cha').innerText = datosVehiculoValidado.cha;
        document.getElementById('p-v-dan').innerText = val('danos_propios');

        // Hoja 2 (Tercero)
        document.getElementById('p-t-dom').innerText = val('patente_tercero');
        document.getElementById('p-t-mm').innerText = val('marca_tercero');
        document.getElementById('p-t-seg').innerText = val('seguro_tercero');
        document.getElementById('p-t-pol').innerText = val('poliza_tercero');
        document.getElementById('p-t-dan').innerText = val('danos_tercero');
        
        if (document.getElementById('conductor_es_propietario').value === 'SI') {
            document.getElementById('p-t-p-nom').innerText = "(Es el conductor)";
            document.getElementById('p-t-p-doc').innerText = "--";
            document.getElementById('p-t-p-tel').innerText = "--";
        } else {
            document.getElementById('p-t-p-nom').innerText = val('nombre_propietario');
            document.getElementById('p-t-p-doc').innerText = val('dni_propietario');
            document.getElementById('p-t-p-tel').innerText = val('tel_propietario');
        }

        // Hoja 3
        document.getElementById('p-relato').innerText = val('descripcion');
        document.getElementById('p-lista-fotos').innerHTML = linksFotos.map((l, index) => `<p>Link Foto ${index + 1}: ${l}</p>`).join('');

        // C. GENERAR PDF (Espera delay render)
        await new Promise(r => setTimeout(r, 600));
        const element = document.getElementById('pdf-template');
        const pdfBlob = await html2pdf().set({ 
            margin: 0.5, 
            html2canvas: { scale: 2, useCORS: true },
            jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
        }).from(element).output('blob');

        // D. SUBIR PDF A STORAGE
        const pdfPath = `${folder}/Denuncia_Oficial.pdf`;
        await fetch(`${URL_API}/storage/v1/object/denuncias/${pdfPath}`, {
            method: 'POST',
            headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': 'application/pdf' },
            body: pdfBlob
        });

        const finalLink = `${URL_API}/storage/v1/object/public/denuncias/${pdfPath}`;
        
        // E. GUARDAR EN TABLA Y MANDAR MAIL
        // OJO: Asegurate de que la tabla 'Siniestros' tenga todas estas nuevas columnas
        const dataFinal = { 
            dominio_nuestro: datosVehiculoValidado.dom, 
            nombre_conductor: val('nombre_chofer'), 
            link_pdf: finalLink,
            fecha_hecho: val('fecha_hecho'),
            patente_tercero: val('patente_tercero'),
            seguro_tercero: val('seguro_tercero'),
            descripcion_relato: val('descripcion')
        };

        await fetch(`${URL_API}/rest/v1/Siniestros`, {
            method: 'POST',
            headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(dataFinal)
        });

        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, dataFinal);
        
        alert("Denuncia Administrativa cargada exitosamente. PDF generado.");
        location.reload();

    } catch (e) { alert("Error crítico al procesar. Revisa los permisos de Supabase Storage."); btn.disabled = false; }
}