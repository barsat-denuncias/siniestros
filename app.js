const URL_API = "https://ojsjxyxvcznoydhzhsrt.supabase.co";
const KEY_API = "sb_publishable__4dVId8Vbc2lsHIZrhzoMA_sRnfpxuh";
const EMAILJS_SERVICE_ID = "service_snce9ja";
const EMAILJS_TEMPLATE_ID = "template_66ehu6p";
const EMAILJS_PUBLIC_KEY = "uYFGRrX_AbRYotS_Q";

let unidad = {};

// Validación Blindada Inteligente
function aplicarValidacionEstricta(id) {
    const input = document.getElementById(id);
    input.addEventListener('input', () => {
        let val = input.value.toUpperCase();
        if (!"NO INFORMA".startsWith(val)) {
            input.value = val.replace(/[^0-9]/g, '');
        } else {
            input.value = val;
        }
    });

    input.addEventListener('blur', () => {
        let val = input.value.toUpperCase();
        if (val !== "" && val !== "NO INFORMA" && isNaN(val.replace(/\s/g,''))) {
            input.value = "";
            input.style.borderColor = "red";
        } else {
            input.style.borderColor = "#ddd";
        }
    });
}

window.onload = function() {
    const hoy = new Date().toISOString().split('T')[0];
    document.getElementById('fecha_hecho').setAttribute('max', hoy);
    emailjs.init(EMAILJS_PUBLIC_KEY);
    ['dni_chofer', 'tel_chofer', 'prop_dni', 'prop_tel', 'cp'].forEach(aplicarValidacionEstricta);

    document.getElementById('es_propietario').addEventListener('change', function() {
        document.getElementById('datos_propietario').classList.toggle('hidden', this.value === 'SI');
    });
};

