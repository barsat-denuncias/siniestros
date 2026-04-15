// CONFIGURACIÓN DE APIS
const URL_API = "https://ojsjxyxvcznoydhzhsrt.supabase.co";
const KEY_API = "sb_publishable__4dVId8Vbc2lsHIZrhzoMA_sRnfpxuh";
const EMAIL_DESTINO = "mbenitez@barsat.com.ar";
const EMAILJS_SERVICE_ID = "service_snce9ja";
const EMAILJS_TEMPLATE_ID = "template_66ehu6p";
const EMAILJS_PUBLIC_KEY = "uYFGRrX_AbRYotS_Q";

let dominioValidado = "";

// INICIALIZACIÓN
window.onload = function() {
    const today = new Date().toISOString().split('T')[0];
    const fInput = document.getElementById('fecha_hecho');
    if(fInput) fInput.setAttribute('max', today);
    emailjs.init(EMAILJS_PUBLIC_KEY);
};

// 1. PANTALLA DE VALIDACIÓN
document.getElementById('form-validacion').addEventListener('submit', async (e) => {
    e.preventDefault();
    const patente = document.getElementById('patente').value.trim().toUpperCase();
    const chasis = document.getElementById('chasis').value.trim();
    
    const res = await fetch(`${URL_API}/rest/v1/Camiones?DOMINIO=eq.${patente}&CHASIS=like.*${chasis}`, {
        headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}` }
    });
    const datos = await res.json();
    
    if (datos.length > 0) {
        dominioValidado = datos[0].DOMINIO;
        document.getElementById('pantalla-validacion').classList.add('hidden');
        document.getElementById('pantalla-formulario').classList.remove('hidden');
    } else {
        document.getElementById('mensaje-error').innerText = "Vehículo no encontrado.";
    }
});

// NAVEGACIÓN ENTRE PASOS
function cambiarPaso(paso) {
    document.querySelectorAll('.step').forEach(s => s.classList.add('hidden'));
    document.getElementById(`step-${paso}`).classList.remove('hidden');
    document.getElementById('progress').style.width = (paso * 20) + "%";
}

function validarYPasar(proximoPaso) {
    const currentStep = document.getElementById(`step-${proximoPaso - 1}`);
    const inputs = currentStep.querySelectorAll('[required]');
    let valido = true;
    
    inputs.forEach(i => {
        if(!i.value || !i.checkValidity()) {
            i.style.borderColor = "red";
            valido = false;
        } else {
            i.style.borderColor = "#ddd";
        }
    });
    
    if(valido) cambiarPaso(proximoPaso);
    else alert("Campos obligatorios incompletos o inválidos.");
}

// 2. FUNCIÓN PRINCIPAL DE ENVÍO
async function enviarSiniestro() {
    const btn = document.getElementById('btn-finalizar');
    const inputFotos = document.getElementById('input-fotos');
    
    if(inputFotos.files.length === 0) return alert("Debe subir al menos una foto.");

    btn.innerText = "Cargando... No cierre la app";
    btn.disabled = true;

    const timestamp = Date.now();
    const folder = `${dominioValidado}_${timestamp}`;
    const val = (id) => document.getElementById(id).value.trim() || "NO INFORMA";

    try {
        // A. SUBIR FOTOS A SUPABASE STORAGE
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

        // B. LLENAR MODELO PDF
        document.getElementById('p-sini-id').innerText = timestamp;
        document.getElementById('p-fecha').innerText = val('fecha_hecho');
        document.getElementById('p-hora').innerText = val('hora_hecho');
        document.getElementById('p-lugar').innerText = `${val('calle')}, ${val('localidad')}, ${val('provincia')}`;
        document.getElementById('p-c-nom').innerText = val('nombre_chofer');
        document.getElementById('p-c-dni').innerText = val('dni_chofer');
        document.getElementById('p-c-tel').innerText = val('tel_chofer');
        document.getElementById('p-v-dom').innerText = dominioValidado;
        document.getElementById('p-v-mm').innerText = val('marca_vehiculo');
        document.getElementById('p-v-dan').innerText = val('danos_propios');
        document.getElementById('p-relato').innerText = val('descripcion');
        document.getElementById('p-lista-fotos').innerHTML = linksFotos.map(l => `<p>${l}</p>`).join('');

        // C. GENERAR PDF
        await new Promise(r => setTimeout(r, 600)); // Delay para asegurar renderizado
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

        // E. GUARDAR DATOS EN TABLA Y MANDAR MAIL
        const finalLink = `${URL_API}/storage/v1/object/public/denuncias/${pdfPath}`;
        const finalData = {
            dominio_nuestro: dominioValidado,
            nombre_conductor: val('nombre_chofer'),
            link_pdf: finalLink,
            fecha_hecho: val('fecha_hecho')
        };

        await fetch(`${URL_API}/rest/v1/Siniestros`, {
            method: 'POST',
            headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(finalData)
        });

        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, finalData);
        
        alert("¡Éxito! Denuncia cargada correctamente.");
        location.reload();

    } catch (e) {
        alert("Error crítico al procesar la denuncia.");
        btn.disabled = false;
        btn.innerText = "Cargar Denuncia";
    }
}