document.getElementById('form-validacion').addEventListener('submit', async (e) => {
    e.preventDefault();
    const patente = document.getElementById('patente').value.trim().toUpperCase();
    const chasis = document.getElementById('chasis_val').value.trim();
    const res = await fetch(`${URL_API}/rest/v1/Camiones?DOMINIO=eq.${patente}&CHASIS=like.*${chasis}`, {
        headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}` }
    });
    const datos = await res.json();
    if (datos.length > 0) {
        unidad = datos[0]; 
        document.getElementById('pantalla-validacion').classList.add('hidden');
        document.getElementById('pantalla-formulario').classList.remove('hidden');
    } else { document.getElementById('mensaje-error').innerText = "Unidad no encontrada."; }
});

const titulos = ["", "Paso 1: El Hecho", "Paso 2: Conductor", "Paso 3: Daños y Relato", "Paso 4: El Tercero", "Paso 5: Fotos"];

function cambiarPaso(paso) {
    document.querySelectorAll('.step').forEach(s => s.classList.add('hidden'));
    document.getElementById(`step-${paso}`).classList.remove('hidden');
    document.getElementById('progress').style.width = (paso * 20) + "%";
    document.getElementById('titulo-paso').innerText = titulos[paso];
    
    const msg = document.getElementById('msg-obligatorio');
    if (paso === 5) msg.style.display = 'none';
    else msg.style.display = 'block';

    window.scrollTo(0,0);
}

function validarYPasar(proximoPaso) {
    const inputs = document.getElementById(`step-${proximoPaso - 1}`).querySelectorAll('[required]');
    let valido = true;
    inputs.forEach(i => {
        if(!i.checkValidity()){ i.style.borderColor = "red"; valido = false; } 
        else { i.style.borderColor = "#ddd"; }
    });
    if(valido) cambiarPaso(proximoPaso);
}

async function enviarSiniestro() {
    const btn = document.getElementById('btn-finalizar');
    btn.innerText = "Procesando Denuncia..."; btn.disabled = true;
    const ts = Date.now();
    const folder = `${unidad.DOMINIO}_${ts}`;
    const val = (id) => document.getElementById(id).value.trim().toUpperCase() || "NO INFORMA";

    try {
        const cats = ['propios', 'tercero', 'doc_cond', 'doc_terc', 'otros'];
        const links = [];
        for (const c of cats) {
            const f = document.getElementById(`f_${c}`).files;
            for (let i = 0; i < f.length; i++) {
                const path = `${folder}/${c}_${i}.jpg`;
                await fetch(`${URL_API}/storage/v1/object/denuncias/${path}`, {
                    method: 'POST',
                    headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': f[i].type },
                    body: f[i]
                });
                links.push(`${URL_API}/storage/v1/object/public/denuncias/${path}`);
            }
        }

        // POBLAR PDF LIMPIO (SIN DATOS FIJOS)
        document.getElementById('p-sini-id').innerText = ts.toString().slice(-6);
        document.getElementById('p-v-aseg').innerText = ""; // Aseguradora vacía por ahora
        document.getElementById('p-v-pol').innerText = ""; // Póliza vacía por ahora
        
        document.getElementById('p-fecha').innerText = val('fecha_hecho');
        document.getElementById('p-hora').innerText = val('hora_hecho');
        document.getElementById('p-fecha-den').innerText = new Date().toLocaleDateString();
        document.getElementById('p-cp').innerText = val('cp');
        document.getElementById('p-prov').innerText = val('provincia');
        document.getElementById('p-loc').innerText = val('localidad');
        document.getElementById('p-calle').innerText = val('calle');
        document.getElementById('p-int').innerText = val('interseccion');
        document.getElementById('p-c-nom').innerText = val('nombre_chofer');
        document.getElementById('p-c-dni').innerText = val('dni_chofer');
        document.getElementById('p-c-tel').innerText = val('tel_chofer');
        document.getElementById('p-c-dom').innerText = `${val('domicilio_chofer')}, ${val('loc_chofer')}, ${val('prov_chofer')}`;
        
        // Datos del Asegurado vacíos (Sección 4)
        document.getElementById('p-aseg-razon').innerText = ""; 
        document.getElementById('p-aseg-cuit').innerText = "";
        document.getElementById('p-aseg-tel').innerText = "";
        document.getElementById('p-aseg-dom').innerText = "";
        document.getElementById('p-aseg-cp').innerText = "";

        document.getElementById('p-v-do').innerText = unidad.DOMINIO;
        document.getElementById('p-v-ma').innerText = unidad.MODELO || "";
        document.getElementById('p-v-mo').innerText = unidad.MODELO;
        document.getElementById('p-v-ti').innerText = unidad.VEHICULO;
        document.getElementById('p-v-cha').innerText = unidad.CHASIS;
        document.getElementById('p-v-dan').innerText = val('danos_propios');
        
        document.getElementById('p-t-do').innerText = val('patente_tercero');
        document.getElementById('p-t-ma').innerText = val('marca_tercero');
        document.getElementById('p-t-mo').innerText = val('marca_tercero');
        document.getElementById('p-t-se').innerText = val('seguro_tercero');
        document.getElementById('p-t-po').innerText = val('poliza_tercero');
        document.getElementById('p-t-dan').innerText = val('danos_tercero');

        if(document.getElementById('es_propietario').value === 'NO'){
            document.getElementById('p-t-p-no').innerText = val('prop_nombre');
            document.getElementById('p-t-p-dn').innerText = val('prop_dni');
            document.getElementById('p-t-p-te').innerText = val('prop_tel');
        } else { document.getElementById('p-t-p-no').innerText = val('nombre_chofer'); }

        document.getElementById('p-relato').innerText = val('descripcion');
        document.getElementById('p-lista-fotos').innerHTML = links.map(l => `<p>${l}</p>`).join('');

        await new Promise(r => setTimeout(r, 1200)); 
        
        const opt = {
            margin: 0,
            filename: `Denuncia_${unidad.DOMINIO}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, scrollY: 0 },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };

        const pdfBlob = await html2pdf().set(opt).from(document.getElementById('pdf-template')).output('blob');

        const pdfPath = `${folder}/Denuncia_Barsat_Final.pdf`;
        await fetch(`${URL_API}/storage/v1/object/denuncias/${pdfPath}`, {
            method: 'POST', headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': 'application/pdf' }, body: pdfBlob
        });

        const linkFinal = `${URL_API}/storage/v1/object/public/denuncias/${pdfPath}`;
        await fetch(`${URL_API}/rest/v1/Siniestros`, {
            method: 'POST', headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fecha_hecho: val('fecha_hecho'), nombre_chofer: val('nombre_chofer'), link_pdf: linkFinal, dominio_nuestro: unidad.DOMINIO })
        });

        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, { link_pdf: linkFinal, dominio: unidad.DOMINIO });
        alert("¡ÉXITO! Denuncia cargada correctamente.");
        location.reload();
    } catch (e) { alert("Error crítico: " + e.message); btn.disabled = false; btn.innerText = "Finalizar Denuncia"; }
}